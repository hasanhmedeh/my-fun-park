// Screenshots a page with headless Chrome (dev tooling for the preview page, see src/preview/main.ts).
//
//   node scripts/shot.mjs "?scene=a320&cam=40,10,40" out.png [--size 1280x720] [--timeout 90000] [--port 5199]
//
// A first argument starting with "?" opens /preview.html on the dev server at --port (default
// 5199; start it with `npx vite --port 5199`). Waits until the page's title is READY (or ERROR…),
// prints the page's console errors, and writes the PNG.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const size = opt('size', '1280x720').split('x').map(Number);
const timeout = Number(opt('timeout', '90000'));
const port = opt('port', '5199');
const [target, out = 'shot.png'] = args;
if (!target) {
  console.error('usage: node scripts/shot.mjs "<url | ?query>" out.png [--size WxH] [--timeout ms] [--port 5199]');
  process.exit(2);
}
const url = target.startsWith('?') ? `http://localhost:${port}/preview.html${target}` : target;

const CHROME = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => p && existsSync(p));
if (!CHROME) throw new Error('Chrome not found (set CHROME)');

const profile = mkdtempSync(join(tmpdir(), 'shot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${size[0]},${size[1]}`,
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-gpu-blocklist',
    '--enable-gpu',
    '--use-angle=d3d11',
    '--enable-unsafe-swiftshader',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let done = false;
async function cleanup(code) {
  if (done) return;
  done = true;
  chrome.kill();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Chrome may still hold files */
  }
  process.exit(code);
}
setTimeout(() => {
  console.error(`timeout after ${timeout} ms`);
  void cleanup(1);
}, timeout + 15000);

// Chrome writes the port it picked into the profile
let wsPort = null;
for (let i = 0; i < 200 && !wsPort; i++) {
  await sleep(100);
  try {
    wsPort = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  } catch {
    /* not yet */
  }
}
if (!wsPort) {
  console.error('Chrome did not start');
  await cleanup(1);
}
const list = await (await fetch(`http://127.0.0.1:${wsPort}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    console.log(`[page ${msg.params.type}]`, msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 2000));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    console.log('[page exception]', (d.exception?.description ?? d.text).slice(0, 2000));
  }
};
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id;
    pending.set(i, r);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url });
const t0 = Date.now();
let title = '';
while (Date.now() - t0 < timeout) {
  await sleep(250);
  const r = await send('Runtime.evaluate', { expression: 'document.title' });
  title = r.result?.result?.value ?? '';
  if (title === 'READY' || title.startsWith('ERROR')) break;
}
const gpu = await send('Runtime.evaluate', {
  expression: `(() => { try { const gl = document.querySelector('canvas')?.getContext('webgl2'); const e = gl?.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; } catch { return 'n/a'; } })()`,
});
const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
const statusLine = await send('Runtime.evaluate', { expression: `document.getElementById('preview-status')?.textContent ?? ''` });
console.log(`${title || 'NO TITLE'} in ${Date.now() - t0} ms | gpu: ${gpu.result?.result?.value} | ${String(statusLine.result?.result?.value ?? '').slice(0, 300)}`);
console.log(`saved ${out}`);
await cleanup(title === 'READY' ? 0 : 1);
