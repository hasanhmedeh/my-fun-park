// What the shot lists share: the page helpers every film installs (window.__shots), and the cards
// that open and close the tutorials. See film.mjs for what a shot list and a shot are.
//
// Page code (a setup, a helper, an action's `page`) is sent to the game's page as its source text,
// so it can only use what the page has: __game, __director, __film, __stills and __shots. It can't
// reach anything in these modules.

/**
 * The park's hour for every shot of the park and the island: players always see 16:00 there
 * (environment.ts START_HOUR, the clock paused), so the films show what a visitor gets. Dawn, dusk
 * and night are only for the flight, whose booking card offers them.
 */
export const PARK_HOUR = 16;

/** Installed once per game session (a list's `helpers`): window.__shots. */
export function helpers() {
  window.__shots = {
    /** Into the fair as the intro's button does, with the welcome guide left open, if not in yet. */
    inFair() {
      if (__game.inFair) return false;
      document.getElementById('enter').click();
      return true;
    },
    /** The welcome guide open (true) or put away (false), as the ℹ️ button and its ✕ do. */
    guide(open) {
      const ui = __game.ui;
      // (Game.enter sets the guide up under the key 'welcome')
      const isOpen = !ui.panelEl.hidden && ui.panelOpenKey === 'welcome';
      if (open && !isOpen) ui.infoEl.click();
      if (!open) ui.hidePanel();
      return open;
    },
    /** Stands the visitor at (x, z) facing `heading` (0 north, π/2 west), the game's camera behind them. */
    stand(x, z, heading = 0) {
      __director.camera(null);
      __director.place(x, z, heading);
      __game.player.enabled = true;
      return __director.status();
    },
    /** The point `metres` ahead of (x, z) along `heading` (the game's: 0 is north, -z; π/2 is west, -x). */
    ahead(x, z, heading, metres) {
      return [x - Math.sin(heading) * metres, z - Math.cos(heading) * metres];
    },
    /** Where an object is in the world, [x, y, z]. */
    at(o) {
      const v = __game.camera.position.clone();
      o.getWorldPosition(v);
      return [v.x, v.y, v.z];
    },
    /**
     * A stand-in member for this page only, so the members' screens open without a server (the
     * stills' trick; a list whose session has `api` has a pretend server instead and needs none).
     */
    async member() {
      const { session } = await import('/src/account/session.ts');
      session._user ??= { id: 'film', email: 'visitor@example.com', username: 'Visitor', createdAt: '2026-01-01T00:00:00Z', role: 'player' };
      return session._user.username;
    },
    /**
     * A small circuit that passes every one of the workshop's checks (the stills' "workshop"
     * design): a lift hill, a drop, a loop and home along the front. Each piece is [type, settings].
     */
    design: [
      ['curve', { angle: -90, radius: 10, bank: 20 }],
      ['straight', { len: 4, kind: 'lift' }],
      ['slope', { angle: 30, radius: 10, kind: 'lift' }],
      ['straight', { len: 22, kind: 'lift' }],
      ['slope', { angle: -30, radius: 10 }],
      ['curve', { angle: -90, radius: 10, bank: 30 }],
      ['slope', { angle: -45, radius: 10 }],
      ['straight', { len: 8 }],
      ['slope', { angle: 45, radius: 10 }],
      ['loop', { size: 14, side: 1 }],
      ['curve', { angle: -90, radius: 8, bank: 40 }],
      ['straight', { len: 33 }],
      ['curve', { angle: -90, radius: 8, bank: 40 }],
    ],
    /** Into the Coaster Workshop's yard (no fade), its design emptied: the build starts from nothing. */
    workshop() {
      __director.fades(false);
      if (__game.mode !== 'workshop') __game.enterWorkshop();
      __director.fades(true);
      const w = __game.workshop;
      w.design.pieces.length = 0;
      w.selected = null;
      w.change(() => {});
      return w;
    },
    /** Lays the design's pieces up to the `n`th (all of them by default), as the Add buttons do. */
    build(n = Infinity) {
      const w = __game.workshop;
      for (const [type, settings] of this.design.slice(w.design.pieces.length, n)) {
        w.addPiece(type);
        Object.assign(w.design.pieces[w.selected], settings);
      }
      w.change(() => {});
      return w.design.pieces.length;
    },
    /** Gives the pieces already laid (by the Add buttons, on film) the design's settings, as their sliders would. */
    tune() {
      const w = __game.workshop;
      w.design.pieces.forEach((p, i) => {
        const [type, settings] = this.design[i] ?? [];
        if (type && p.t === type) Object.assign(p, settings);
      });
      w.change(() => {});
      return w.design.pieces.length;
    },
    /**
     * Flight FA101 from the Gate 3 desk, lined up on the runway with the engines running (the
     * "Skip to the runway" assist) and cleared for takeoff, flown from there by the game's own
     * scripted crew (world/flight/crew.ts) once `toga()` sets the thrust: the visitor needn't be
     * at the desk.
     */
    async flight(timeOfDay = 'day') {
      await __director.go('flight');
      const fl = __game.flight;
      fl.booking = { from: 'home', timeOfDay };
      __director.ride('flight', { fade: false });
      __film.advance(2);
      // the first officer's skip to the runway (N), once the runway is free to line up on
      __stills.until(() => !fl.sim.traffic?.runwayBusy(fl.sim.from).busy, 1800);
      __director.tap('KeyN');
      __film.advance(2);
      // lined up: on until the tower clears it (rolling without the clearance costs stars)
      __stills.run(fl, () => fl.sim.atc.clearance.takeoff, 2400);
      return fl.sim.stage;
    },
    /** Full thrust (TOGA, the Y key's detent), and the crew takes it from there: the take-off roll, rotation, the climb. */
    async toga() {
      const { Crew } = await import('/src/world/flight/crew.ts');
      const { A320 } = await import('/src/aviation/a320.ts');
      const fl = __game.flight;
      fl.pilotOverride = new Crew(fl.sim, {}).frame;
      fl.sim.pilot.throttle = A320.detents.toga;
      return true;
    },
  };
}

/** The tutorials' emoji, the same in every language: each one's opening sting. */
export const ICONS = {
  'getting-started': '👋',
  'tickets-and-account': '🎟️',
  'thrill-rides': '🎢',
  'games-and-races': '🎯',
  'coaster-workshop': '🛠️',
  'fly-to-palm-cay': '✈️',
  'your-look': '👕',
};

/** A tutorial's opening sting: the logo and its emoji over one of the landing page's stills. */
export function sting(id, { still = 'hero', seconds = 2.6, chapter = 'start' } = {}) {
  return { id: 'sting', duration: seconds, chapter, card: { type: 'sting', icon: ICONS[id], still: `public/media/stills/${still}-1920.webp` }, out: null };
}

/**
 * The closing card: the logo, "free in your browser" as icons, and the site's address. `seconds`
 * on the page; YouTube's cut lengthens it (youtube.mjs) to make room for its end screen.
 */
export function endCard({ still = 'hero', seconds = 5, xfade = 0.6 } = {}) {
  return { id: 'end', duration: seconds, in: { xfade }, out: { fade: 0.8 }, card: { type: 'end', still: `public/media/stills/${still}-1920.webp` } };
}
