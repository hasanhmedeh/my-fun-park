// The film's clock: makes every captured frame advance the game by exactly one frame of video time
// (1/30 s, say), however long that frame takes to draw and to capture.
//
// CLOCK_SCRIPT is installed with page.addInitScript, so it runs before any of the page's own code.
// Until `__film.freeze()` it changes nothing: the page runs on the real clock, so the game loads
// and builds as usual (its loaders, fonts and fetch timeouts all see real time). Frozen, the page's
// clocks stop, and only `__film.step(ms)` moves them on:
//  - performance.now() and Date.now() return the virtual time (THREE.Timer, which the game's loop
//    reads, uses performance.now(), and so do the trees' and the map tiles' time budgets);
//  - requestAnimationFrame callbacks wait for the next step, and are all called in it with the
//    virtual time (three's setAnimationLoop goes through window.requestAnimationFrame, so the
//    game's whole tick, its physics substeps and the draw happen inside step());
//  - setTimeout / setInterval callbacks fire in the step that reaches their time, in order, with the
//    clock set to it (the game's fades, the ticket countdowns, the shop's clock); timers set before
//    the freeze are carried over with the time they had left;
//  - CSS transitions and animations (and element.animate) are paused and moved on by each step,
//    so the interface's fades and slides play at film speed too.
// `__film.resume()` hands the page back to the real clock, carrying on from the virtual time (no
// jump backwards). Workers, audio and fetch timeouts keep real time; nothing the game draws uses them.
//
// Node side: `await page.evaluate('__film.freeze()')` once the scene is set up, then per frame
// `await page.evaluate('__film.step(1000 / 30)')` and a screenshot (see capture.mjs).

/** Runs in the page, as the first script of every document. */
function installClock() {
  if (window.__film) return;
  const perf = performance;
  const realNow = perf.now.bind(perf);
  const realDateNow = Date.now.bind(Date);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCaf = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);

  let frozen = false;
  /** The virtual performance.now() while frozen (ms). */
  let now = 0;
  /** How far the page's clock runs behind the real one after a resume (the time spent frozen, less the time stepped). */
  let lag = 0;
  /** Wall-clock time minus performance.now(), so Date.now() moves with the virtual clock. */
  const dateOffset = realDateNow() - realNow();
  /** Ids for callbacks this clock holds, clear of the small numbers the browser hands out. */
  let nextId = 1_000_000_000;
  /** Animation-frame callbacks waiting for the next frame: id → { cb, real }. */
  const frames = new Map();
  /** Timers: id → { fn, args, every, at (page time), real (the browser's handle while running on real time) }. */
  const timers = new Map();
  /** Animations this clock paused and drives frame by frame. */
  const driven = new Set();
  /** Called at the start of each step with the virtual time (seconds since the freeze) and the step (seconds). */
  const hooks = [];
  let frozenAt = 0;
  let steps = 0;

  // Math.random: the browser's own until seed(), then a fixed sequence (mulberry32), so the ghost
  // karts, the jet-ski rivals, the crowd's paths and a flight's weather do the same on every take
  const realRandom = Math.random.bind(Math);
  let rng = null;
  Math.random = function random() {
    return rng ? rng() : realRandom();
  };

  const pageNow = () => (frozen ? now : realNow() - lag);

  perf.now = function now_() {
    return pageNow();
  };
  Date.now = function dateNow() {
    return frozen || lag ? Math.floor(dateOffset + pageNow()) : realDateNow();
  };

  window.requestAnimationFrame = function requestAnimationFrame(cb) {
    const id = nextId++;
    const f = { cb, real: 0 };
    frames.set(id, f);
    if (!frozen) armFrame(id, f);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    const f = frames.get(id);
    if (!f) return realCaf(id);
    if (f.real) realCaf(f.real);
    frames.delete(id);
  };
  /** On real time: the browser calls it at its next frame (one asked for before a freeze waits for the first step instead). */
  function armFrame(id, f) {
    f.real = realRaf(() => {
      f.real = 0;
      if (frozen || !frames.has(id)) return;
      frames.delete(id);
      f.cb(pageNow());
    });
  }

  function addTimer(fn, ms, args, repeat) {
    const id = nextId++;
    const delay = Math.max(0, Number(ms) || 0);
    const t = { fn: typeof fn === 'function' ? fn : () => (0, eval)(String(fn)), args, every: repeat ? Math.max(1, delay) : 0, at: pageNow() + delay, real: 0 };
    timers.set(id, t);
    if (!frozen) armTimer(id, t);
    return id;
  }
  function armTimer(id, t) {
    t.real = realSetTimeout(() => {
      t.real = 0;
      if (frozen || !timers.has(id)) return;
      fire(id, t);
      if (timers.has(id) && t.every) armTimer(id, t);
    }, Math.max(0, t.at - pageNow()));
  }
  function fire(id, t) {
    if (t.every) t.at += t.every;
    else timers.delete(id);
    t.fn(...t.args);
  }
  window.setTimeout = function setTimeout(fn, ms, ...args) {
    return addTimer(fn, ms, args, false);
  };
  window.setInterval = function setInterval(fn, ms, ...args) {
    return addTimer(fn, ms, args, true);
  };
  window.clearTimeout = window.clearInterval = function clearTimer(id) {
    const t = timers.get(id);
    if (!t) return realClearTimeout(id);
    if (t.real) realClearTimeout(t.real);
    timers.delete(id);
  };

  /** Runs the timers due by `until`, earliest first (ties in the order they were set), each with the clock at its time. */
  function runTimers(until) {
    for (let guard = 0; guard < 10_000; guard++) {
      let id = 0;
      let next = null;
      for (const [k, t] of timers)
        if (t.at <= until && (!next || t.at < next.at || (t.at === next.at && k < id))) {
          id = k;
          next = t;
        }
      if (!next) return;
      now = Math.max(now, next.at);
      try {
        fire(id, next);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Pauses the page's running animations (CSS and element.animate) and takes them over. */
  function adoptAnimations() {
    if (!document.getAnimations) return;
    // (getAnimations flushes styles, so transitions started by this step's changes are in the list)
    for (const a of document.getAnimations()) {
      if (driven.has(a) || a.playState !== 'running') continue;
      a.pause();
      driven.add(a);
    }
  }
  function advanceAnimations(ms) {
    for (const a of driven) {
      if (a.playState === 'finished' || a.playState === 'idle') {
        driven.delete(a);
        continue;
      }
      if (a.playState !== 'paused') continue;
      const t = (Number(a.currentTime) || 0) + ms * (a.playbackRate || 1);
      const end = a.effect?.getComputedTiming().endTime;
      if (typeof end === 'number' && Number.isFinite(end) && t >= end) {
        a.finish();
        driven.delete(a);
      } else a.currentTime = t;
    }
  }

  window.__film = {
    get frozen() {
      return frozen;
    },
    /** Virtual seconds since the freeze. */
    get time() {
      return frozen ? (now - frozenAt) / 1000 : 0;
    },
    get steps() {
      return steps;
    },
    /**
     * Stops the page's clocks at the current time. Resolves after two real frames, by which time the
     * game's loop has asked for its next frame through this clock (so only step() runs it from here).
     * The first step after a freeze is uneven (the game's last real frame was a moment before it), so
     * freeze takes that one itself, `align` ms long: every step the caller takes is then exact.
     */
    freeze({ align = 1000 / 60 } = {}) {
      if (frozen) return Promise.resolve(now);
      return new Promise((resolve) => {
        realRaf(() =>
          realRaf(() => {
            now = pageNow();
            frozenAt = now;
            frozen = true;
            for (const t of timers.values())
              if (t.real) {
                realClearTimeout(t.real);
                t.real = 0;
              }
            adoptAnimations();
            if (align > 0) window.__film.step(align);
            frozenAt = now;
            steps = 0;
            resolve(now);
          }),
        );
      });
    },
    /**
     * One frame of film: the clock moves on `ms`, the timers due by then fire, the animations move on,
     * and the waiting animation-frame callbacks run (the game's tick: its update and its draw).
     * Returns the virtual seconds since the freeze.
     */
    step(ms = 1000 / 30) {
      if (!frozen) throw new Error('__film.step: freeze() first');
      const target = now + ms;
      const t = (target - frozenAt) / 1000;
      for (const fn of hooks) {
        try {
          fn(t, ms / 1000);
        } catch (e) {
          console.error(e);
        }
      }
      runTimers(target);
      now = target;
      advanceAnimations(ms);
      const due = [...frames];
      frames.clear();
      for (const [, f] of due) {
        try {
          f.cb(now);
        } catch (e) {
          console.error(e);
        }
      }
      adoptAnimations();
      steps++;
      return t;
    },
    /** Several steps at once (to let a scene settle without capturing it). */
    advance(seconds, fps = 30) {
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) this.step(1000 / fps);
      return this.time;
    },
    /** Back to the real clock, carrying on from the virtual time. */
    resume() {
      if (!frozen) return;
      frozen = false;
      lag = realNow() - now;
      for (const [id, f] of frames) armFrame(id, f);
      for (const [id, t] of timers) armTimer(id, t);
      for (const a of driven) if (a.playState === 'paused') a.play();
      driven.clear();
    },
    /**
     * Math.random from here on is the fixed sequence that starts at `n` (null: the browser's own
     * again). Each shot seeds it as it starts, so a shot filmed on its own plays as it did in the cut.
     */
    seed(n) {
      if (n === null || n === undefined) {
        rng = null;
        return null;
      }
      let a = n >>> 0;
      rng = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      return n;
    },
    /** fn(t, dt) runs at the start of every step, before the game's tick (camera paths, scripted input). */
    onStep(fn) {
      hooks.push(fn);
      return () => {
        const i = hooks.indexOf(fn);
        if (i >= 0) hooks.splice(i, 1);
      };
    },
  };
}

export const CLOCK_SCRIPT = `(${installClock})();`;
