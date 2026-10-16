// The Coaster Workshop's sheet in the Builder's Yard: lay a coaster piece by piece (with undo), give
// it a name, colours, cars and a ride mode, buy the parts, save it in one of a few design slots, ride
// it for free, and send it to staff. Staff (and creators) also open submitted coasters here, to look
// at and test-ride them (inspect).
import {
  api,
  ApiError,
  creationPictureUrl,
  type CoasterPartItem,
  type CreationDetail,
  type CreationStatus,
  type DesignSummary,
  type MyCreation,
  type Workshop,
} from '../account/api';
import type { AuthMode } from '../account/auth-dialog';
import { session } from '../account/session';
import type { Sfx } from '../world/audio';
import { escapeHtml } from '../world/ui';
import {
  CONNECTOR_PIECE,
  checkTrack,
  cleanDesign,
  DEFAULT_COLORS,
  defaultPiece,
  DesignError,
  layTrack,
  LIMITS,
  MAX_CARS,
  MAX_LENGTH,
  MAX_PART_ORDER,
  MAX_PIECES,
  MIN_CARS,
  NAME_MAX,
  newDesign,
  noParts,
  PART_IDS,
  PARTS,
  partsUsed,
  PIECE_KINDS,
  rideStats,
  shortfall,
  SPEEDS,
  STATION,
  type Design,
  type Issue,
  type Part,
  type Parts,
  type Piece,
  type PieceKind,
  type PieceType,
  type RideStats,
  type Track,
} from './rules';
import type { Yard } from './yard';

type Tab = 'build' | 'style' | 'parts' | 'designs' | 'sent';
const TABS: readonly Tab[] = ['build', 'style', 'parts', 'designs', 'sent'];

const PIECES: Record<PieceType, { icon: string; name: string; blurb: string }> = {
  straight: { icon: '📏', name: 'Straight', blurb: 'A straight run' },
  curve: { icon: '↪️', name: 'Curve', blurb: 'A banked turn' },
  slope: { icon: '⛰️', name: 'Slope', blurb: 'Pitches up or down' },
  helix: { icon: '🌀', name: 'Helix', blurb: 'A climbing or diving spiral' },
  loop: { icon: '➰', name: 'Loop', blurb: 'Vertical loop (loop kit)' },
  roll: { icon: '🌪️', name: 'Corkscrew', blurb: 'Heartline roll (corkscrew kit)' },
};
const PIECE_ORDER: readonly PieceType[] = ['straight', 'curve', 'slope', 'helix', 'loop', 'roll'];
const KINDS: Record<PieceKind, { icon: string; name: string }> = {
  plain: { icon: '', name: 'Plain' },
  lift: { icon: '⛓️', name: 'Lift' },
  launch: { icon: '🚀', name: 'Launch' },
  brakes: { icon: '🛑', name: 'Brakes' },
};
const STATUS: Record<CreationStatus, { icon: string; label: string; tone: string }> = {
  pending: { icon: '⏳', label: 'Waiting for staff', tone: 'wait' },
  released: { icon: '🎢', label: 'In the park', tone: 'good' },
  declined: { icon: '✋', label: 'Declined', tone: 'bad' },
  removed: { icon: '📦', label: 'Taken out of the park', tone: 'muted' },
  replaced: { icon: '🔁', label: 'Replaced by a newer version', tone: 'muted' },
};

/** A number a piece has, as its slider edits it. */
interface Field {
  key: string;
  label: string;
  range: readonly [number, number, number];
  show: (v: number) => string;
  get: (p: Piece) => number;
  set: (p: Piece, v: number) => void;
}
const metres = (v: number) => `${v} m`;
const degrees = (v: number) => `${v}°`;
const field = (key: string, label: string, range: readonly [number, number, number], show: (v: number) => string): Field => ({
  key,
  label,
  range,
  show,
  get: (p) => (p as unknown as Record<string, number>)[key],
  set: (p, v) => ((p as unknown as Record<string, number>)[key] = v),
});
/** The angle's size (its sign is the piece's direction, set by its toggle). */
const angleField = (range: readonly [number, number, number]): Field => ({
  key: 'angle',
  label: 'Angle',
  range,
  show: degrees,
  get: (p) => Math.abs((p as { angle: number }).angle),
  set: (p, v) => {
    const q = p as { angle: number };
    q.angle = q.angle < 0 ? -v : v;
  },
});
const FIELDS: Record<PieceType, Field[]> = {
  straight: [field('len', 'Length', LIMITS.straight.len, metres)],
  curve: [angleField(LIMITS.curve.angle), field('radius', 'Radius', LIMITS.curve.radius, metres), field('bank', 'Banking', LIMITS.curve.bank, degrees)],
  slope: [angleField(LIMITS.slope.angle), field('radius', 'Radius', LIMITS.slope.radius, metres)],
  helix: [
    field('turns', 'Turns', LIMITS.helix.turns, (v) => `${v} ${v === 1 ? 'turn' : 'turns'}`),
    field('radius', 'Radius', LIMITS.helix.radius, metres),
    field('bank', 'Banking', LIMITS.helix.bank, degrees),
    field('rise', 'Climb', LIMITS.helix.rise, (v) => (v > 0 ? `up ${v} m` : v < 0 ? `down ${-v} m` : 'level')),
  ],
  loop: [field('size', 'Height', LIMITS.loop.size, metres)],
  roll: [field('len', 'Length', LIMITS.roll.len, metres)],
};
/** Each piece's left/right (or up/down) toggle: the two choices and the value each sets. */
const TOGGLES: Record<PieceType, { label: string; options: [string, number][]; get: (p: Piece) => number; set: (p: Piece, v: number) => void } | null> = {
  straight: null,
  curve: {
    label: 'Turn',
    options: [
      ['⬅️ Left', 1],
      ['Right ➡️', -1],
    ],
    get: (p) => Math.sign((p as { angle: number }).angle),
    set: (p, v) => ((p as { angle: number }).angle = Math.abs((p as { angle: number }).angle) * v),
  },
  slope: {
    label: 'Pitch',
    options: [
      ['⬆️ Up', 1],
      ['Down ⬇️', -1],
    ],
    get: (p) => Math.sign((p as { angle: number }).angle),
    set: (p, v) => ((p as { angle: number }).angle = Math.abs((p as { angle: number }).angle) * v),
  },
  helix: {
    label: 'Turn',
    options: [
      ['⬅️ Left', 1],
      ['Right ➡️', -1],
    ],
    get: (p) => (p as { dir: number }).dir,
    set: (p, v) => ((p as { dir: number }).dir = v),
  },
  loop: {
    label: 'Comes out',
    options: [
      ['⬅️ Left', -1],
      ['Right ➡️', 1],
    ],
    get: (p) => (p as { side: number }).side,
    set: (p, v) => ((p as { side: number }).side = v),
  },
  roll: {
    label: 'Rolls',
    options: [
      ['⬅️ Left', -1],
      ['Right ➡️', 1],
    ],
    get: (p) => (p as { dir: number }).dir,
    set: (p, v) => ((p as { dir: number }).dir = v),
  },
};

const hasKind = (p: Piece): p is Extract<Piece, { kind: PieceKind }> => p.t === 'straight' || p.t === 'curve' || p.t === 'slope';

/** A design as text, with its keys in order (so a design compares equal however it was put together). */
const canon = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** One line about a piece, for the list. */
function pieceLine(p: Piece) {
  const kind = hasKind(p) && p.kind !== 'plain' ? ` · ${KINDS[p.kind].icon} ${KINDS[p.kind].name.toLowerCase()} ${p.speed ?? SPEEDS[p.kind][2]} km/h` : '';
  switch (p.t) {
    case 'straight':
      return `${p.len} m${kind}`;
    case 'curve':
      return `${Math.abs(p.angle)}° ${p.angle > 0 ? 'left' : 'right'} · r ${p.radius} m${p.bank ? ` · bank ${p.bank}°` : ''}${kind}`;
    case 'slope':
      return `${Math.abs(p.angle)}° ${p.angle > 0 ? 'up' : 'down'} · r ${p.radius} m${kind}`;
    case 'helix':
      return `${p.turns} ${p.dir > 0 ? 'left' : 'right'} · r ${p.radius} m · ${p.rise > 0 ? `up ${p.rise} m` : p.rise < 0 ? `down ${-p.rise} m` : 'level'}`;
    case 'loop':
      return `${p.size} m tall · out ${p.side > 0 ? 'right' : 'left'}`;
    case 'roll':
      return `${p.len} m · rolls ${p.dir > 0 ? 'right' : 'left'}`;
  }
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const clock = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  return `${today ? '' : `${d.toLocaleDateString(undefined, { weekday: 'short' })} `}${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};
const tickets = (n: number) => `${n} 🎟️`;
const partList = (p: Partial<Parts>) =>
  (Object.entries(p) as [Part, number][])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} × ${PARTS[k].icon} ${PARTS[k].name.toLowerCase()}`)
    .join(', ');

export interface BuilderOptions {
  root: HTMLElement;
  yard: Yard;
  sfx: Sfx;
  mobile: boolean;
  /** Back to the fair (Esc, the button). */
  onLeave: () => void;
  /** Ride the coaster as it stands, for free (the yard's coaster is ready: see Yard.flush). */
  onTestRide: () => void;
  onAuth: (mode: AuthMode) => void;
}

/** How a free test ride went (see Game.endTestRide). */
export interface TestResult {
  completed: boolean;
  stalledAt: number | null;
  stats: Record<string, number>;
}

/** What a draft looks like in this browser's storage (an unsaved design survives a reload). */
interface Draft {
  id: string | null;
  design: Design;
  saved: string | null;
}

export class Builder {
  isOpen = false;
  private tab: Tab = 'build';
  private design: Design = newDesign();
  /** The saved design this is (null: not saved yet), and how it was when last saved. */
  private designId: string | null = null;
  private saved: string | null = null;
  private undo: string[] = [];
  private redo: string[] = [];
  /** The design before the change being made (a slider being dragged is one change). */
  private before: string | null = null;
  private selected: number | null = null;
  private track: Track = layTrack([]);
  private issues: Issue[] = [];
  private used: Parts = noParts();
  private stats: RideStats | null = null;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private ws: Workshop | null = null;
  private wsError: string | null = null;
  private busy: string | null = null;
  private note: { text: string; error: boolean; html?: boolean } | null = null;
  private confirming: { text: string; yes: string; run: () => void } | null = null;
  private order: Partial<Record<Part, number>> = {};
  /** Whose draft this is (the yard keeps one per member). */
  private owner: string | null = null;
  /** A submitted coaster being looked at (staff, or its creator): nothing can be changed. */
  inspecting: CreationDetail | null = null;
  private lastTest: TestResult | null = null;
  private panel: HTMLElement;
  private bar: HTMLElement;
  private title: HTMLElement;
  private eyebrow: HTMLElement;
  private wallet: HTMLElement;
  private tabs: HTMLElement;
  private hint: HTMLElement;

  constructor(private o: BuilderOptions) {
    const r = o.root;
    this.panel = r.querySelector('[data-ws-panel]')!;
    this.bar = r.querySelector('[data-ws-bar]')!;
    this.title = r.querySelector('[data-ws-title]')!;
    this.eyebrow = r.querySelector('[data-ws-eyebrow]')!;
    this.wallet = r.querySelector('[data-ws-wallet]')!;
    this.tabs = r.querySelector('[data-ws-tabs]')!;
    this.hint = r.querySelector('[data-ws-hint]')!;
    this.hint.innerHTML = `<span>${
      o.mobile ? 'Drag to look round · pinch to zoom · two fingers to pan · tap the track to pick a piece' : 'Drag to look round · right-drag to pan · scroll to zoom · click the track to pick a piece'
    }</span><button type="button" class="ws-reset" data-ws-reset>⟲ Reset view</button>`;

    r.addEventListener('click', (e) => this.onClick(e));
    r.addEventListener('input', (e) => this.onInput(e));
    r.addEventListener('change', (e) => this.onChange(e));
    // the sheet has the keyboard (the game's keys don't reach it): Esc steps back, then leaves
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.escape();
      }
    });
    // undo, redo and delete work wherever the focus is, but in a text box (which has its own)
    addEventListener('keydown', (e) => {
      if (!this.isOpen || this.inspecting || r.hidden) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redoStep();
        else this.undoStep();
      } else if (mod && k === 'y') {
        e.preventDefault();
        this.redoStep();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected !== null && this.tab === 'build') {
        e.preventDefault();
        this.deletePiece();
      }
    });
    // the tabs are tabs: arrow keys move between them
    this.tabs.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
      e.preventDefault();
      const i = TABS.indexOf(this.tab);
      const next = TABS[(i + (k === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length];
      this.choose(next);
      this.tabs.querySelector<HTMLElement>(`[data-ws-tab="${next}"]`)?.focus();
    });
    o.yard.onPick = (piece) => this.pick(piece);

    session.onChange(() => {
      if (session.user?.id !== this.owner) this.forget();
      if (this.isOpen) this.renderHead();
    });
    // the shop's prices and stock changed (staff, or another member buying)
    session.onWorkshop(() => this.isOpen && !this.inspecting && void this.load());
    session.onMyCreations(() => this.isOpen && this.render());
  }

  // ------------------------------------------------------------------ opening and leaving

  /** Into the yard with the member's own design (the one they were on, or a new one). */
  open() {
    this.isOpen = true;
    this.inspecting = null;
    this.o.root.hidden = false;
    this.o.root.classList.remove('is-inspecting');
    if (session.user?.id !== this.owner) this.forget();
    if (!this.owner) this.restore();
    this.note = null;
    this.confirming = null;
    this.relay(true);
    this.render();
    void this.load();
    void session.loadTickets();
    void session.loadMyCreations();
    this.o.sfx.chime();
    this.o.root.querySelector<HTMLElement>(`[data-ws-tab="${this.tab}"]`)?.focus({ preventScroll: true });
  }

  /** Into the yard to look at a submitted coaster (and ride it): staff checking it, or its creator. */
  inspect(c: CreationDetail) {
    this.isOpen = true;
    this.inspecting = c;
    this.o.root.hidden = false;
    this.o.root.classList.add('is-inspecting');
    this.note = null;
    this.confirming = null;
    const track = layTrack(c.data.pieces);
    this.o.yard.show(c.data, track, null, [], true);
    this.o.yard.resetView();
    this.render();
    this.o.sfx.chime();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.o.root.hidden = true;
    this.endEdit();
    this.saveDraft();
    if (this.inspecting) {
      // the member's own design is back in the yard next time
      this.inspecting = null;
      this.o.yard.clear();
    }
  }

  /** Out of the way for a test ride (and back after it). */
  suspend() {
    this.o.root.hidden = true;
  }

  resume() {
    this.o.root.hidden = false;
  }

  /** How a test ride went: said on the Build tab. */
  testDone(r: TestResult) {
    this.lastTest = r;
    const speed = Math.round(r.stats.topSpeedKmh ?? 0);
    const g = (r.stats.maxG ?? 1).toFixed(1);
    this.note =
      r.stalledAt !== null
        ? {
            text: `Stalled at ${r.stalledAt} m: not enough speed to make it over. Add a lift or a launch before that climb, or make it lower.`,
            error: true,
          }
        : r.completed
          ? { text: `Test ride done: ${Math.round(r.stats.lapTimeS ?? r.stats.durationS ?? 0)} s round, ${speed} km/h top speed, ${g} G at the most. 🎉`, error: false }
          : { text: `You hopped off after ${Math.round(r.stats.durationS ?? 0)} s (top speed ${speed} km/h).`, error: false };
    if (!this.inspecting) this.tab = 'build';
    this.render();
  }

  /** Esc: a question goes away first, then the selection, then the yard. */
  escape() {
    if (this.confirming) {
      this.confirming = null;
      return this.render();
    }
    if (this.selected !== null && !this.inspecting) {
      this.select(null);
      return;
    }
    this.o.onLeave();
  }

  /**
   * How far to shift the picture so the plot shows beside the sheet, not under it: the sheet takes
   * the right of a wide screen, the bottom of a narrow one.
   */
  viewOffset(w: number, h: number) {
    const sheet = this.o.root.querySelector<HTMLElement>('.shop-sheet');
    if (!sheet || this.o.root.hidden) return { x: 0, y: 0 };
    const r = sheet.getBoundingClientRect();
    return w > 720 ? { x: Math.round(Math.min(r.width, w * 0.6) / 2), y: 0 } : { x: 0, y: Math.round(Math.min(r.height, h * 0.7) / 2) };
  }

  /** Another member (or nobody) at the keyboard: the last one's draft is put away. */
  private forget() {
    this.saveDraft();
    this.owner = null;
    this.ws = null;
    this.design = newDesign();
    this.designId = null;
    this.saved = null;
    this.undo = [];
    this.redo = [];
    this.before = null;
    this.selected = null;
    this.lastTest = null;
    this.note = null;
    this.confirming = null;
    if (!this.inspecting) this.o.yard.clear();
  }

  private get draftKey() {
    return this.owner ? `workshop-draft:${this.owner}` : null;
  }

  /** The member's draft from this browser, if one was left here. */
  private restore() {
    this.owner = session.user?.id ?? null;
    const key = this.draftKey;
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const d = JSON.parse(raw) as Draft;
      this.design = cleanDesignLoose(d.design);
      this.designId = typeof d.id === 'string' ? d.id : null;
      this.saved = typeof d.saved === 'string' ? d.saved : null;
    } catch {
      /* storage unavailable, or an old draft that doesn't parse: start afresh */
    }
  }

  private saveDraft() {
    const key = this.draftKey;
    if (!key || this.inspecting) return;
    try {
      localStorage.setItem(key, JSON.stringify({ id: this.designId, design: this.design, saved: this.saved } satisfies Draft));
    } catch {
      /* storage unavailable */
    }
  }

  /** The member's workshop from the server: parts, inventory, slots, designs. */
  private async load() {
    try {
      this.ws = await api.workshop();
      this.wsError = null;
      // the design this draft was saved as is gone (deleted in another tab): it's a new one now
      if (this.designId && !this.ws.designs.some((d) => d.id === this.designId)) {
        this.designId = null;
        this.saved = null;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        session.expire();
        return;
      }
      this.wsError = err instanceof Error ? err.message : 'The workshop is out of reach right now.';
    }
    if (this.isOpen && !this.inspecting) this.render();
  }

  // ------------------------------------------------------------------ editing

  private get dirty() {
    return this.saved === null || canon(this.design) !== this.saved;
  }

  private beginEdit() {
    if (this.before === null) this.before = canon(this.design);
  }

  private endEdit() {
    if (this.before === null) return;
    const before = this.before;
    this.before = null;
    if (before === canon(this.design)) return;
    this.undo.push(before);
    if (this.undo.length > 80) this.undo.shift();
    this.redo = [];
    this.saveDraft();
    this.renderBar();
  }

  /** One complete change (a button): recorded for undo, then the track and the sheet catch up. */
  private change(fn: () => void, retrack = true) {
    this.beginEdit();
    fn();
    this.endEdit();
    if (retrack) this.relay();
    else this.o.yard.restyle(this.design);
    this.render();
  }

  private undoStep() {
    this.endEdit();
    const prev = this.undo.pop();
    if (prev === undefined) return;
    this.redo.push(canon(this.design));
    this.design = JSON.parse(prev) as Design;
    this.afterHistory();
  }

  private redoStep() {
    this.endEdit();
    const next = this.redo.pop();
    if (next === undefined) return;
    this.undo.push(canon(this.design));
    this.design = JSON.parse(next) as Design;
    this.afterHistory();
  }

  private afterHistory() {
    if (this.selected !== null && this.selected >= this.design.pieces.length) this.selected = this.design.pieces.length ? this.design.pieces.length - 1 : null;
    this.relay();
    this.saveDraft();
    this.o.sfx.pop();
    this.render();
  }

  /** The track laid again from the pieces: what's wrong, the parts, the yard, and (soon) the numbers. */
  private relay(now = false) {
    this.track = layTrack(this.design.pieces);
    this.issues = checkTrack(this.design.pieces, this.track);
    this.used = partsUsed(this.design, this.track);
    this.o.yard.show(this.design, this.track, this.selected, this.faulty(), now);
    this.scheduleStats(now);
  }

  private faulty() {
    return this.issues.flatMap((i) => (i.piece === undefined ? [] : [i.piece]));
  }

  private scheduleStats(now = false) {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    const run = () => {
      this.statsTimer = null;
      this.stats = this.design.pieces.length ? rideStats(this.track, this.design.mode) : null;
      const el = this.panel.querySelector('[data-ws-stats]');
      if (el) el.innerHTML = this.statsHtml();
    };
    if (now) run();
    else this.statsTimer = setTimeout(run, 220);
  }

  private select(i: number | null, focus = false) {
    this.selected = i;
    this.o.yard.highlight(i, this.faulty());
    if (focus && i !== null) this.o.yard.focusPiece(i);
    if (this.tab !== 'build' && i !== null) this.tab = 'build';
    this.render();
    if (i !== null) this.panel.querySelector('[data-ws-editor]')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** A click in the yard: a piece of track (or the way home, or nothing). */
  private pick(piece: number | null) {
    if (this.inspecting) return;
    if (piece === CONNECTOR_PIECE) {
      this.select(null);
      this.flash('The way home closes the circuit by itself: shape it by where your last piece ends and which way it points.');
      return;
    }
    this.select(piece !== null && piece >= 0 ? piece : null);
    if (piece !== null && piece >= 0) this.o.sfx.pop();
  }

  private addPiece(t: PieceType) {
    if (this.design.pieces.length >= MAX_PIECES) return this.flash(`A coaster can have at most ${MAX_PIECES} pieces.`, true);
    const at = this.selected === null ? this.design.pieces.length : this.selected + 1;
    this.change(() => {
      this.design.pieces.splice(at, 0, defaultPiece(t));
      this.selected = at;
    });
    // the camera follows the track as it grows (a loop right next to it would fill the view)
    this.o.yard.focusPiece(at);
    this.o.sfx.pop();
  }

  private deletePiece() {
    const i = this.selected;
    if (i === null) return;
    this.change(() => {
      this.design.pieces.splice(i, 1);
      this.selected = this.design.pieces.length ? Math.max(0, i - 1) : null;
    });
  }

  private duplicatePiece() {
    const i = this.selected;
    if (i === null || this.design.pieces.length >= MAX_PIECES) return;
    this.change(() => {
      this.design.pieces.splice(i + 1, 0, structuredClone(this.design.pieces[i]));
      this.selected = i + 1;
    });
    this.o.yard.focusPiece(i + 1);
  }

  private movePiece(by: -1 | 1) {
    const i = this.selected;
    if (i === null) return;
    const j = i + by;
    if (j < 0 || j >= this.design.pieces.length) return;
    this.change(() => {
      const p = this.design.pieces;
      [p[i], p[j]] = [p[j], p[i]];
      this.selected = j;
    });
  }

  private setKind(kind: PieceKind) {
    const p = this.selected === null ? null : this.design.pieces[this.selected];
    if (!p || !hasKind(p) || p.kind === kind) return;
    this.change(() => {
      p.kind = kind;
      if (kind === 'plain') delete p.speed;
      else p.speed = SPEEDS[kind][2];
    });
  }

  private setCars(n: number) {
    const cars = Math.max(MIN_CARS, Math.min(MAX_CARS, n));
    if (cars === this.design.cars) return;
    this.change(() => {
      this.design.cars = cars;
      const c = this.design.colors.cars;
      while (c.length < cars) c.push(DEFAULT_COLORS.cars[c.length % DEFAULT_COLORS.cars.length]);
      c.length = cars;
      this.used = partsUsed(this.design, this.track);
    }, false);
  }

  // ------------------------------------------------------------------ talking to the server

  private flash(text: string, error = false) {
    this.note = { text, error };
    const el = this.panel.querySelector('[data-ws-note]');
    if (el) el.outerHTML = this.noteHtml();
    else this.render();
  }

  private fail(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.status === 401) {
      session.expire();
      return;
    }
    this.flash(err instanceof Error && err.message ? err.message : fallback, true);
    this.o.sfx.beep();
  }

  private async run(key: string, job: () => Promise<void>) {
    if (this.busy) return;
    this.busy = key;
    this.render();
    try {
      await job();
    } finally {
      this.busy = null;
      if (this.isOpen) this.render();
    }
  }

  /** The member's parts, less what their other saved designs hold (what this design may use). */
  private get free(): Parts | null {
    const ws = this.ws;
    if (!ws) return null;
    const mine = this.designId ? ws.designs.find((d) => d.id === this.designId)?.parts : undefined;
    const free = noParts();
    for (const p of PART_IDS) free[p] = ws.owned[p] - ws.held[p] + (mine?.[p] ?? 0);
    return free;
  }

  private save() {
    let design: Design;
    try {
      design = cleanDesign(this.design);
    } catch (err) {
      if (err instanceof DesignError && /name/i.test(err.message)) this.tab = 'style';
      return this.flash(err instanceof Error ? err.message : 'That design has a problem.', true);
    }
    void this.run('save', async () => {
      try {
        const res = this.designId ? await api.updateDesign(this.designId, design) : await api.createDesign(design);
        this.designId = res.id;
        // the server's own tidy copy is the saved one
        this.design = res.data;
        this.saved = canon(res.data);
        this.relay();
        this.saveDraft();
        this.note = { text: `Saved “${res.name}”. 💾`, error: false };
        this.o.sfx.ding();
        await this.load();
      } catch (err) {
        if (err instanceof ApiError && err.code === 'no_slot') {
          this.tab = 'designs';
          this.note = { text: err.message, error: true };
          this.o.sfx.beep();
        } else if (err instanceof ApiError && err.code === 'parts') {
          const missing = err.missingParts;
          this.tab = 'parts';
          this.note = { text: `Not enough parts to save it: you need ${missing ? partList(missing) : 'more parts'} more. They're on sale below.`, error: true };
          this.o.sfx.beep();
        } else if (err instanceof ApiError && err.status === 404 && this.designId) {
          // deleted in another tab: it can be saved again as a new design
          this.designId = null;
          this.saved = null;
          this.note = { text: 'That design was deleted meanwhile. Save again to keep it as a new design.', error: true };
        } else this.fail(err, "Couldn't save the design.");
      }
    });
  }

  /** Sends the saved design to staff, with a picture of it. */
  private send() {
    const id = this.designId;
    if (!id) return;
    void this.run('send', async () => {
      const picture = await this.o.yard.snapshot();
      try {
        await api.submitDesign(id, picture ?? undefined);
        this.o.sfx.ding();
        // the Sent tab opens on the fresh list and the day's count, not the ones from before
        await Promise.all([this.load(), session.loadMyCreations()]);
        this.note = { text: `“${this.design.name}” is on its way to staff. 📨 Keep building: what they got is a snapshot.`, error: false };
        this.tab = 'sent';
      } catch (err) {
        if (err instanceof ApiError && err.code === 'not_buildable') {
          this.tab = 'build';
          this.note = { text: err.message, error: true };
          this.o.sfx.beep();
        } else this.fail(err, "Couldn't send it to staff.");
      }
    });
  }

  private openDesign(id: string) {
    void this.run(`open:${id}`, async () => {
      try {
        const d = await api.design(id);
        this.design = d.data;
        this.designId = d.id;
        this.saved = canon(d.data);
        this.undo = [];
        this.redo = [];
        this.selected = null;
        this.lastTest = null;
        this.note = { text: `Opened “${d.name}”.`, error: false };
        this.tab = 'build';
        this.relay(true);
        this.o.yard.resetView();
        this.saveDraft();
      } catch (err) {
        this.fail(err, "Couldn't open that design.");
      }
    });
  }

  private newDesign() {
    this.design = newDesign();
    this.designId = null;
    this.saved = null;
    this.undo = [];
    this.redo = [];
    this.selected = null;
    this.lastTest = null;
    this.note = { text: 'A fresh plot. Add pieces after the station to start your coaster.', error: false };
    this.tab = 'build';
    this.relay(true);
    this.o.yard.resetView();
    this.saveDraft();
    this.render();
  }

  private deleteDesign(id: string) {
    void this.run(`delete:${id}`, async () => {
      try {
        await api.deleteDesign(id);
        if (this.designId === id) {
          this.designId = null;
          this.saved = null;
          this.saveDraft();
        }
        this.note = { text: 'Design deleted: its parts are free again.', error: false };
        await this.load();
      } catch (err) {
        this.fail(err, "Couldn't delete that design.");
      }
    });
  }

  private buy(part: Part) {
    const qty = this.order[part] ?? 1;
    void this.run(`buy:${part}`, async () => {
      try {
        const res = await api.buyParts(part, qty);
        session.setBalance(res.balance);
        if (this.ws) {
          this.ws.owned = res.owned;
          this.ws.parts = this.ws.parts.map((p) => (p.id === part ? res.part : p));
        }
        this.note = { text: `Bought ${qty} × ${PARTS[part].name.toLowerCase()}. 🧰`, error: false };
        this.o.sfx.ding();
      } catch (err) {
        if (err instanceof ApiError && err.status === 402) {
          this.flash(`Not enough tickets for that: the Ticket Booth has free ones every day.`, true);
          this.o.sfx.beep();
        } else this.fail(err, "Couldn't buy that.");
        void this.load();
      }
    });
  }

  private claimKit() {
    void this.run('kit', async () => {
      try {
        this.ws = await api.claimStarterKit();
        this.note = { text: `Your starter kit is here: ${partList(this.ws.starterKit.contents)}. 🎁`, error: false };
        this.o.sfx.ding();
      } catch (err) {
        this.fail(err, "Couldn't get the starter kit.");
        void this.load();
      }
    });
  }

  private withdraw(id: string) {
    void this.run(`withdraw:${id}`, async () => {
      try {
        await api.withdrawCreation(id);
        this.note = { text: 'Taken back: staff won’t see it now.', error: false };
        await Promise.all([this.load(), session.loadMyCreations()]);
      } catch (err) {
        this.fail(err, "Couldn't take it back.");
        void session.loadMyCreations();
      }
    });
  }

  /** Asks first (in the sheet), then does it. */
  private ask(text: string, yes: string, run: () => void) {
    this.confirming = { text, yes, run };
    this.render();
    this.panel.querySelector<HTMLElement>('[data-ws-yes]')?.focus();
  }

  // ------------------------------------------------------------------ events

  private onClick(e: Event) {
    const b = (e.target as HTMLElement).closest<HTMLElement>(
      '[data-ws-tab], [data-ws-add], [data-ws-select], [data-ws-kind], [data-ws-toggle], [data-ws-act], [data-ws-mode], [data-ws-cars], [data-ws-buy], [data-ws-qty], [data-ws-design], [data-ws-withdraw], [data-ws-yes], [data-ws-no], [data-ws-leave], [data-ws-reset], [data-auth], [data-ws-issue]',
    );
    if (!b || (b as HTMLButtonElement).disabled) return;
    const d = b.dataset;
    if (d.wsTab) return this.choose(d.wsTab as Tab);
    if (b.hasAttribute('data-ws-leave')) return this.o.onLeave();
    if (b.hasAttribute('data-ws-reset')) return this.o.yard.resetView();
    if (d.auth) return this.o.onAuth(d.auth as AuthMode);
    if (b.hasAttribute('data-ws-yes')) {
      const c = this.confirming;
      this.confirming = null;
      c?.run();
      return this.render();
    }
    if (b.hasAttribute('data-ws-no')) {
      this.confirming = null;
      return this.render();
    }
    if (d.wsAct) return this.act(d.wsAct);
    if (this.inspecting) return;
    if (d.wsAdd) return this.addPiece(d.wsAdd as PieceType);
    if (d.wsSelect !== undefined) {
      const i = Number(d.wsSelect);
      return this.select(this.selected === i ? null : i, true);
    }
    if (d.wsIssue !== undefined) {
      const i = Number(d.wsIssue);
      return i >= 0 ? this.select(i, true) : this.select(null);
    }
    if (d.wsKind) return this.setKind(d.wsKind as PieceKind);
    if (d.wsToggle) {
      const p = this.selected === null ? null : this.design.pieces[this.selected];
      const tg = p && TOGGLES[p.t];
      if (!p || !tg) return;
      const v = Number(d.wsToggle);
      if (tg.get(p) === v) return;
      return this.change(() => tg.set(p, v));
    }
    if (d.wsMode) {
      const mode = d.wsMode === 'driven' ? 'driven' : 'passive';
      if (mode === this.design.mode) return;
      this.change(() => (this.design.mode = mode), false);
      return this.scheduleStats();
    }
    if (d.wsCars) return this.setCars(this.design.cars + Number(d.wsCars));
    if (d.wsQty) {
      const [part, by] = d.wsQty.split(':') as [Part, string];
      this.order[part] = Math.max(1, Math.min(MAX_PART_ORDER, (this.order[part] ?? 1) + Number(by)));
      return this.render();
    }
    if (d.wsBuy) return this.buy(d.wsBuy as Part);
    if (d.wsDesign) {
      const [what, id] = d.wsDesign.split(':');
      if (what === 'open') {
        if (id === this.designId && !this.dirty) return this.choose('build');
        if (this.dirty && this.design.pieces.length)
          return this.ask(`Open another design? The changes to “${this.design.name}” that aren't saved will be lost.`, 'Open it', () => this.openDesign(id));
        return this.openDesign(id);
      }
      if (what === 'delete') {
        const name = this.ws?.designs.find((x) => x.id === id)?.name ?? 'this design';
        return this.ask(`Delete “${name}”? Its parts go back in your box. Coasters you sent from it stay as they are.`, 'Delete it', () => this.deleteDesign(id));
      }
      if (what === 'new') {
        if (this.dirty && this.design.pieces.length) return this.ask(`Start a new design? The changes to “${this.design.name}” that aren't saved will be lost.`, 'Start afresh', () => this.newDesign());
        return this.newDesign();
      }
    }
    if (d.wsWithdraw) return this.ask('Take this one back? Staff won’t see it, and it won’t count as waiting any more.', 'Take it back', () => this.withdraw(d.wsWithdraw!));
  }

  /** The bar's buttons and the editor's piece buttons. */
  private act(what: string) {
    switch (what) {
      case 'undo':
        return this.undoStep();
      case 'redo':
        return this.redoStep();
      case 'test':
        this.endEdit();
        this.o.yard.flush();
        return this.o.onTestRide();
      case 'save':
        return this.save();
      case 'send': {
        const why = this.sendBlocker();
        if (why) return this.flash(why, true);
        const left = this.ws ? this.ws.submissions.perDay - this.ws.submissions.last24h : 0;
        return this.ask(
          `Send “${this.design.name}” to staff? They get it as it is now; you can keep changing your design. ${left === 1 ? 'This is your last send today.' : `${left} sends left today.`}`,
          'Send it 📨',
          () => this.send(),
        );
      }
      case 'kit':
        return this.claimKit();
      case 'delete':
        return this.deletePiece();
      case 'duplicate':
        return this.duplicatePiece();
      case 'up':
        return this.movePiece(-1);
      case 'down':
        return this.movePiece(1);
      case 'done':
        return this.select(null);
      case 'retry':
        return void this.load();
    }
  }

  private onInput(e: Event) {
    if (this.inspecting) return;
    const t = e.target as HTMLInputElement;
    const d = t.dataset;
    if (d.wsNum) {
      const p = this.selected === null ? null : this.design.pieces[this.selected];
      if (!p) return;
      this.beginEdit();
      const v = Number(t.value);
      if (d.wsNum === 'speed') {
        if (hasKind(p) && p.kind !== 'plain') p.speed = v;
      } else {
        const f = FIELDS[p.t].find((x) => x.key === d.wsNum);
        if (!f) return;
        f.set(p, v);
      }
      const out = this.panel.querySelector(`[data-ws-out="${d.wsNum}"]`);
      if (out) out.textContent = d.wsNum === 'speed' ? `${v} km/h` : (FIELDS[p.t].find((x) => x.key === d.wsNum)?.show(v) ?? String(v));
      // the ribbon follows at once, the coaster a moment later; the sheet's lists catch up
      this.relay();
      this.renderLive();
      return;
    }
    if (d.wsColor) {
      this.beginEdit();
      const c = this.design.colors;
      if (d.wsColor === 'rails' || d.wsColor === 'spine' || d.wsColor === 'supports') c[d.wsColor] = t.value.toLowerCase();
      else c.cars[Number(d.wsColor)] = t.value.toLowerCase();
      this.o.yard.restyle(this.design);
      this.renderBar();
      return;
    }
    if (t.hasAttribute('data-ws-name')) {
      this.beginEdit();
      this.design.name = t.value.slice(0, NAME_MAX * 2);
      this.title.textContent = this.design.name.trim() || 'Untitled coaster';
      this.o.yard.restyle(this.design);
      this.renderBar();
    }
  }

  private onChange(e: Event) {
    const t = e.target as HTMLElement;
    if (t.dataset.wsNum || t.dataset.wsColor || t.hasAttribute('data-ws-name')) {
      this.endEdit();
      if (t.dataset.wsNum) this.render();
    }
  }

  private choose(tab: Tab) {
    if (this.inspecting) return;
    this.tab = tab;
    this.confirming = null;
    if (tab === 'sent' && (session.myCreations?.unread ?? 0) > 0) void session.creationsSeen();
    this.render();
  }

  // ------------------------------------------------------------------ drawing the sheet

  private render() {
    if (!this.isOpen) return;
    this.renderHead();
    this.renderBar();
    for (const b of this.tabs.querySelectorAll<HTMLElement>('[data-ws-tab]')) {
      const on = b.dataset.wsTab === this.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const unread = session.myCreations?.unread ?? 0;
    const badge = this.tabs.querySelector<HTMLElement>('[data-ws-unread]');
    if (badge) {
      badge.hidden = !unread;
      badge.textContent = String(unread);
    }
    const scroll = this.panel.scrollTop;
    this.panel.innerHTML = `${this.confirmHtml()}${this.noteHtml()}${this.inspecting ? this.inspectHtml(this.inspecting) : this.tabHtml()}`;
    this.panel.scrollTop = scroll;
  }

  private renderHead() {
    const c = this.inspecting;
    this.eyebrow.textContent = c ? `Inspecting · by @${c.creator}` : "Coaster Workshop · Builder's Yard";
    this.title.textContent = (c ? c.name : this.design.name.trim()) || 'Untitled coaster';
    const balance = session.balance;
    this.wallet.innerHTML = `<span>Tickets</span><b>${balance === null ? '—' : balance}</b>`;
    this.wallet.hidden = !!c;
  }

  /** The bits of the Build tab that follow a slider as it moves. */
  private renderLive() {
    const list = this.panel.querySelector('[data-ws-pieces]');
    if (list) list.innerHTML = this.piecesHtml();
    const checks = this.panel.querySelector('[data-ws-checks]');
    if (checks) checks.innerHTML = this.checksHtml();
    this.renderBar();
  }

  private sendBlocker(): string | null {
    if (!this.designId || this.dirty) return 'Save your design first: staff get the saved version.';
    if (this.issues.length) return `It can't be built yet: ${this.issues[0].message}.`;
    const ws = this.ws;
    if (!ws) return 'One moment: the workshop is still loading.';
    const latest = ws.designs.find((d) => d.id === this.designId)?.latest;
    if (latest?.status === 'pending') return 'This design is already waiting for staff. You can take that one back in the Sent tab.';
    if (ws.submissions.last24h >= ws.submissions.perDay)
      return `That's ${ws.submissions.perDay} coasters sent today already.${ws.submissions.nextAt ? ` You can send another from ${clock(ws.submissions.nextAt)}.` : ''}`;
    return null;
  }

  private renderBar() {
    const c = this.inspecting;
    if (c) {
      this.bar.innerHTML = `<span class="ws-state">A submitted coaster: look and ride, nothing changes</span><button type="button" class="btn btn-primary btn-small" data-ws-act="test">🎢 Test ride</button>`;
      return;
    }
    const busy = this.busy;
    const state = this.saved === null ? (this.designId ? 'Not saved' : 'Not saved yet') : this.dirty ? 'Unsaved changes' : 'Saved ✓';
    const blocker = this.sendBlocker();
    this.bar.innerHTML = `<div class="ws-history"><button type="button" class="ws-icon" data-ws-act="undo" aria-label="Undo" title="Undo (Ctrl+Z)"${
      this.undo.length || this.before !== null ? '' : ' disabled'
    }>↶</button><button type="button" class="ws-icon" data-ws-act="redo" aria-label="Redo" title="Redo (Ctrl+Y)"${this.redo.length ? '' : ' disabled'}>↷</button><span class="ws-state${
      this.dirty ? ' is-dirty' : ''
    }">${state}</span></div><div class="ws-actions"><button type="button" class="btn btn-outline btn-small" data-ws-act="test"${
      this.design.pieces.length ? '' : ' disabled title="Add some track first"'
    }>🎢 Test ride</button><button type="button" class="btn btn-outline btn-small" data-ws-act="save"${busy ? ' disabled' : ''}>${
      busy === 'save' ? 'Saving…' : '💾 Save'
    }</button><button type="button" class="btn btn-primary btn-small" data-ws-act="send"${busy ? ' disabled' : ''}${blocker ? ` aria-disabled="true" title="${escapeHtml(blocker)}"` : ''}>${
      busy === 'send' ? 'Sending…' : '📨 Send to staff'
    }</button></div>`;
  }

  private confirmHtml() {
    const c = this.confirming;
    if (!c) return '';
    return `<div class="ws-confirm" role="alertdialog" aria-live="assertive"><p>${escapeHtml(c.text)}</p><div class="ws-confirm-actions"><button type="button" class="btn btn-primary btn-small" data-ws-yes>${escapeHtml(
      c.yes,
    )}</button><button type="button" class="btn btn-outline btn-small" data-ws-no>Cancel</button></div></div>`;
  }

  private noteHtml() {
    const n = this.note;
    return n ? `<p class="ws-note${n.error ? ' is-error' : ''}" data-ws-note role="status">${n.html ? n.text : escapeHtml(n.text)}</p>` : '<p hidden data-ws-note></p>';
  }

  private tabHtml() {
    if (!session.user)
      return `<div class="ws-card"><h3>Members only</h3><p>The Coaster Workshop is for members: sign up (it's free) and your starter kit is waiting.</p><p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-auth="signup">Sign up</button><button class="btn btn-outline btn-small" type="button" data-auth="login">Log in</button></p></div>`;
    switch (this.tab) {
      case 'build':
        return this.buildHtml();
      case 'style':
        return this.styleHtml();
      case 'parts':
        return this.partsHtml();
      case 'designs':
        return this.designsHtml();
      case 'sent':
        return this.sentHtml();
    }
  }

  // ---------- Build

  private buildHtml() {
    const kit =
      this.ws && !this.ws.starterKit.claimed
        ? `<div class="ws-kit"><span class="ws-kit-art" aria-hidden="true">🎁</span><div><h3>Your free starter kit</h3><p>${escapeHtml(
            partList(this.ws.starterKit.contents),
          )}: enough for a first coaster.</p><button type="button" class="btn btn-primary btn-small" data-ws-act="kit"${this.busy ? ' disabled' : ''}>${
            this.busy === 'kit' ? 'Unpacking…' : 'Claim it'
          }</button></div></div>`
        : '';
    const where = this.selected === null ? 'at the end' : `after piece ${this.selected + 1}`;
    const palette = PIECE_ORDER.map(
      (t) =>
        `<button type="button" class="ws-add" data-ws-add="${t}" title="${PIECES[t].blurb}"${this.design.pieces.length >= MAX_PIECES ? ' disabled' : ''}><span aria-hidden="true">${
          PIECES[t].icon
        }</span>${PIECES[t].name}</button>`,
    ).join('');
    return `${kit}<section class="ws-section"><h3>Add a piece <small>${where}</small></h3><div class="ws-palette">${palette}</div></section>
      <section class="ws-section"><h3>Your track <small>${this.design.pieces.length} / ${MAX_PIECES} pieces</small></h3><ol class="ws-pieces" data-ws-pieces>${this.piecesHtml()}</ol></section>
      ${this.editorHtml()}
      <section class="ws-section" data-ws-checks>${this.checksHtml()}</section>
      <section class="ws-section"><h3>The ride</h3><div data-ws-stats>${this.statsHtml()}</div></section>`;
  }

  private piecesHtml() {
    const station = `<li class="ws-piece is-fixed"><span class="ws-piece-icon" aria-hidden="true">🚉</span><span>Station <small>${STATION.len} m · fixed</small></span></li>`;
    const pieces = this.design.pieces
      .map((p, i) => {
        const bad = this.issues.some((x) => x.piece === i);
        return `<li><button type="button" class="ws-piece${i === this.selected ? ' is-selected' : ''}${bad ? ' is-bad' : ''}" data-ws-select="${i}" aria-pressed="${
          i === this.selected
        }"><span class="ws-piece-no">${i + 1}</span><span class="ws-piece-icon" aria-hidden="true">${PIECES[p.t].icon}</span><span>${PIECES[p.t].name} <small>${escapeHtml(
          pieceLine(p),
        )}</small></span>${bad ? '<span class="ws-piece-warn" aria-label="Has a problem">⚠️</span>' : ''}</button></li>`;
      })
      .join('');
    const home = this.design.pieces.length
      ? `<li class="ws-piece is-fixed${this.issues.some((x) => x.piece === CONNECTOR_PIECE) ? ' is-bad' : ''}"><span class="ws-piece-icon" aria-hidden="true">🏁</span><span>The way home <small>${Math.round(
          this.track.connectorM,
        )} m of steel, back into the station · automatic</small></span></li>`
      : '<li class="ws-piece is-empty">Nothing after the station yet: add a piece above.</li>';
    return station + pieces + home;
  }

  private editorHtml() {
    const i = this.selected;
    const p = i === null ? null : this.design.pieces[i];
    if (i === null || !p) return '<section class="ws-section ws-editor is-empty" data-ws-editor><p>Pick a piece in the list (or on the track) to change it.</p></section>';
    const tg = TOGGLES[p.t];
    const toggle = tg
      ? `<div class="ws-row"><span class="ws-row-name">${tg.label}</span><div class="ws-seg" role="group" aria-label="${tg.label}">${tg.options
          .map(([label, v]) => `<button type="button" data-ws-toggle="${v}" aria-pressed="${tg.get(p) === v}">${label}</button>`)
          .join('')}</div></div>`
      : '';
    const sliders = FIELDS[p.t]
      .map((f) => {
        const v = f.get(p);
        return `<label class="ws-slider"><span class="ws-row-name">${f.label}</span><input type="range" min="${f.range[0]}" max="${f.range[1]}" step="${f.range[2]}" value="${v}" data-ws-num="${
          f.key
        }" /><output data-ws-out="${f.key}">${escapeHtml(f.show(v))}</output></label>`;
      })
      .join('');
    let kind = '';
    if (hasKind(p)) {
      const seg = PIECE_KINDS.map((k) => `<button type="button" data-ws-kind="${k}" aria-pressed="${p.kind === k}">${KINDS[k].icon ? `${KINDS[k].icon} ` : ''}${KINDS[k].name}</button>`).join('');
      const speed =
        p.kind === 'plain'
          ? ''
          : `<label class="ws-slider"><span class="ws-row-name">${p.kind === 'brakes' ? 'Slow to' : p.kind === 'lift' ? 'Lift speed' : 'Launch to'}</span><input type="range" min="${
              SPEEDS[p.kind][0]
            }" max="${SPEEDS[p.kind][1]}" step="1" value="${p.speed ?? SPEEDS[p.kind][2]}" data-ws-num="speed" /><output data-ws-out="speed">${p.speed ?? SPEEDS[p.kind][2]} km/h</output></label>`;
      const what =
        p.kind === 'lift'
          ? 'A chain pulls the train up at a steady speed (it never rolls back here).'
          : p.kind === 'launch'
            ? 'Linear motors fire the train up to the speed you set.'
            : p.kind === 'brakes'
              ? 'Slows a faster train down to the speed you set.'
              : 'Plain track: gravity does the work.';
      kind = `<div class="ws-row"><span class="ws-row-name">Track</span><div class="ws-seg ws-seg-wrap" role="group" aria-label="What the track does">${seg}</div></div>${speed}<p class="ws-help">${what}</p>`;
    }
    const kit = p.t === 'loop' ? '<p class="ws-help">Uses one loop kit (its steel included).</p>' : p.t === 'roll' ? '<p class="ws-help">Uses one corkscrew kit (its steel included).</p>' : '';
    const last = this.design.pieces.length - 1;
    return `<section class="ws-section ws-editor" data-ws-editor><h3><span aria-hidden="true">${PIECES[p.t].icon}</span> Piece ${i + 1} · ${PIECES[p.t].name}</h3>${toggle}${sliders}${kind}${kit}
      <div class="ws-editor-actions"><button type="button" class="btn btn-outline btn-small" data-ws-act="up"${i === 0 ? ' disabled' : ''} aria-label="Move earlier">↑</button><button type="button" class="btn btn-outline btn-small" data-ws-act="down"${
        i === last ? ' disabled' : ''
      } aria-label="Move later">↓</button><button type="button" class="btn btn-outline btn-small" data-ws-act="duplicate"${
        this.design.pieces.length >= MAX_PIECES ? ' disabled' : ''
      }>⧉ Copy</button><button type="button" class="btn btn-outline btn-small ws-danger" data-ws-act="delete">🗑️ Delete</button><button type="button" class="btn btn-primary btn-small" data-ws-act="done">Done</button></div></section>`;
  }

  private checksHtml() {
    const issues = this.issues.length
      ? `<ul class="ws-issues">${this.issues
          .map(
            (x) =>
              `<li><button type="button" data-ws-issue="${x.piece ?? -1}"><span aria-hidden="true">⚠️</span> ${escapeHtml(x.message)}</button></li>`,
          )
          .join('')}</ul>`
      : '<p class="ws-ok">✅ This circuit can be built.</p>';
    const free = this.free;
    const missing = free ? shortfall(this.used, free) : {};
    const needs = PART_IDS.filter((p) => this.used[p] > 0)
      .map((p) => {
        const short = missing[p] ?? 0;
        return `<li class="${short ? 'is-short' : ''}"><span aria-hidden="true">${PARTS[p].icon}</span> ${this.used[p]} × ${escapeHtml(PARTS[p].name.toLowerCase())}${
          short ? ` <b>${short} short</b>` : ''
        }</li>`;
      })
      .join('');
    const partsNote = !free
      ? ''
      : Object.keys(missing).length
        ? `<p class="ws-help">You need more parts to save it (building and test rides are free). <button type="button" class="ws-link" data-ws-tab="parts">Get parts →</button></p>`
        : '<p class="ws-help">You have the parts for it. Parts in saved designs are taken until you delete the design.</p>';
    const length = this.track.length > MAX_LENGTH * 0.9 ? `<p class="ws-help">${Math.round(this.track.length)} of ${MAX_LENGTH} m of track used.</p>` : '';
    return `<h3>Can it be built?</h3>${issues}${length}<h3>Parts it takes</h3><ul class="ws-needs">${needs}</ul>${partsNote}`;
  }

  private statsHtml() {
    const s = this.stats;
    if (!this.design.pieces.length) return '<p class="ws-help">Add some track and the numbers show here.</p>';
    if (!s) return '<p class="ws-help">Working it out…</p>';
    const fact = (label: string, value: string, hot = false) => `<div class="${hot ? 'is-hot' : ''}"><dt>${label}</dt><dd>${value}</dd></div>`;
    const end = s.completes
      ? fact('Round trip', `${s.durationS} s`)
      : fact('Stalls at', `${s.stallAtM ?? 0} m`, true);
    const test = this.lastTest ? '' : '<p class="ws-help">The numbers are worked out with real physics. Try a test ride to feel it!</p>';
    return `<dl class="ws-stats">${fact('Length', `${s.lengthM} m`)}${fact('Height', `${s.maxHeightM} m`)}${fact('Biggest drop', `${s.dropM} m`)}${fact(
      'Top speed',
      `${s.topSpeedKmh} km/h`,
    )}${fact('Max G', `${s.maxG}`)}${fact('Min G', `${s.minG}`)}${fact('Inversions', String(s.inversions))}${end}</dl>${
      s.completes
        ? ''
        : `<p class="ws-warn">😬 The train runs out of speed ${s.stallAtM ?? 0} m in${
            this.design.mode === 'driven' ? ' (with a steady driver)' : ''
          }: it would stall and get towed back. Add a lift or a launch before that climb, or make it gentler.</p>`
    }${test}`;
  }

  // ---------- Style

  private styleHtml() {
    const c = this.design.colors;
    const swatch = (key: string, label: string, value: string) =>
      `<label class="ws-color"><input type="color" value="${escapeHtml(value)}" data-ws-color="${key}" /><span>${label}</span></label>`;
    const cars = c.cars.map((v, k) => swatch(String(k), `Car ${k + 1}`, v)).join('');
    const mode = (m: Design['mode'], icon: string, name: string, blurb: string) =>
      `<button type="button" class="ws-mode" data-ws-mode="${m}" aria-pressed="${this.design.mode === m}"><span class="ws-mode-icon" aria-hidden="true">${icon}</span><b>${name}</b><span>${blurb}</span></button>`;
    return `<section class="ws-section"><h3>Name</h3><label class="ws-name"><span class="visually-hidden">Coaster name</span><input type="text" maxlength="${NAME_MAX}" value="${escapeHtml(
      this.design.name,
    )}" placeholder="Name your coaster" data-ws-name autocomplete="off" spellcheck="false" /></label><p class="ws-help">Up to ${NAME_MAX} characters. It goes on the station sign, with “Designed by @${escapeHtml(
      session.user?.username ?? 'you',
    )}”.</p></section>
      <section class="ws-section"><h3>Track colours</h3><div class="ws-colors">${swatch('rails', 'Rails', c.rails)}${swatch('spine', 'Spine', c.spine)}${swatch('supports', 'Supports', c.supports)}</div></section>
      <section class="ws-section"><h3>The train <small>${this.design.cars} cars · ${this.design.cars * 4} seats</small></h3><div class="ws-cars"><button type="button" class="btn btn-outline btn-small" data-ws-cars="-1"${
        this.design.cars <= MIN_CARS ? ' disabled' : ''
      } aria-label="One car fewer">−</button><span>${this.design.cars}</span><button type="button" class="btn btn-outline btn-small" data-ws-cars="1"${
        this.design.cars >= MAX_CARS ? ' disabled' : ''
      } aria-label="One car more">+</button></div><div class="ws-colors">${cars}</div><p class="ws-help">${MIN_CARS} to ${MAX_CARS} cars, one train car part each.</p></section>
      <section class="ws-section"><h3>How it rides</h3><div class="ws-modes">${mode('passive', '🪑', 'Rides itself', 'Riders sit back: your lifts and launches do the work.')}${mode(
        'driven',
        '🕹️',
        'Driven',
        'Riders get power and brakes, like Thunder Loop.',
      )}</div></section>`;
  }

  // ---------- Parts

  private partsHtml() {
    const ws = this.ws;
    if (!ws) return this.loadingHtml();
    const free = this.free!;
    const kit = ws.starterKit.claimed
      ? ''
      : `<div class="ws-kit"><span class="ws-kit-art" aria-hidden="true">🎁</span><div><h3>Your free starter kit</h3><p>${escapeHtml(
          partList(ws.starterKit.contents),
        )}. Once per member.</p><button type="button" class="btn btn-primary btn-small" data-ws-act="kit"${this.busy ? ' disabled' : ''}>${
          this.busy === 'kit' ? 'Unpacking…' : 'Claim it'
        }</button></div></div>`;
    const missing = shortfall(this.used, free);
    const balance = session.balance;
    const shopClosed = !session.parkOpen;
    const cards = ws.parts
      .map((p: CoasterPartItem) => {
        const qty = this.order[p.id] ?? 1;
        const cost = p.tickets * qty;
        const sold = p.stock === 0;
        const short = balance !== null && balance < cost;
        const need = missing[p.id];
        const held = ws.held[p.id];
        return `<article class="shop-item ws-part${sold ? ' is-sold-out' : ''}${need ? ' is-needed' : ''}"><div class="shop-item-art" aria-hidden="true">${p.icon}</div><h3>${escapeHtml(
          p.name,
        )}</h3><p class="shop-item-blurb">${escapeHtml(p.blurb)}</p><p class="ws-own">You have <b>${ws.owned[p.id]}</b>${held ? ` · ${held} in saved designs` : ''}${
          need ? `<br /><b class="ws-need">This design needs ${need} more</b>` : ''
        }</p><p class="shop-stock">${p.stock === null ? '' : sold ? 'Sold out' : `${p.stock} left`}</p><div class="shop-item-buy"><span class="shop-price">${tickets(p.tickets)} <small>/ ${escapeHtml(
          p.unit,
        )}</small></span><div class="ws-qty"><button type="button" data-ws-qty="${p.id}:-1" aria-label="One fewer"${qty <= 1 ? ' disabled' : ''}>−</button><span>${qty}</span><button type="button" data-ws-qty="${
          p.id
        }:1" aria-label="One more"${qty >= MAX_PART_ORDER || (p.stock !== null && qty >= p.stock) ? ' disabled' : ''}>+</button></div><button type="button" class="btn btn-primary btn-small" data-ws-buy="${p.id}"${
          sold || short || shopClosed || !!this.busy ? ' disabled' : ''
        }>${this.busy === `buy:${p.id}` ? 'Buying…' : `Buy · ${tickets(cost)}`}</button>${short && !sold ? '<span class="shop-short">Not enough tickets</span>' : ''}</div></article>`;
      })
      .join('');
    return `${kit}${shopClosed ? '<p class="shop-note-closed">The park is closed, so the parts shop is too. Back soon!</p>' : ''}<p class="ws-help">Parts are paid in tickets. A saved design holds the parts it uses (the way home counts as steel); delete a design to free them. Building and test rides are always free.</p><div class="shop-grid ws-parts">${cards}</div>`;
  }

  // ---------- Designs

  private designsHtml() {
    const ws = this.ws;
    if (!ws) return this.loadingHtml();
    const slots = ws.slots.free + ws.slots.extra;
    const cards = ws.designs
      .map((d: DesignSummary) => {
        const open = d.id === this.designId;
        const latest = d.latest ? `<span class="ws-pill is-${STATUS[d.latest.status].tone}">${STATUS[d.latest.status].icon} ${STATUS[d.latest.status].label}${d.latest.plot ? ` · plot ${d.latest.plot}` : ''}</span>` : '';
        return `<article class="ws-design${open ? ' is-open' : ''}"><div><h3>${escapeHtml(d.name)}${open ? ' <small>(open)</small>' : ''}</h3><p class="ws-help">${d.pieces} pieces · saved ${when(
          d.updatedAt,
        )}</p>${latest}</div><div class="ws-design-actions"><button type="button" class="btn btn-primary btn-small" data-ws-design="open:${d.id}"${this.busy ? ' disabled' : ''}>${
          open ? 'Build' : 'Open'
        }</button><button type="button" class="btn btn-outline btn-small ws-danger" data-ws-design="delete:${d.id}"${this.busy ? ' disabled' : ''}>Delete</button></div></article>`;
      })
      .join('');
    const empty = ws.designs.length ? '' : '<p class="ws-help">No saved designs yet. Build something, then press 💾 Save.</p>';
    const full = ws.slots.used >= slots;
    return `<section class="ws-section"><h3>Saved designs <small>${ws.slots.used} of ${slots} slots used</small></h3>${cards}${empty}<p class="panel-actions"><button type="button" class="btn btn-outline btn-small" data-ws-design="new:">➕ New design</button></p>${
      full ? '<p class="ws-help">Every slot is taken: delete a design to save a new one.</p>' : ''
    }</section>
      <section class="ws-section"><div class="ws-slot"><span class="ws-kit-art" aria-hidden="true">🗂️</span><div><h3>Extra design slot</h3><p>Keep one more coaster saved, on top of your ${
        ws.slots.free
      } free slots.</p><p class="ws-slot-price"><b>$${ws.slots.extraPriceUsd.toFixed(2)}</b> each</p><button type="button" class="btn btn-primary btn-small" disabled aria-disabled="true">Payments coming soon</button></div></div></section>`;
  }

  // ---------- Sent

  private sentHtml() {
    const mine = session.myCreations;
    if (!mine) return this.loadingHtml();
    const ws = this.ws;
    const limit = ws
      ? `<p class="ws-help">${ws.submissions.last24h} of ${ws.submissions.perDay} sends used in the last 24 hours${
          ws.submissions.nextAt ? `; the next one from ${clock(ws.submissions.nextAt)}` : ''
        }.</p>`
      : '';
    if (!mine.creations.length)
      return `${limit}<div class="ws-card"><h3>Nothing sent yet</h3><p>When your coaster is ready, save it and press 📨 Send to staff. If they release it in Creators' Valley, it gets your name on the station, and you earn tickets every time someone else rides it.</p></div>`;
    const cards = mine.creations
      .map((c: MyCreation) => {
        const s = STATUS[c.status];
        const reply = c.reply ? `<blockquote class="ws-reply"><p>${escapeHtml(c.reply)}</p>${c.reviewedBy ? `<cite>@${escapeHtml(c.reviewedBy)}</cite>` : ''}</blockquote>` : '';
        const earned = c.status === 'released' || c.rides ? `<p class="ws-help">${c.rides} ${c.rides === 1 ? 'ride' : 'rides'} by other guests · <b>${tickets(c.earned)}</b> earned</p>` : '';
        const withdraw =
          c.status === 'pending'
            ? `<button type="button" class="btn btn-outline btn-small" data-ws-withdraw="${c.id}"${this.busy ? ' disabled' : ''}>${this.busy === `withdraw:${c.id}` ? 'Taking back…' : 'Take it back'}</button>`
            : '';
        return `<article class="ws-sent${c.unread ? ' is-unread' : ''}"><img src="${creationPictureUrl(c.id)}" alt="" loading="lazy" onerror="this.remove()" /><div><h3>${escapeHtml(
          c.name,
        )}</h3><p><span class="ws-pill is-${s.tone}">${s.icon} ${s.label}${c.plot && c.status === 'released' ? ` · plot ${c.plot}` : ''}</span> <small>sent ${when(c.createdAt)}</small></p>${reply}${earned}${withdraw}</div></article>`;
      })
      .join('');
    return `${limit}${cards}`;
  }

  // ---------- Inspecting

  private inspectHtml(c: CreationDetail) {
    const s = c.stats;
    const fact = (label: string, value: string) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    const st = STATUS[c.status];
    const issues = checkTrack(c.data.pieces, layTrack(c.data.pieces));
    return `<section class="ws-section"><p><span class="ws-pill is-${st.tone}">${st.icon} ${st.label}${c.plot ? ` · plot ${c.plot}` : ''}</span> <small>sent ${when(c.createdAt)} by @${escapeHtml(
      c.creator,
    )}</small></p><dl class="ws-stats">${fact('Length', `${s.lengthM} m`)}${fact('Height', `${s.maxHeightM} m`)}${fact('Biggest drop', `${s.dropM} m`)}${fact('Top speed', `${s.topSpeedKmh} km/h`)}${fact(
      'Max G',
      `${s.maxG}`,
    )}${fact('Min G', `${s.minG}`)}${fact('Inversions', String(s.inversions))}${fact(s.completes ? 'Round trip' : 'Stalls at', s.completes ? `${s.durationS} s` : `${s.stallAtM ?? 0} m`)}</dl>
      <p class="ws-help">${c.data.pieces.length} pieces · ${c.data.cars} cars · ${c.data.mode === 'driven' ? 'driven (power and brakes)' : 'rides itself'}</p>${
        issues.length ? `<p class="ws-warn">⚠️ ${escapeHtml(issues[0].message)}</p>` : '<p class="ws-ok">✅ The circuit checks out.</p>'
      }<p class="ws-help">Test rides here are free and change nothing. Releasing, declining and taking coasters out is done in the office.</p></section>`;
  }

  private loadingHtml() {
    return this.wsError
      ? `<div class="ws-card"><p>${escapeHtml(this.wsError)}</p><p class="panel-actions"><button type="button" class="btn btn-outline btn-small" data-ws-act="retry">Try again</button></p></div>`
      : '<p class="ws-help">Loading…</p>';
  }
}

/** A draft from storage, made safe: whatever doesn't check out is replaced (a draft can be half-done). */
function cleanDesignLoose(raw: unknown): Design {
  try {
    return cleanDesign(raw);
  } catch {
    const d = newDesign();
    const o = (raw ?? {}) as Partial<Design>;
    try {
      // a nameless draft is still a draft
      return cleanDesign({ ...d, ...o, name: typeof o.name === 'string' && o.name.trim() ? o.name : d.name });
    } catch {
      return d;
    }
  }
}
