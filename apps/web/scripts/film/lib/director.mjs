// The director: drives the game for the camera from outside it, through the dev build's
// window.__game (Game.setupDebug, dev server only). Nothing in the game's code changes: TypeScript's
// `private` is only a compile-time check, so the Game's fields and methods are all reachable at run
// time, and this script calls them the way the Game itself does.
//
// DIRECTOR_SCRIPT is installed with page.addInitScript (after CLOCK_SCRIPT); it defines
// window.__director, whose methods look the game up when they're called. From Node, call them with
// page.evaluate('__director.go("coaster")') and so on. The recipes:
//
//   world built?        __director.ready()               (the intro's is-world-ready; failed() has the reason if the fair couldn't load)
//   walk in             __director.enter()               (the intro's "Enter the fair" button, as a visitor clicks it)
//   time of day         __director.hour(18.6)            (Environment.setHour, clock paused: Game.setupDebug's ?hour=)
//   film settings       __director.prepare({ dpr: 2 })   (adaptive resolution off: at film speed it reads 30 fps and drops the render scale)
//   clean picture       __director.clean(true)           (every page element over the canvas hidden, the 3D labels and rings too)
//   3D labels only      __director.labels(false)         (the zones' rings and floating titles, the rocket's sign)
//   visitor model       __director.visitor(false)        (hidden for scenery shots; put back with true)
//   people near lens    __director.hidePeople(25)        (anyone within 25 m of the camera isn't drawn, nor their shadow; 0 turns it off)
//   stand somewhere     __director.place(x, z, heading)  (Game.placeVisitor: Player.reset and the trees round the spot)
//   go to a place       await __director.go('ferris')    (a ZONES id, instantly, across the sea too: no fade, no "that's across the sea")
//   pin the camera      __director.camera([x,y,z], [lx,ly,lz])   (Game.debugCam, as ?cam= sets it; null hands the camera back)
//   field of view       __director.fov(35)
//   camera move         __director.path([{ t: 0, pos, look }, { t: 4, pos, look }, …])   (Catmull-Rom through the keys, on the film clock)
//   orbit               __director.orbit({ center, radius, height, from, to, seconds })
//   follow a mover      __director.follow({ target: 'stack.trainPosition', offset: [12, 6, 18], relative: true })
//   stop the move       __director.still()                (the camera stays pinned where the move left it)
//   shadows             __director.shadows([x,y,z], 120)  (where the sun's shadow box is centred, and its half-size: wide shots need it bigger)
//   any attraction      __director.ride('falcon')        (Game.launch: no ticket, no account, no round; see RIDES for the ids)
//   off the ride        __director.leave()               (Game.leave(true): the ride's own exit)
//   ride camera         __director.rideCamera()          (the C key: each ride's next camera, e.g. the coasters' front seat)
//   keyboard            __director.key('KeyW', true) / tap('KeyE') / hold('KeyW', 3)   (real keydown/keyup events: the game and the key hints both see them)
//   key hints overlay   __director.hints(['wasd','|','ShiftLeft','Mouse'], { at: 'right' })   (language-neutral keycaps that light up while held; null removes them)
//   drawn pointer       __director.cursor(true) / fingers(true)   (headless Chrome draws no pointer: these follow page.mouse() / page.touch())
//   title over a shot   __director.overlay(html, css)    (the film's own layer above the game; its CSS animations run on the film clock)
//   first-visit look    __director.skipDressing()        (real-people builds: the first visit's customiser closed, as "Let's go!" does)
//   no fades            __director.fades(false)          (Game.fade runs its middle at once: cuts instead of the 0.3 s black)
//   where things are    __director.status()
//
// Every method that changes the picture takes effect at the next drawn frame: with the film clock
// frozen, that's the next __film.step().

/** Runs in the page, as an init script: defines window.__director. */
function installDirector() {
  if (window.__director) return;

  /** The attractions Game.launch knows (AttractionId; the plots are Creators' Valley's coasters). */
  const RIDES = ['coaster', 'falcon', 'rocket', 'ferris', 'flip', 'ship', 'speedway', 'trail', 'drone', 'crates', 'striker', 'ducks', 'flight', 'jetski', 'slides', 'cannons', 'volley'];
  /** How far south (z, metres) the airport side starts: going there first loads its people (Game.ts TRIP_SOUTH_Z). */
  const TRIP_SOUTH_Z = 150;

  const game = () => {
    const g = window.__game;
    if (!g) throw new Error('no window.__game: the dev server builds it, once the world is ready');
    return g;
  };
  /** A three.js Vector3 without importing three: a clone of one the game already has. */
  const vec = (x, y, z) => game().camera.position.clone().set(x, y, z);

  let layoutModule = null;
  /** The game's place list (layout.ts ZONES), from the dev server (its coordinates are constants). */
  async function zones() {
    layoutModule ??= await import('/src/world/layout.ts');
    const z = { ...layoutModule.ZONES };
    // the changing room's ring is the room's own (the Game copies it over when it builds the room)
    const room = game().room?.zone;
    if (room) z.changing = { ...z.changing, ...room };
    return z;
  }

  // ---------- one hook round every draw: labels and people near the lens ----------
  const state = { labels: true, hideWithin: 0, hidden: [], labelList: null, people: null, peopleAt: -1, frame: 0 };
  /** The floating text labels (textures.ts makeSprite): normal-blended sprites drawn without fog; glows are additive. */
  function findLabels() {
    const list = [];
    game().scene.traverse((o) => {
      if (o.isSprite && o.material && o.material.blending === 1 && o.material.fog === false) list.push(o);
    });
    return list;
  }
  /** Everyone skinned (the crowd, the travellers, the island's players and riders, the dogs), but the visitor. */
  function findPeople() {
    const g = game();
    const list = [];
    g.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      for (let p = o; p; p = p.parent) if (p === g.player?.group) return;
      list.push(o);
    });
    return list;
  }
  function installHooks() {
    const scene = game().scene;
    if (scene.__filmHooks) return;
    scene.__filmHooks = true;
    const before = scene.onBeforeRender;
    const after = scene.onAfterRender;
    scene.onBeforeRender = function (renderer, s, camera, target) {
      before.call(this, renderer, s, camera, target);
      if (!state.labels) {
        state.labelList ??= findLabels();
        for (const o of state.labelList)
          if (o.visible) {
            o.visible = false;
            state.hidden.push(o);
          }
        for (const m of game().zones?.markers ?? [])
          for (const o of [m.ring, m.fill])
            if (o.visible) {
              o.visible = false;
              state.hidden.push(o);
            }
      }
      if (state.hideWithin > 0) {
        // (people come and go as their sets load: the list is gathered again every second of film)
        const frame = window.__film?.steps ?? 0;
        if (!state.people || Math.abs(frame - state.peopleAt) > 30) {
          state.people = findPeople();
          state.peopleAt = frame;
        }
        const c = camera.position;
        const r2 = state.hideWithin * state.hideWithin;
        for (const m of state.people) {
          if (!m.visible) continue;
          const b = m.skeleton?.bones[0]?.matrixWorld.elements ?? m.matrixWorld.elements;
          const dx = b[12] - c.x;
          const dy = b[13] - c.y;
          const dz = b[14] - c.z;
          if (dx * dx + dy * dy + dz * dz < r2) {
            m.visible = false;
            state.hidden.push(m);
          }
        }
      }
    };
    // what was hidden for this draw is put back straight after it, so the game's own logic never sees it
    scene.onAfterRender = function (renderer, s, camera) {
      for (const o of state.hidden) o.visible = true;
      state.hidden.length = 0;
      after.call(this, renderer, s, camera);
    };
  }

  // ---------- the camera ----------
  /**
   * The camera move in progress: fn(t, dt) with the film time. It runs inside the game's tick, after
   * everything has moved and just before the pinned camera is applied (Game.tick calls env.follow
   * once a frame, in every mode, right before its debugCam block): so a camera following a train
   * aims at where the train is in the frame being drawn, not where it was in the last one.
   */
  let camMove = null;
  let lastMoveT = null;
  function stopMove() {
    camMove = null;
    lastMoveT = null;
  }
  /** fn(t, dt) moves the camera from the next drawn frame on (t: film seconds, dt: since its last call, 0 at first). */
  function startMove(fn) {
    hookEnv();
    camMove = fn;
    lastMoveT = null;
  }
  /** The film clock's time (s), or the page's own while it isn't frozen (stills, a live preview). */
  const filmTime = () => (window.__film?.frozen ? window.__film.time : performance.now() / 1000);
  /**
   * Wraps Environment.follow once: the camera move runs there, and the sun's shadow box can be
   * centred somewhere else than where the game puts it (shadows()).
   */
  function hookEnv() {
    const env = game().env;
    if (env.__filmFollow) return;
    const follow = env.follow.bind(env);
    env.__filmFollow = follow;
    env.follow = (target) => {
      if (camMove) {
        const t = filmTime();
        const dt = lastMoveT === null ? 0 : Math.max(0, t - lastMoveT);
        lastMoveT = t;
        try {
          camMove(t, dt);
        } catch (e) {
          console.error(e);
          camMove = null;
        }
      }
      follow(env.__filmAt ?? target);
    };
  }
  /** A point on a Catmull-Rom spline through p0..p3 at u (0..1 between p1 and p2). */
  function catmull(p0, p1, p2, p3, u) {
    const u2 = u * u;
    const u3 = u2 * u;
    return p1.map((_, i) => 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u3));
  }
  const smooth = (u) => u * u * (3 - 2 * u);
  /** Where the keys put the camera at time t (seconds): pos and look, each through its own spline. */
  function sample(keys, t, ease) {
    if (t <= keys[0].t) return keys[0];
    const last = keys[keys.length - 1];
    if (t >= last.t) return last;
    let i = 0;
    while (keys[i + 1].t < t) i++;
    const k1 = keys[i];
    const k2 = keys[i + 1];
    let u = (t - k1.t) / (k2.t - k1.t);
    if (ease) u = smooth(u);
    const k0 = keys[Math.max(0, i - 1)];
    const k3 = keys[Math.min(keys.length - 1, i + 2)];
    return { pos: catmull(k0.pos, k1.pos, k2.pos, k3.pos, u), look: catmull(k0.look, k1.look, k2.look, k3.look, u) };
  }
  function pin(pos, look) {
    const g = game();
    if (g.debugCam) {
      g.debugCam.pos.set(pos[0], pos[1], pos[2]);
      g.debugCam.look.set(look[0], look[1], look[2]);
    } else g.debugCam = { pos: vec(...pos), look: vec(...look) };
  }

  // ---------- the keyboard, and its hints on screen ----------
  // (the keycaps carry symbols, not words, so one film serves every language: ⇧ for Shift, a
  // drawn bar for Space; letters are the keys' own)
  const SPACE_BAR = '<svg viewBox="0 0 40 14" width="5.2vh" height="1.8vh" aria-hidden="true"><path d="M3 2v8h34V2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const MOUSE = (part) =>
    `<svg viewBox="0 0 24 34" width="2.6vh" height="3.7vh" aria-hidden="true"><rect x="2" y="2" width="20" height="30" rx="10" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 2v11" stroke="currentColor" stroke-width="2.2"/>${
      part === 'wheel' ? '<rect x="9.6" y="6" width="4.8" height="7" rx="2.4" class="lit"/>' : '<path d="M12 3.4A8.6 8.6 0 0 0 3.4 12v1H12z" class="lit"/>'
    }</svg>`;
  const KEY_NAMES = {
    KeyW: 'W', KeyA: 'A', KeyS: 'S', KeyD: 'D', KeyE: 'E', KeyC: 'C', KeyF: 'F', KeyH: 'H', KeyM: 'M', KeyR: 'R', KeyT: 'T', KeyI: 'I', KeyX: 'X',
    KeyG: 'G', KeyN: 'N', KeyY: 'Y', KeyP: 'P', KeyU: 'U', KeyJ: 'J', KeyB: 'B', KeyV: 'V', KeyL: 'L', KeyK: 'K', KeyO: 'O', KeyQ: 'Q', KeyZ: 'Z',
    Digit1: '1', Digit2: '2', Digit3: '3',
    ShiftLeft: '⇧', ShiftRight: '⇧', Space: SPACE_BAR, Escape: 'Esc', Enter: '↵', Tab: '⇥',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', PageUp: 'PgUp', PageDown: 'PgDn',
    Mouse: MOUSE('left'), Wheel: MOUSE('wheel'),
  };
  /** Keys drawn wider than a letter. */
  const WIDE = /^(ShiftLeft|ShiftRight|Space|Escape|Enter|Tab|PageUp|PageDown)$/;
  const held = new Set();
  /** Keycaps lit without their key being pressed (light()): what a player would press while the film's crew flies. */
  const shown = new Set();
  function sendKey(code, down) {
    const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : code === 'Space' ? ' ' : code.replace(/Left|Right$/, '');
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key, bubbles: true, cancelable: true }));
    if (down) held.add(code);
    else held.delete(code);
    lightHints();
  }
  let hintsEl = null;
  function lightHints() {
    if (!hintsEl) return;
    for (const cap of hintsEl.querySelectorAll('[data-code]')) cap.classList.toggle('is-down', cap.dataset.code.split(' ').some((c) => held.has(c) || shown.has(c)));
  }
  // the mouse lights its keycaps too: the button while it's held, the wheel for a moment as it turns
  let wheelOff = 0;
  addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && (held.add('Mouse'), lightHints()), true);
  addEventListener('pointerup', (e) => e.pointerType === 'mouse' && (held.delete('Mouse'), lightHints()), true);
  addEventListener(
    'wheel',
    () => {
      held.add('Wheel');
      lightHints();
      clearTimeout(wheelOff);
      wheelOff = setTimeout(() => (held.delete('Wheel'), lightHints()), 160);
    },
    { capture: true, passive: true },
  );
  const HINTS_CSS = `
    .film-hints { position: fixed; right: 2.4vw; bottom: 13vh; z-index: 2147483000; display: flex; gap: 1.1vh; align-items: flex-end; pointer-events: none; font: 700 2.4vh/1 "DM Sans", system-ui, sans-serif; }
    .film-hints.at-center { right: auto; left: 50%; transform: translateX(-50%); bottom: 16vh; }
    .film-hints.at-left { right: auto; left: 2.4vw; bottom: 26vh; }
    .film-hints.at-top { bottom: auto; top: 9vh; }
    .film-hints .cap { min-width: 5.6vh; height: 5.6vh; padding: 0 1.4vh; box-sizing: border-box; display: grid; place-items: center; border-radius: 1.1vh; color: #2a2238; background: linear-gradient(#fffaf0, #efe4cf); box-shadow: 0 0.6vh 0 #b9a888, 0 1vh 2.2vh rgba(0,0,0,0.35); transition: transform 0.08s, box-shadow 0.08s, background 0.08s; }
    .film-hints .cap.is-down { transform: translateY(0.5vh); background: linear-gradient(#ffe08a, #ffc94a); box-shadow: 0 0.1vh 0 #b98a1c, 0 0.5vh 1.4vh rgba(0,0,0,0.35); }
    .film-hints .cap.wide { min-width: 9vh; }
    .film-hints .cap[data-code="Space"] { min-width: 14vh; }
    .film-hints .cap .lit { fill: transparent; }
    .film-hints .cap.is-down .lit { fill: #d93354; }
    .film-hints .group { display: grid; grid-template-columns: repeat(3, auto); gap: 0.8vh; }
    .film-hints .group .cap:nth-child(1) { grid-area: 1 / 2; }
    .film-hints .group .cap:nth-child(2) { grid-area: 2 / 1; }
    .film-hints .group .cap:nth-child(3) { grid-area: 2 / 2; }
    .film-hints .group .cap:nth-child(4) { grid-area: 2 / 3; }
    .film-hints .plus { color: #fffaf0; font-size: 3vh; text-shadow: 0 0.3vh 0.8vh rgba(0,0,0,0.6); align-self: center; }
    .film-hints .sep { width: 2.4vh; }`;

  // ---------- the pointer, drawn (headless Chrome draws none) ----------
  // A cursor that follows the real mouse events (page.mouse), with a ring on each press; and for a
  // touch device, a fingertip on each touch.
  const POINTER_CSS = `
    .film-cursor { position: fixed; left: 0; top: 0; z-index: 2147483600; pointer-events: none; width: 3.4vh; height: 3.4vh; transform: translate(-100vw, -100vh); filter: drop-shadow(0 0.3vh 0.5vh rgba(0,0,0,0.45)); }
    .film-cursor svg { width: 100%; height: 100%; display: block; }
    .film-ring { position: fixed; z-index: 2147483500; pointer-events: none; width: 5vh; height: 5vh; margin: -2.5vh 0 0 -2.5vh; border-radius: 50%; border: 0.5vh solid #ffc23d; animation: film-ring 0.45s ease-out forwards; }
    @keyframes film-ring { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.5); opacity: 0; } }
    .film-finger { position: fixed; z-index: 2147483600; pointer-events: none; width: 7vh; height: 7vh; margin: -3.5vh 0 0 -3.5vh; border-radius: 50%; background: radial-gradient(rgba(255,255,255,0.85), rgba(255,255,255,0.45) 60%, rgba(255,255,255,0) 72%); box-shadow: 0 0 0 0.35vh rgba(29,18,56,0.35); transition: opacity 0.18s; }
    .film-finger.is-up { opacity: 0; }`;
  const CURSOR_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2l15.5 11.2-6.6 1.1 3.9 7.1-3 1.6-3.9-7.1L3.6 20z" fill="#fffaf0" stroke="#1d1238" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  let cursorEl = null;
  let fingersOn = false;
  const fingers = new Map();
  function pointerStyle() {
    style('film-pointer-css', cursorEl || fingersOn ? POINTER_CSS : null);
  }
  addEventListener(
    'mousemove',
    (e) => {
      if (cursorEl) cursorEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    },
    true,
  );
  addEventListener(
    'mousedown',
    (e) => {
      if (!cursorEl) return;
      const ring = document.createElement('div');
      ring.className = 'film-layer film-ring';
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      document.body.append(ring);
      setTimeout(() => ring.remove(), 500);
    },
    true,
  );
  function touchesAt(e) {
    if (!fingersOn) return;
    for (const t of e.changedTouches) {
      let f = fingers.get(t.identifier);
      if (e.type === 'touchend' || e.type === 'touchcancel') {
        if (f) {
          f.classList.add('is-up');
          fingers.delete(t.identifier);
          setTimeout(() => f.remove(), 250);
        }
        continue;
      }
      if (!f) {
        f = document.createElement('div');
        f.className = 'film-layer film-finger';
        document.body.append(f);
        fingers.set(t.identifier, f);
      }
      f.style.left = `${t.clientX}px`;
      f.style.top = `${t.clientY}px`;
    }
  }
  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) addEventListener(type, touchesAt, { capture: true, passive: true });

  // ---------- the clean picture ----------
  // (the film's own layers, the keycaps, the pointer and the title overlays, stay)
  const CLEAN_CSS = `
    body > :not(#world):not(.film-layer) { display: none !important; }
    #world > :not(canvas) { display: none !important; }`;
  function style(id, css) {
    let el = document.getElementById(id);
    if (css === null) return el?.remove();
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.append(el);
    }
    el.textContent = css;
  }

  window.__director = {
    RIDES,
    /** The fair is built and the intro offers the way in. */
    ready() {
      return !!document.getElementById('intro')?.classList.contains('is-world-ready');
    },
    /** Why the fair couldn't open (the intro's fallback note), or null. */
    failed() {
      // (main.ts's fallback: the button says the fair is closed, and a note under it says why)
      const btn = document.getElementById('enter');
      if (!btn?.disabled || !/fair is closed/i.test(btn.textContent ?? '')) return null;
      return [...document.querySelectorAll('#intro .intro-hint')].pop()?.textContent?.trim() ?? 'the fair could not load';
    },
    /**
     * Walks in, as the intro's button does (the game's enter(): the HUD, the guide card on a first
     * visit). A first visit also opens the customiser on the visitor (no saved look in a fresh
     * profile): `dress` keeps it open (the your-look tutorial), otherwise it's cancelled and the
     * visitor walks in as the default person.
     */
    enter({ dress = false, guide = false } = {}) {
      const btn = document.getElementById('enter');
      if (!btn || btn.disabled) throw new Error(`can't enter: ${btn?.textContent?.trim() ?? 'no button'}`);
      btn.click();
      const g = game();
      if (g.mode === 'dressing' && !dress) this.skipDressing();
      // the welcome guide opens on a first visit: put away for filming unless `guide` (the tutorials
      // can open it again with the I key)
      if (!guide) g.ui.hidePanel?.();
      return g.mode;
    },
    /**
     * A first visit's customiser (real-people builds), closed as "Let's go!" would close it: the
     * visitor keeps the person it shows. Nothing happens on builds without one.
     */
    skipDressing() {
      const g = game();
      if (g.mode !== 'dressing') return g.mode;
      g.customiser?.close?.();
      g.leaveDressing?.(false);
      return g.mode;
    },
    /**
     * Film settings: adaptive resolution off (at film speed it would see 30 fps and halve the render
     * scale), and the render scale at `dpr` device pixels per CSS pixel (2 renders 4x the pixels
     * for supersampled stills; the browser scales the canvas down to the page's size).
     */
    prepare({ dpr } = {}) {
      const g = game();
      g.adaptive.update = () => false;
      g.adaptive.scale = 1;
      if (dpr) g.quality.dpr = dpr;
      g.renderer.setPixelRatio(g.quality.dpr);
      g.resize();
      installHooks();
      return { tier: g.quality.tier, dpr: g.quality.dpr, size: [g.renderer.domElement.width, g.renderer.domElement.height] };
    },
    /** The park clock at `h` (0–24), standing still. */
    hour(h) {
      const env = game().env;
      env.timeMode = 'paused';
      env.setHour(h);
      return env.clock;
    },
    /** Hides (true) or shows again every page element over the 3D view, and the 3D labels. */
    clean(on = true) {
      style('film-clean', on ? CLEAN_CSS : null);
      this.labels(!on);
      return on;
    },
    /** Shows or hides the 3D labels: the zones' rings and floating titles, the rocket's sign. */
    labels(on) {
      installHooks();
      state.labels = on;
      state.labelList = null;
      return on;
    },
    /** Shows or hides the visitor's own model. */
    visitor(on) {
      game().player.group.visible = on;
      return on;
    },
    /** People within `metres` of the camera aren't drawn (0: everyone is). */
    hidePeople(metres) {
      installHooks();
      state.hideWithin = metres;
      state.people = null;
      return metres;
    },
    /** Puts the visitor down at (x, z) facing `heading` (radians, 0 = north), the trees round them planted. */
    place(x, z, heading = 0, floorY = 0) {
      const g = game();
      // (the airport's and the island's people load the first time the visitor heads south: newer builds only)
      if (z > TRIP_SOUTH_Z) g.loadTripPeople?.();
      g.placeVisitor(x, z, heading, floorY);
      g.camYaw = heading;
      g.camPitch = 0.2;
      g.updateDriveCamera(1, true);
      return this.status();
    },
    /** Takes the visitor to a place (a ZONES id, see layout.ts), on either side of the sea, at once. */
    async go(id) {
      const z = (await zones())[id];
      if (!z) throw new Error(`no zone "${id}"`);
      return this.place(z.x, z.z, z.heading, z.y ?? 0);
    },
    /** The place list (ZONES): id → { x, z, y, heading, title }. */
    async places() {
      const all = await zones();
      return Object.fromEntries(Object.entries(all).map(([id, z]) => [id, { x: z.x, z: z.z, y: z.y ?? 0, heading: z.heading, title: z.title }]));
    },
    /** Pins the camera at `pos` looking at `look` (null: back to the game's own camera). */
    camera(pos, look) {
      stopMove();
      if (!pos) {
        // the game's own camera, with its own lens back (Game.resize sets the field of view)
        game().debugCam = null;
        game().resize();
        return null;
      }
      pin(pos, look);
      return [pos, look];
    },
    /** The camera's vertical field of view (degrees); the game puts its own back when the window resizes. */
    fov(deg) {
      const cam = game().camera;
      cam.fov = deg;
      cam.updateProjectionMatrix();
      return deg;
    },
    /**
     * Moves the camera through `keys` ({ t: seconds, pos: [x,y,z], look: [x,y,z] }), its time 0 at
     * the next drawn frame. `ease` slows into and out of each key. Returns the move's length (s).
     */
    path(keys, { ease = false } = {}) {
      const first = sample(keys, 0, ease);
      pin(first.pos, first.look);
      let start = null;
      startMove((t) => {
        start ??= t;
        const s = sample(keys, t - start, ease);
        pin(s.pos, s.look);
      });
      return keys[keys.length - 1].t;
    },
    /**
     * Circles `center` at `radius`, `height` above it, from angle `from` to `to` (radians, 0 = due
     * south of it, π/2 east) over `seconds`, looking at the centre raised by `lookY`. `ease` starts
     * and stops gently.
     */
    orbit({ center, radius, height, from = 0, to = Math.PI / 4, seconds = 5, lookY = 0, ease = false }) {
      const at = (u) => {
        const a = from + (to - from) * (ease ? smooth(u) : u);
        pin([center[0] + Math.sin(a) * radius, center[1] + height, center[2] + Math.cos(a) * radius], [center[0], center[1] + lookY, center[2]]);
      };
      at(0);
      let start = null;
      startMove((t) => {
        start ??= t;
        at(Math.min(1, Math.max(0, (t - start) / seconds)));
      });
      return seconds;
    },
    /**
     * Follows something that moves: `target` is a path on the game to a Vector3 ('stack.trainPosition':
     * the Thunder Loop's train; 'falcon.trainPosition', 'player.position', 'speedway.focus',
     * 'flight.focus'…). The camera keeps `offset` from it (world axes, or `relative` to its heading
     * of travel: x to the right, z behind; a vertical loop flips that heading, so keep relative for
     * flat runs), or stands still `at` a spot and turns to keep it in frame (a pan). It moves after it
     * at rate `smooth` (about 1/smooth s to catch up; 0: rigidly) and looks at the target plus `look`,
     * straight at it unless `lookSmooth` eases the aim too. It runs inside the tick, so it aims at
     * where the target is in the frame being drawn.
     */
    follow({ target, offset = [0, 10, 20], at = null, look = [0, 1.5, 0], smooth = 2, lookSmooth = 0, relative = false }) {
      const g = game();
      const get = () => target.split('.').reduce((o, k) => o?.[k], g);
      const p0 = get();
      if (!p0) throw new Error(`nothing at "${target}"`);
      let prev = [p0.x, p0.y, p0.z];
      let heading = [0, 0, -1];
      let pos = null;
      let aim = null;
      startMove((_t, dt) => {
        const p = get();
        const cur = [p.x, p.y, p.z];
        const dx = cur[0] - prev[0];
        const dz = cur[2] - prev[2];
        const len = Math.hypot(dx, dz);
        if (len > 1e-4) heading = [dx / len, 0, dz / len];
        prev = cur;
        // relative: offset[0] to the right of travel, offset[2] behind it
        const o = relative ? [-heading[2] * offset[0] - heading[0] * offset[2], offset[1], heading[0] * offset[0] - heading[2] * offset[2]] : offset;
        const goal = at ?? [cur[0] + o[0], cur[1] + o[1], cur[2] + o[2]];
        const lookGoal = [cur[0] + look[0], cur[1] + look[1], cur[2] + look[2]];
        const k = !pos || !smooth ? 1 : 1 - Math.exp(-dt * smooth);
        pos = pos ? pos.map((v, i) => v + (goal[i] - v) * k) : goal;
        const kl = !aim || !lookSmooth ? 1 : 1 - Math.exp(-dt * lookSmooth);
        aim = aim ? aim.map((v, i) => v + (lookGoal[i] - v) * kl) : lookGoal;
        pin(pos, aim);
      });
      return target;
    },
    /** Stops a camera move (path, orbit, follow) where it is: the camera stays pinned there. */
    still() {
      stopMove();
    },
    /** Centres the sun's shadow box on `at` ([x,y,z]; null: back to where the game puts it) with half-size `span` metres (null: the game's own). */
    shadows(at, span = null) {
      const env = game().env;
      hookEnv();
      env.__filmAt = at ? vec(...at) : null;
      if (span) env.setShadowSpan(span);
      else env.resetShadowSpan();
      return [at, span];
    },
    /**
     * Starts an attraction as if its round had just been paid for (Game.launch), with no ticket, no
     * account and no round: the server is never asked, and when it ends no results screen opens.
     * The visitor should be at it first (go(id)): the island's games only run on Palm Cay, the flight
     * leaves from the desk the visitor stands at. `fade: false` cuts straight in.
     */
    ride(id, { fade = true } = {}) {
      const g = game();
      if (!RIDES.includes(id) && !/^plot[1-8]$/.test(id)) throw new Error(`no attraction "${id}"`);
      if (g.mode !== 'drive') throw new Error(`can't start ${id}: the visitor is in "${g.mode}"`);
      if (g.round || g.boarding || g.leaving) throw new Error(`can't start ${id}: a round is under way`);
      if (!fade) g.fade = (mid) => mid();
      try {
        g.launch(id);
      } finally {
        if (!fade) delete g.fade;
      }
      return g.mode;
    },
    /** Off the attraction, the way its own end goes (Game.leave(true): its exit, then back on foot). */
    leave({ fade = true } = {}) {
      const g = game();
      if (!fade) g.fade = (mid) => mid();
      try {
        g.leave(true);
      } finally {
        if (!fade) delete g.fade;
      }
      return g.mode;
    },
    /** The ride's next camera (the C key). */
    rideCamera() {
      sendKey('KeyC', true);
      sendKey('KeyC', false);
    },
    /** Fades between scenes (Game.fade) on or off (off: its middle runs at once, a cut). */
    fades(on) {
      const g = game();
      if (on) delete g.fade;
      else g.fade = (mid) => mid();
      return on;
    },
    /** Presses (true) or lets go of (false) a key, by KeyboardEvent.code. */
    key(code, down = true) {
      sendKey(code, down);
      return [...held];
    },
    /** One press and release, a step of film apart (the game sees the key down for one frame). */
    tap(code) {
      sendKey(code, true);
      const off = window.__film?.onStep(() => {
        off();
        sendKey(code, false);
      });
      if (!off) sendKey(code, false);
    },
    /** Holds a key for `seconds` of film. */
    hold(code, seconds) {
      sendKey(code, true);
      const start = window.__film.time;
      const off = window.__film.onStep((t) => {
        if (t - start < seconds) return;
        off();
        sendKey(code, false);
      });
    },
    /** Lets go of every key held. */
    release() {
      for (const code of [...held]) sendKey(code, false);
      shown.clear();
      lightHints();
    },
    /**
     * Lights a keycap (on) or puts it out (off) without pressing its key: for a shot where the game
     * itself does what the key would (the flight's scripted crew), so the caps still show the player's keys.
     */
    light(code, on = true) {
      if (on) shown.add(code);
      else shown.delete(code);
      lightHints();
      return on;
    },
    /**
     * Keycaps on the picture, lit while their key is held: `rows` is a list of codes ('KeyW',
     * 'ShiftLeft', 'Space'…; 'Mouse' and 'Wheel' for the mouse), 'wasd' for the four as a cluster,
     * 'arrows' likewise, '+' between keys pressed together, or '|' for a gap. null removes them.
     * `at`: 'right' (above the HUD's corner, clear of the subtitles; the default), 'center',
     * 'left', or any of them with ' top'.
     */
    hints(rows, { at = 'right' } = {}) {
      style('film-hints-css', rows ? HINTS_CSS : null);
      hintsEl?.remove();
      hintsEl = null;
      if (!rows) return null;
      hintsEl = document.createElement('div');
      hintsEl.className = `film-layer film-hints ${at
        .split(' ')
        .map((a) => `at-${a}`)
        .join(' ')}`;
      const cap = (code) => `<span class="cap${WIDE.test(code) ? ' wide' : ''}" data-code="${code}">${KEY_NAMES[code] ?? code}</span>`;
      hintsEl.innerHTML = rows
        .map((r) =>
          r === '|'
            ? '<span class="sep"></span>'
            : r === '+'
              ? '<span class="plus">+</span>'
              : r === 'wasd'
                ? `<span class="group">${['KeyW', 'KeyA', 'KeyS', 'KeyD'].map(cap).join('')}</span>`
                : r === 'arrows'
                  ? `<span class="group">${['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].map(cap).join('')}</span>`
                  : cap(r),
        )
        .join('');
      document.body.append(hintsEl);
      lightHints();
      return rows;
    },
    /** Draws the mouse pointer (true) where the real mouse events put it, with a ring on each click; false hides it. */
    cursor(on = true) {
      if (on && !cursorEl) {
        cursorEl = document.createElement('div');
        cursorEl.className = 'film-layer film-cursor';
        cursorEl.innerHTML = CURSOR_SVG;
        document.body.append(cursorEl);
      } else if (!on && cursorEl) {
        cursorEl.remove();
        cursorEl = null;
      }
      pointerStyle();
      return on;
    },
    /** Puts the drawn cursor at (x, y) without a mouse event (where a shot's pointer starts). */
    cursorAt(x, y) {
      if (cursorEl) cursorEl.style.transform = `translate(${x}px, ${y}px)`;
    },
    /** Draws a fingertip on each touch (a touch device's tutorial). */
    fingers(on = true) {
      fingersOn = on;
      if (!on) for (const f of fingers.values()) f.remove();
      if (!on) fingers.clear();
      pointerStyle();
      return on;
    },
    /**
     * A layer of the film's own over the game (a title over the opening shot, a caption card): `html`
     * and its `css`, above everything; its CSS animations run on the film clock. null removes it.
     */
    overlay(html, css = '') {
      document.getElementById('film-overlay')?.remove();
      style('film-overlay-css', html ? css : null);
      if (!html) return null;
      const el = document.createElement('div');
      el.id = 'film-overlay';
      el.className = 'film-layer';
      el.innerHTML = html;
      document.body.append(el);
      return true;
    },
    /** Where everything is: the mode, the clock, the visitor, the camera. */
    status() {
      const g = game();
      const p = g.player.position;
      const c = g.camera.position;
      return {
        mode: g.mode,
        region: g.region,
        hour: g.env.clock,
        night: Math.round(g.env.night * 100) / 100,
        t: Math.round(g.time.t * 1000) / 1000,
        visitor: [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10),
        camera: [c.x, c.y, c.z].map((v) => Math.round(v * 10) / 10),
        tier: g.quality.tier,
        dpr: g.quality.dpr,
      };
    },
  };
}

export const DIRECTOR_SCRIPT = `(${installDirector})();`;
