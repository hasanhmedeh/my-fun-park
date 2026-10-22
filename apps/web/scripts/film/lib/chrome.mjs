// A small Chrome DevTools Protocol client for filming the game: headless Chrome with the GPU on, one
// page, and the handful of calls the film scripts need (evaluate, init scripts, screenshots, network
// stubs). Node 22+ only: it talks to Chrome over Node's global WebSocket and fetch, so it needs no
// dependencies (no Puppeteer, no Playwright).
//
//   const page = await launch({ width: 1920, height: 1080 });
//   await page.addInitScript(CLOCK_SCRIPT);
//   await page.goto('http://localhost:5199/?quality=high');
//   const png = await page.screenshot();
//   await page.close();

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROMES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

/** The profiles this module makes in the temp folder start with this (old ones are swept on launch). */
const PROFILE_PREFIX = 'film-';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts headless Chrome on the real GPU (ANGLE over D3D11 on Windows; the GPU blocklist ignored, as
 * the game's own scripts/shot.mjs does) and opens one page at `width` × `height` CSS pixels, drawn
 * at `scale` device pixels per CSS pixel. `log` gets the page's console errors and exceptions.
 */
export async function launch({ width = 1920, height = 1080, scale = 1, log = (line) => console.log(line), flags = [] } = {}) {
  const chromePath = CHROMES.find((p) => p && existsSync(p));
  if (!chromePath) throw new Error('Chrome not found (set CHROME)');
  sweepProfiles();
  const profile = mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
  const proc = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--ignore-gpu-blocklist',
      '--enable-gpu',
      '--use-angle=d3d11',
      '--enable-unsafe-swiftshader',
      // a hidden page still draws every frame it's asked for
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      ...flags,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  // Chrome writes the port it picked into the profile
  let port = null;
  for (let i = 0; i < 300 && !port; i++) {
    await sleep(100);
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    } catch {
      /* not yet */
    }
  }
  if (!port) {
    proc.kill();
    throw new Error('Chrome did not start');
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const page = new Page(ws, proc, profile, log, port);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.setViewport({ width, height, scale });
  return page;
}

/** Profiles left behind by runs that were killed (each is tens of MB). */
function sweepProfiles() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const dir = join(tmpdir(), name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > 30 * 60_000) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* in use */
    }
  }
}

export class Page {
  #ws;
  #proc;
  #profile;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;
  #port;
  width = 0;
  height = 0;
  scale = 1;

  constructor(ws, proc, profile, log, port) {
    this.#port = port;
    this.#ws = ws;
    this.#proc = proc;
    this.#profile = profile;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.#pending.has(msg.id)) {
        const { resolve, reject, method } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning'))
        log(`[page ${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 1500)}`);
      else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        log(`[page exception] ${(d.exception?.description ?? d.text).slice(0, 1500)}`);
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
    };
    ws.onclose = () => {
      for (const { reject, method } of this.#pending.values()) reject(new Error(`${method}: the connection to Chrome closed`));
      this.#pending.clear();
    };
  }

  /** One raw CDP call; resolves with its result, rejects with its error. */
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new Error(`${method}: the page is closed`));
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Calls fn with each event's params (e.g. 'Fetch.requestPaused'); returns a function that stops it. */
  on(method, fn) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
    return () => list.splice(list.indexOf(fn) >>> 0, 1);
  }

  /**
   * Runs `expression` in the page (awaiting a promise it returns) and gives back its value, which
   * must be JSON-able. A function is called with `args` (also JSON-able). Throws what the page threw.
   */
  async evaluate(expression, ...args) {
    const source = typeof expression === 'function' ? `(${expression})(...${JSON.stringify(args)})` : expression;
    const r = await this.send('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`in the page: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  }

  /** Waits until `expression` is truthy in the page (polled every `every` ms), or throws after `timeout` ms. */
  async waitFor(expression, { timeout = 240_000, every = 250, what = expression } = {}) {
    const t0 = Date.now();
    for (;;) {
      try {
        if (await this.evaluate(expression)) return Date.now() - t0;
      } catch {
        /* the page may be navigating */
      }
      if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${String(what).slice(0, 120)}`);
      await sleep(every);
    }
  }

  /** A script that runs first thing in every document the page opens from now on (before the page's own). */
  addInitScript(source) {
    return this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /** The page's size in CSS pixels, and how many device pixels each one is drawn with. */
  async setViewport({ width, height, scale = 1 }) {
    this.width = width;
    this.height = height;
    this.scale = scale;
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  }

  /** Opens `url`; resolves once its load event has fired. */
  async goto(url) {
    const loaded = new Promise((resolve) => {
      const off = this.on('Page.loadEventFired', () => {
        off();
        resolve();
      });
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  /**
   * Opens a page made of `html` (a title card, an Open Graph image) at `url`: the document is
   * navigated to `url` first (a file:/// folder, so its relative links reach local fonts and
   * stills), then its content replaced. Resolves once its fonts are in.
   */
  async setContent(html, url = 'about:blank') {
    await this.goto(url);
    const { frameTree } = await this.send('Page.getFrameTree');
    await this.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
    await this.waitFor('document.readyState === "complete" && document.fonts.status === "loaded"', { timeout: 30_000, what: 'the card to load' });
    await this.evaluate('document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode().catch(() => null)))).then(() => true)');
  }

  /**
   * A real mouse event, as the browser gets one from the hardware (trusted, so pointer capture and
   * the game's own handlers work): `type` is 'mouseMoved', 'mousePressed', 'mouseReleased' or
   * 'mouseWheel', at (x, y) in CSS pixels. The film's drawn cursor (the director's cursor()) follows it.
   */
  mouse(type, x, y, { button = 'left', clickCount = 1, deltaX = 0, deltaY = 0, buttons } = {}) {
    const params = { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount, modifiers: 0 };
    if (buttons !== undefined) params.buttons = buttons;
    if (type === 'mouseWheel') Object.assign(params, { deltaX, deltaY, button: 'none' });
    return this.send('Input.dispatchMouseEvent', params);
  }

  /** A touch event: `type` 'touchStart', 'touchMove' or 'touchEnd'; `points` [{ x, y, id }] (none for touchEnd). */
  touch(type, points = []) {
    return this.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id ?? 0, radiusX: 14, radiusY: 14, force: 1 })) });
  }

  /** Types `text` into whatever has the focus, as a keyboard's input method would. */
  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  /**
   * Makes the page a touch device, before it loads (the game decides at start-up): touch events,
   * and the media queries a phone answers (pointer: coarse, hover: none).
   */
  async emulateTouch(on = true) {
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: on, maxTouchPoints: on ? 5 : 1 });
    await this.send('Emulation.setEmulatedMedia', {
      features: on
        ? [
            { name: 'pointer', value: 'coarse' },
            { name: 'any-pointer', value: 'coarse' },
            { name: 'hover', value: 'none' },
            { name: 'any-hover', value: 'none' },
          ]
        : [],
    });
  }

  /** Where the first visible element matching `selector` (and with `text` in it, if given) is on the page (CSS pixels, with its centre), or null. */
  rect(selector, text = null) {
    return this.evaluate(
      (sel, txt) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.getClientRects().length > 0 && (txt === null || e.textContent.includes(txt)));
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      },
      selector,
      text,
    );
  }

  /**
   * The page as it is drawn now, as a Buffer: 'png' (lossless, slower), 'jpeg' or 'webp' (with
   * `quality` 0–100). `fast` asks Chrome to trade PNG compression for speed (bigger files, same pixels).
   */
  async screenshot({ format = 'png', quality, fast = false, clip = null } = {}) {
    const params = { format, captureBeyondViewport: false, optimizeForSpeed: fast };
    if (clip) params.clip = { scale: 1, ...clip };
    if (format !== 'png' && quality !== undefined) params.quality = quality;
    const r = await this.send('Page.captureScreenshot', params);
    return Buffer.from(r.data, 'base64');
  }

  /**
   * Closes Chrome and removes its profile. Chrome is asked to quit (Browser.close, so its helper
   * processes go with it); if it hasn't within 5 s, its whole process tree is killed. On Windows
   * its files stay locked for a moment after it exits, so the profile is retried for up to 20 s.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const exited = new Promise((resolve) => {
      if (this.#proc.exitCode !== null) resolve();
      else this.#proc.once('exit', resolve);
    });
    try {
      const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${this.#port}/json/version`)).json();
      const browser = new WebSocket(webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        browser.onopen = resolve;
        browser.onerror = reject;
      });
      browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    } catch {
      /* already gone, or not answering: killed below */
    }
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
    if (!(await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]))) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(this.#proc.pid)], { stdio: 'ignore' });
      else this.#proc.kill('SIGKILL');
    }
    for (let i = 0; i < 80 && existsSync(this.#profile); i++) {
      try {
        rmSync(this.#profile, { recursive: true, force: true });
      } catch {
        await sleep(250);
      }
    }
    if (existsSync(this.#profile)) console.warn(`could not remove Chrome's profile ${this.#profile}`);
  }
}
