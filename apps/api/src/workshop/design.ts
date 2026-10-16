// The Coaster Workshop's shared rules: what a player's coaster design is, which parts it uses, how
// its track is laid out, whether it can be built, and how a train rides it. The game imports this
// file as it is (apps/web/src/workshop), so the builder, the rides and this API always agree on
// every number. Plain TypeScript with no imports, so it runs anywhere.
//
// Coordinates are plot-local metres: x across the plot, y up, z toward the plot's front (the side
// guests come in from). The station is fixed along the front; the train leaves it heading -x.

// ------------------------------------------------------------------------------------------------
// Design
// ------------------------------------------------------------------------------------------------

/** What a stretch of plain-looking track does to the train. */
export type PieceKind = 'plain' | 'lift' | 'launch' | 'brakes';
export const PIECE_KINDS: readonly PieceKind[] = ['plain', 'lift', 'launch', 'brakes'];

export type Piece =
  | { t: 'straight'; len: number; kind: PieceKind; speed?: number }
  /** angle in degrees, positive turns left; bank leans into the turn. */
  | { t: 'curve'; angle: number; radius: number; bank: number; kind: PieceKind; speed?: number }
  /** angle in degrees, positive climbs. */
  | { t: 'slope'; angle: number; radius: number; kind: PieceKind; speed?: number }
  /** A spiral: turns (1 = full circle), dir 1 = left, rise in metres over the whole helix. */
  | { t: 'helix'; turns: number; radius: number; bank: number; rise: number; dir: 1 | -1 }
  /** A vertical loop `size` metres tall; its exit runs beside the entry, on `side` (1 = right). */
  | { t: 'loop'; size: number; side: 1 | -1 }
  /** A corkscrew (heartline roll) over `len` metres; dir 1 rolls to the right. */
  | { t: 'roll'; len: number; dir: 1 | -1 };

export type PieceType = Piece['t'];
export type RideMode = 'passive' | 'driven';

export interface Design {
  name: string;
  pieces: Piece[];
  colors: { rails: string; spine: string; supports: string; cars: string[] };
  cars: number;
  mode: RideMode;
}

/** [min, max, step] for each number a piece has. */
type Range = readonly [number, number, number];
export const LIMITS = {
  straight: { len: [2, 40, 0.5] },
  curve: { angle: [10, 270, 5], radius: [6, 40, 1], bank: [0, 90, 5] },
  slope: { angle: [5, 90, 5], radius: [6, 40, 1] },
  helix: { turns: [0.5, 3, 0.25], radius: [8, 30, 1], bank: [0, 80, 5], rise: [-30, 30, 1] },
  loop: { size: [10, 32, 1] },
  roll: { len: [12, 30, 1] },
} as const satisfies Record<PieceType, Record<string, Range>>;

/** Target speeds (km/h) a powered or braked stretch can be set to: [min, max, default]. */
export const SPEEDS: Record<Exclude<PieceKind, 'plain'>, readonly [number, number, number]> = {
  lift: [10, 40, 25],
  launch: [40, 160, 90],
  brakes: [5, 100, 25],
};

export const NAME_MAX = 24;
export const MIN_CARS = 2;
export const MAX_CARS = 6;
export const MAX_PIECES = 80;
/** Total track (pieces, station and the way home), in metres. */
export const MAX_LENGTH = 1200;

/** The build site: a 70 × 70 m plot, the track kept this far inside its edges, under this height. */
export const PLOT_SIZE = 70;
export const PLOT_EDGE = 1.5;
export const MAX_HEIGHT = 35;

/** The station: where it starts (heartline), how long it is, and its heading (-x). */
export const STATION = { x: 9, y: 2.2, z: 26, len: 18 } as const;
/** Ground kept clear around the station building and its entrance (no track below CLEAR m). */
export const STATION_AREA = { x0: -10, x1: 10, z0: 23.5, z1: PLOT_SIZE / 2, clear: 9 } as const;

export const FREE_DESIGN_SLOTS = 3;
/** Price of each saved design beyond the free ones (not on sale yet). */
export const EXTRA_SLOT_PRICE_USD = 4.99;
export const SUBMISSIONS_PER_DAY = 3;
export const PLOTS = 8;
/** The creator's share of each other guest's ride, in tickets. */
export const royalty = (price: number) => Math.max(1, Math.floor(price * 0.2));

export const DEFAULT_COLORS = { rails: '#ff4d6d', spine: '#3a2f6b', supports: '#fff5e3', cars: ['#ffd23d', '#5ce1d6', '#a98bff', '#ff8a3d', '#7ee2b8', '#ff5d7a'] };

export function newDesign(name = 'My Coaster'): Design {
  return { name, pieces: [], colors: { ...DEFAULT_COLORS, cars: DEFAULT_COLORS.cars.slice(0, MIN_CARS) }, cars: MIN_CARS, mode: 'passive' };
}

/** A piece with sensible starting values (the builder's palette). */
export function defaultPiece(t: PieceType): Piece {
  switch (t) {
    case 'straight':
      return { t, len: 10, kind: 'plain' };
    case 'curve':
      return { t, angle: 90, radius: 12, bank: 30, kind: 'plain' };
    case 'slope':
      return { t, angle: 30, radius: 12, kind: 'plain' };
    case 'helix':
      return { t, turns: 1, radius: 12, bank: 40, rise: -8, dir: 1 };
    case 'loop':
      return { t, size: 18, side: 1 };
    case 'roll':
      return { t, len: 18, dir: 1 };
  }
}

/** Something wrong with a design as submitted (bad JSON, out-of-range numbers). */
export class DesignError extends Error {}

const HEX = /^#[0-9a-f]{6}$/i;
const fail = (msg: string): never => {
  throw new DesignError(msg);
};
const num = (v: unknown, r: Range, what: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${what} must be a number`);
  const n = v as number;
  if (n < r[0] - 1e-9 || n > r[1] + 1e-9) fail(`${what} must be between ${r[0]} and ${r[1]}`);
  return Math.round(n / r[2]) * r[2];
};
const signed = (v: unknown, r: Range, what: string) => {
  const n = num(typeof v === 'number' ? Math.abs(v) : NaN, r, what);
  return (v as number) < 0 ? -n : n;
};
const sign = (v: unknown, what: string): 1 | -1 => (v === 1 || v === -1 ? v : fail(`${what} must be 1 or -1`));
const color = (v: unknown, what: string) => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : fail(`${what} must be a colour like #ff4d6d`));

/** Trims a coaster's name; empty or too long names are refused. */
export function cleanName(v: unknown) {
  if (typeof v !== 'string') return fail('The name must be text');
  const name = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!name) fail('Give your coaster a name');
  if ([...name].length > NAME_MAX) fail(`Keep the name to ${NAME_MAX} characters`);
  return name;
}

function cleanKind(o: Record<string, unknown>, what: string): { kind: PieceKind; speed?: number } {
  const kind = o.kind ?? 'plain';
  if (!PIECE_KINDS.includes(kind as PieceKind)) fail(`${what}: unknown kind`);
  if (kind === 'plain') return { kind: 'plain' };
  const [lo, hi, def] = SPEEDS[kind as Exclude<PieceKind, 'plain'>];
  return { kind: kind as PieceKind, speed: o.speed === undefined ? def : num(o.speed, [lo, hi, 1], `${what} speed`) };
}

function cleanPiece(raw: unknown, i: number): Piece {
  const what = `Piece ${i + 1}`;
  if (!raw || typeof raw !== 'object') return fail(`${what} is not a piece`);
  const o = raw as Record<string, unknown>;
  const L = LIMITS;
  switch (o.t) {
    case 'straight':
      return { t: 'straight', len: num(o.len, L.straight.len, `${what} length`), ...cleanKind(o, what) };
    case 'curve': {
      const angle = signed(o.angle, L.curve.angle, `${what} angle`);
      return { t: 'curve', angle, radius: num(o.radius, L.curve.radius, `${what} radius`), bank: num(o.bank, L.curve.bank, `${what} banking`), ...cleanKind(o, what) };
    }
    case 'slope': {
      const angle = signed(o.angle, L.slope.angle, `${what} angle`);
      return { t: 'slope', angle, radius: num(o.radius, L.slope.radius, `${what} radius`), ...cleanKind(o, what) };
    }
    case 'helix':
      return {
        t: 'helix',
        turns: num(o.turns, L.helix.turns, `${what} turns`),
        radius: num(o.radius, L.helix.radius, `${what} radius`),
        bank: num(o.bank, L.helix.bank, `${what} banking`),
        rise: num(o.rise, L.helix.rise, `${what} rise`),
        dir: sign(o.dir, `${what} direction`),
      };
    case 'loop':
      return { t: 'loop', size: num(o.size, L.loop.size, `${what} size`), side: sign(o.side, `${what} side`) };
    case 'roll':
      return { t: 'roll', len: num(o.len, L.roll.len, `${what} length`), dir: sign(o.dir, `${what} direction`) };
    default:
      return fail(`${what} is not a piece`);
  }
}

/** Checks a design that came from outside (a request, storage) and returns a tidy copy. */
export function cleanDesign(raw: unknown): Design {
  if (!raw || typeof raw !== 'object') return fail('Not a coaster design');
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.pieces)) return fail('The design has no pieces list');
  if (o.pieces.length > MAX_PIECES) fail(`A coaster can have at most ${MAX_PIECES} pieces`);
  const pieces = o.pieces.map(cleanPiece);
  const c = (o.colors ?? {}) as Record<string, unknown>;
  const cars = num(o.cars, [MIN_CARS, MAX_CARS, 1], 'Cars');
  const carColors = Array.isArray(c.cars) ? c.cars : [];
  const colors = {
    rails: color(c.rails, 'Rail colour'),
    spine: color(c.spine, 'Spine colour'),
    supports: color(c.supports, 'Support colour'),
    cars: Array.from({ length: cars }, (_, k) => color(carColors[k] ?? DEFAULT_COLORS.cars[k], `Car ${k + 1} colour`)),
  };
  const mode = o.mode === 'driven' ? 'driven' : o.mode === 'passive' ? 'passive' : fail('Pick a ride mode');
  return { name: cleanName(o.name), pieces, colors, cars, mode };
}

// ------------------------------------------------------------------------------------------------
// Parts
// ------------------------------------------------------------------------------------------------

export type Part = 'steel' | 'lift' | 'launch' | 'brakes' | 'loop' | 'corkscrew' | 'station' | 'car';
export const PART_IDS: readonly Part[] = ['steel', 'lift', 'launch', 'brakes', 'loop', 'corkscrew', 'station', 'car'];

export const PARTS: Record<Part, { name: string; unit: string; icon: string; tickets: number; blurb: string }> = {
  steel: { name: 'Steel track', unit: '10 m', icon: '🛤️', tickets: 1, blurb: 'Straights, curves, slopes, helices and the way home' },
  lift: { name: 'Lift hill', unit: '10 m', icon: '⛓️', tickets: 2, blurb: 'Pulls the train up at a steady speed' },
  launch: { name: 'Launch track', unit: '10 m', icon: '🚀', tickets: 3, blurb: 'Linear motors that fire the train forward' },
  brakes: { name: 'Brake run', unit: '10 m', icon: '🛑', tickets: 1, blurb: 'Slows the train to a set speed' },
  loop: { name: 'Loop kit', unit: 'kit', icon: '➰', tickets: 5, blurb: 'One vertical loop, steel included' },
  corkscrew: { name: 'Corkscrew kit', unit: 'kit', icon: '🌀', tickets: 4, blurb: 'One corkscrew roll, steel included' },
  station: { name: 'Station', unit: 'each', icon: '🚉', tickets: 3, blurb: 'Every coaster starts and ends at one' },
  car: { name: 'Train car', unit: 'each', icon: '🚃', tickets: 2, blurb: 'Four seats each; trains have 2 to 6' },
};

/** Every member's one free box of parts. */
export const STARTER_KIT: Partial<Record<Part, number>> = { steel: 15, station: 1, lift: 2, brakes: 2, car: 2 };
/** Most of one part bought in one go. */
export const MAX_PART_ORDER = 50;

export type Parts = Record<Part, number>;
export const noParts = (): Parts => ({ steel: 0, lift: 0, launch: 0, brakes: 0, loop: 0, corkscrew: 0, station: 0, car: 0 });

const KIND_PART: Record<PieceKind, Part> = { plain: 'steel', lift: 'lift', launch: 'launch', brakes: 'brakes' };

/** The parts a design holds: track by the 10 m (the way home counts as steel), kits, the station, cars. */
export function partsUsed(design: Pick<Design, 'pieces' | 'cars'>, track: Track): Parts {
  const metres = noParts();
  for (let i = 0; i < track.n; i++) {
    const k = track.piece[i];
    if (k === STATION_PIECE) continue;
    if (k === CONNECTOR_PIECE) {
      metres.steel += DS;
      continue;
    }
    const pc = design.pieces[k];
    if (pc.t === 'loop' || pc.t === 'roll') continue; // kits bring their own steel
    metres[pc.t === 'helix' ? 'steel' : KIND_PART[pc.kind]] += DS;
  }
  const used = noParts();
  for (const p of ['steel', 'lift', 'launch', 'brakes'] as const) used[p] = Math.max(0, Math.ceil(metres[p] / 10 - 1e-6));
  used.loop = design.pieces.filter((p) => p.t === 'loop').length;
  used.corkscrew = design.pieces.filter((p) => p.t === 'roll').length;
  used.station = 1;
  used.car = design.cars;
  return used;
}

/** What's missing to build `used` from `have` (empty when it fits). */
export function shortfall(used: Parts, have: Parts): Partial<Parts> {
  const out: Partial<Parts> = {};
  for (const p of PART_IDS) if (used[p] > have[p]) out[p] = used[p] - have[p];
  return out;
}

// ------------------------------------------------------------------------------------------------
// Track layout: a "turtle" walks the pieces into a heartline, then a Hermite curve closes the
// circuit back to the station (the same method as the park's own coasters, apps/web track.ts).
// ------------------------------------------------------------------------------------------------

/** Sample spacing along the track, in metres. */
export const DS = 0.5;
/** Where the train waits in the station, metres from the station's start. */
export const START_S = 3;
export const STATION_PIECE = -1;
export const CONNECTOR_PIECE = -2;

export type TrackZone = 'station' | 'lift' | 'launch' | 'brake';

export interface Track {
  /** Number of samples (DS apart); the circuit wraps from the last back to the first. */
  n: number;
  length: number;
  /** xyz per sample: heartline, tangent, up (banking and inversions included), right. */
  pos: number[];
  tan: number[];
  up: number[];
  right: number[];
  zone: (TrackZone | null)[];
  /** Target speed (m/s) on lift, launch and brake samples, 0 elsewhere. */
  speed: number[];
  /** Which piece each sample belongs to (STATION_PIECE, CONNECTOR_PIECE or an index). */
  piece: number[];
  /** Where the last piece ends and which way it points (the next piece starts here). */
  end: { pos: [number, number, number]; tan: [number, number, number] };
  /** Length of the closing stretch back to the station. */
  connectorM: number;
}

type V3 = [number, number, number];
type Q = [number, number, number, number];

const FWD: V3 = [0, 0, -1];
const UP: V3 = [0, 1, 0];
const DEG = Math.PI / 180;
const smooth = (x: number) => x * x * (3 - 2 * x);

const axisQ = (x: number, y: number, z: number, angle: number): Q => {
  const s = Math.sin(angle / 2);
  return [x * s, y * s, z * s, Math.cos(angle / 2)];
};
const mulQ = (a: Q, b: Q): Q => [
  a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1],
  a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
  a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const normQ = (q: Q): Q => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};
const rot = (q: Q, v: V3): V3 => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [v[0] + q[3] * tx + q[1] * tz - q[2] * ty, v[1] + q[3] * ty + q[2] * tx - q[0] * tz, v[2] + q[3] * tz + q[0] * ty - q[1] * tx];
};
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const ZONE: Record<PieceKind, TrackZone | null> = { plain: null, lift: 'lift', launch: 'launch', brakes: 'brake' };
const kmh = (v: number) => v / 3.6;

export function layTrack(pieces: readonly Piece[]): Track {
  const P: V3[] = [];
  const U: V3[] = [];
  const zone: (TrackZone | null)[] = [];
  const speed: number[] = [];
  const piece: number[] = [];
  const start: V3 = [STATION.x, STATION.y, STATION.z];
  const heading = axisQ(0, 1, 0, Math.PI / 2); // forward (-z) turned to -x
  let q = heading;
  const p: V3 = [...start];

  let z: TrackZone | null = 'station';
  let sp = 0;
  let k = STATION_PIECE;
  const push = (bank: number) => {
    let u = rot(q, UP);
    if (bank) u = rot(axisQ(...rot(q, FWD), bank), u);
    P.push([p[0], p[1], p[2]]);
    U.push(u);
    zone.push(z);
    speed.push(sp);
    piece.push(k);
  };
  const advance = () => {
    const f = rot(q, FWD);
    p[0] += f[0] * DS;
    p[1] += f[1] * DS;
    p[2] += f[2] * DS;
  };
  const local = (x: number, y: number, zz: number, angle: number) => (q = mulQ(q, axisQ(x, y, zz, angle)));
  const yaw = (angle: number) => (q = mulQ(axisQ(0, 1, 0, angle), q));

  const straight = (len: number) => {
    const n = Math.round(len / DS);
    for (let i = 0; i < n; i++) {
      push(0);
      advance();
    }
  };
  const turn = (angle: number, radius: number, bank: number) => {
    // yaw about world up (keeps the pitch, so turning while climbing makes a helix); curvature
    // and bank ease in and out together, so riders aren't thrown sideways at either end
    const total = angle * DEG;
    const n = Math.max(1, Math.round((Math.abs(total) * radius) / DS));
    const bankMax = bank * DEG * -Math.sign(total);
    const env = (x: number) => (x < 0.25 ? smooth(x / 0.25) : x > 0.75 ? smooth((1 - x) / 0.25) : 1);
    const w: number[] = [];
    for (let i = 0; i < n; i++) w.push(0.1 + env((i + 0.5) / n));
    const wSum = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) {
      push(bankMax * env(i / n));
      advance();
      yaw((total * w[i]) / wSum);
    }
  };
  const pitch = (angle: number, radius: number) => {
    const total = angle * DEG;
    const n = Math.max(1, Math.round((Math.abs(total) * radius) / DS));
    for (let i = 0; i < n; i++) {
      push(0);
      advance();
      local(1, 0, 0, total / n);
    }
  };

  straight(STATION.len);
  pieces.forEach((pc, i) => {
    k = i;
    z = pc.t === 'straight' || pc.t === 'curve' || pc.t === 'slope' ? ZONE[pc.kind] : null;
    sp = z && 'kind' in pc && pc.kind !== 'plain' ? kmh(pc.speed ?? SPEEDS[pc.kind][2]) : 0;
    if (pc.t === 'straight') straight(pc.len);
    else if (pc.t === 'curve') turn(pc.angle, pc.radius, pc.bank);
    else if (pc.t === 'slope') pitch(pc.angle, pc.radius);
    else if (pc.t === 'helix') {
      const climb = Math.max(-25, Math.min(25, Math.atan2(pc.rise, 2 * Math.PI * pc.radius * pc.turns) / DEG));
      if (Math.abs(climb) > 0.5) pitch(climb, 12);
      turn(360 * pc.turns * pc.dir, pc.radius, pc.bank);
      if (Math.abs(climb) > 0.5) pitch(-climb, 12);
    } else if (pc.t === 'loop') {
      // clothoid-like: wide at the bottom, tight at the top; it stands rBottom + rTop tall
      const rB = pc.size / 1.5;
      const rT = pc.size / 3;
      const shift = pc.side * Math.max(3.5, Math.min(6, pc.size * 0.25));
      const right0 = rot(q, [1, 0, 0]);
      const estLen = Math.PI * (rB + rT);
      let theta = 0;
      let traveled = 0;
      while (theta < Math.PI * 2) {
        const r = rB + (rT - rB) * (1 - Math.cos(theta)) * 0.5;
        const dTheta = Math.min(DS / r, Math.PI * 2 - theta);
        push(0);
        advance();
        // drift sideways so the exit runs beside the entry instead of through it
        const drift = shift * (smooth(Math.min(1, traveled / estLen)) - smooth(Math.min(1, Math.max(0, traveled - DS) / estLen)));
        p[0] += right0[0] * drift;
        p[1] += right0[1] * drift;
        p[2] += right0[2] * drift;
        local(1, 0, 0, dTheta);
        theta += dTheta;
        traveled += DS;
      }
    } else if (pc.t === 'roll') {
      const n = Math.round(pc.len / DS);
      let prev = 0;
      for (let j = 0; j < n; j++) {
        push(0);
        advance();
        const a = smooth((j + 1) / n) * Math.PI * 2 * pc.dir;
        local(0, 0, -1, a - prev);
        prev = a;
      }
    }
    q = normQ(q);
  });
  const end = { pos: [p[0], p[1], p[2]] as V3, tan: rot(q, FWD) };

  // ---- close the circuit back to the station ----
  k = CONNECTOR_PIECE;
  z = null;
  sp = 0;
  while (P.length > 1 && dist(P[P.length - 1], start) < DS * 0.75) {
    P.pop();
    U.pop();
    zone.pop();
    speed.pop();
    piece.pop();
  }
  const startT = rot(heading, FWD);
  const lastI = P.length - 1;
  const err: V3 = [start[0] - startT[0] * DS - P[lastI][0], start[1] - startT[1] * DS - P[lastI][1], start[2] - startT[2] * DS - P[lastI][2]];
  const endP = end.pos;
  const endT = end.tan;
  const gap = dist(endP, start);
  let connector = 0;
  if (Math.hypot(...err) < DS * 2) {
    const K = Math.min(60, lastI);
    for (let j = 0; j < K; j++) {
      const w = smooth(1 - j / K);
      const v = P[lastI - j];
      v[0] += err[0] * w;
      v[1] += err[1] * w;
      v[2] += err[2] * w;
    }
  } else if (gap > DS) {
    // tangents as long as a circular arc's for the turn the way home has to make (a U-turn
    // needs twice the gap), so it comes round as gently as it can instead of in a hairpin
    const bend = Math.acos(Math.max(-1, Math.min(1, dot(endT, startT))));
    const L = gap * Math.max(1.1, bend < 1e-3 ? 1 : (2 * Math.tan(bend / 4)) / Math.sin(bend / 2));
    const h = (t: number): V3 => {
      const t2 = t * t;
      const t3 = t2 * t;
      const a = 2 * t3 - 3 * t2 + 1;
      const b = (t3 - 2 * t2 + t) * L;
      const c = -2 * t3 + 3 * t2;
      const d = (t3 - t2) * L;
      return [endP[0] * a + endT[0] * b + start[0] * c + startT[0] * d, endP[1] * a + endT[1] * b + start[1] * c + startT[1] * d, endP[2] * a + endT[2] * b + start[2] * c + startT[2] * d];
    };
    // resample by arc length
    const fine: V3[] = [];
    for (let i = 0; i <= 600; i++) fine.push(h(i / 600));
    let acc = 0;
    let next = DS;
    for (let i = 1; i < fine.length; i++) {
      const d = dist(fine[i], fine[i - 1]);
      while (acc + d >= next) {
        const f = (next - acc) / d;
        const a = fine[i - 1];
        const b = fine[i];
        const pt: V3 = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
        if (dist(pt, start) > DS * 0.5) {
          P.push(pt);
          U.push([0, 1, 0]);
          zone.push(null);
          speed.push(0);
          piece.push(CONNECTOR_PIECE);
          connector += DS;
        }
        next += DS;
      }
      acc += d;
    }
  }

  // ---- tangents from the actual points; orthonormal frames; smooth the up vectors a little ----
  const n = P.length;
  const T: V3[] = [];
  const R: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = P[(i - 1 + n) % n];
    const b = P[(i + 1) % n];
    const t = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    T.push(t);
    const d = dot(U[i], t);
    U[i] = norm([U[i][0] - t[0] * d, U[i][1] - t[1] * d, U[i][2] - t[2] * d]);
    R.push(norm(cross(t, U[i])));
  }
  for (let pass = 0; pass < 3; pass++) {
    const copy = U.map((v) => [...v] as V3);
    for (let i = 0; i < n; i++) {
      const a = copy[(i - 1 + n) % n];
      const b = copy[(i + 1) % n];
      const c = copy[i];
      const v: V3 = [a[0] + 2 * c[0] + b[0], a[1] + 2 * c[1] + b[1], a[2] + 2 * c[2] + b[2]];
      const d = dot(v, T[i]);
      U[i] = norm([v[0] - T[i][0] * d, v[1] - T[i][1] * d, v[2] - T[i][2] * d]);
      R[i] = norm(cross(T[i], U[i]));
    }
  }
  const flat = (vs: V3[]) => {
    const out = new Array<number>(vs.length * 3);
    vs.forEach((v, i) => {
      out[i * 3] = v[0];
      out[i * 3 + 1] = v[1];
      out[i * 3 + 2] = v[2];
    });
    return out;
  };
  return { n, length: n * DS, pos: flat(P), tan: flat(T), up: flat(U), right: flat(R), zone, speed, piece, end, connectorM: connector };
}

// ------------------------------------------------------------------------------------------------
// Can it be built?
// ------------------------------------------------------------------------------------------------

export interface Issue {
  code: 'empty' | 'too_long' | 'plot' | 'height' | 'ground' | 'station' | 'crossing' | 'home_long' | 'home_tight' | 'upside_down';
  message: string;
  /** The piece at fault (an index into pieces; -2 = the way home). */
  piece?: number;
}

/** Closest two stretches of track may come (heartline to heartline), unless they're neighbours. */
const CLEARANCE = 3.2;
const NEIGHBOURS_M = 12;
const MAX_HOME_M = 150;
const MIN_HOME_RADIUS = 5;

const pieceName = (k: number) => (k === CONNECTOR_PIECE ? 'The way home' : k === STATION_PIECE ? 'The station' : `Piece ${k + 1}`);

/** Lowest point of the train or the track around sample i (riders' heads hang below when inverted). */
export function lowestPoint(t: Track, i: number) {
  const uy = t.up[i * 3 + 1];
  const ry = t.right[i * 3 + 1];
  return t.pos[i * 3 + 1] + Math.min(-1.7 * uy, 0.9 * uy) - 0.8 * Math.abs(ry);
}

/** Every reason the circuit can't be built (the first one of each sort), in track order. */
export function checkTrack(pieces: readonly Piece[], t: Track): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<Issue['code']>();
  const add = (code: Issue['code'], piece: number | undefined, message: string) => {
    if (seen.has(code)) return;
    seen.add(code);
    issues.push({ code, message, ...(piece === undefined ? {} : { piece }) });
  };
  // nothing built yet: the way home is just the station turning round on itself, so that's all there is to say
  if (!pieces.length) return [{ code: 'empty', message: 'Add some track after the station' }];
  if (t.length > MAX_LENGTH) add('too_long', undefined, `The circuit is ${Math.round(t.length)} m long; the most is ${MAX_LENGTH} m`);

  const edge = PLOT_SIZE / 2 - PLOT_EDGE;
  const A = STATION_AREA;
  const stationSamples = Math.round(STATION.len / DS);
  const nearStation = 4 / DS;
  for (let i = 0; i < t.n; i++) {
    const k = t.piece[i];
    const x = t.pos[i * 3];
    const y = t.pos[i * 3 + 1];
    const z = t.pos[i * 3 + 2];
    if (k === STATION_PIECE) continue;
    if (Math.abs(x) > edge || Math.abs(z) > edge) add('plot', k, `${pieceName(k)} runs off the plot`);
    if (y > MAX_HEIGHT) add('height', k, `${pieceName(k)} climbs above the ${MAX_HEIGHT} m height limit`);
    const low = lowestPoint(t, i);
    if (low < 0.25) add('ground', k, `${pieceName(k)} dips into the ground`);
    // the station building and its entrance stay clear (except right where track meets it)
    const fromStation = Math.min(i - stationSamples, t.n - i);
    if (fromStation > nearStation && x > A.x0 && x < A.x1 && z > A.z0 && z < A.z1 && low < A.clear) add('station', k, `${pieceName(k)} runs through the station`);
  }

  // stretches of track that come too close (a spatial hash keeps this quick)
  const cell = CLEARANCE;
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < t.n; i++) {
    const kk = key(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]);
    let list = grid.get(kk);
    if (!list) grid.set(kk, (list = []));
    list.push(i);
  }
  const apart = NEIGHBOURS_M / DS;
  outer: for (let i = 0; i < t.n; i++) {
    const x = t.pos[i * 3];
    const y = t.pos[i * 3 + 1];
    const z = t.pos[i * 3 + 2];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    for (let a = cx - 1; a <= cx + 1; a++)
      for (let b = cy - 1; b <= cy + 1; b++)
        for (let c = cz - 1; c <= cz + 1; c++)
          for (const j of grid.get(`${a},${b},${c}`) ?? []) {
            if (j <= i) continue;
            const sep = Math.min(j - i, t.n - (j - i));
            if (sep <= apart) continue;
            if (Math.hypot(t.pos[j * 3] - x, t.pos[j * 3 + 1] - y, t.pos[j * 3 + 2] - z) < CLEARANCE) {
              const ki = t.piece[i];
              const kj = t.piece[j];
              const later = kj === CONNECTOR_PIECE || kj > ki ? kj : ki;
              const other = later === kj ? ki : kj;
              add('crossing', later, `${pieceName(later)} runs into ${other === STATION_PIECE ? 'the station' : other === CONNECTOR_PIECE ? 'the way home' : `piece ${other + 1}`}`);
              break outer;
            }
          }
  }

  // the way home: a sensible length, no hairpins, and starting from upright track
  if (pieces.length) {
    if (t.connectorM > MAX_HOME_M) add('home_long', CONNECTOR_PIECE, `The way home is ${Math.round(t.connectorM)} m long; end your track closer to the station (at most ${MAX_HOME_M} m)`);
    let tight = 0;
    for (let i = 0; i < t.n; i++) {
      if (t.piece[i] !== CONNECTOR_PIECE) continue;
      const a = (i - 2 + t.n) % t.n;
      const b = (i + 2) % t.n;
      const turn = Math.acos(Math.max(-1, Math.min(1, t.tan[a * 3] * t.tan[b * 3] + t.tan[a * 3 + 1] * t.tan[b * 3 + 1] + t.tan[a * 3 + 2] * t.tan[b * 3 + 2])));
      tight = Math.max(tight, turn / (4 * DS));
    }
    if (tight > 1 / MIN_HOME_RADIUS) add('home_tight', CONNECTOR_PIECE, 'The way home has to turn too sharply; point your track toward the station');
    const last = t.piece.lastIndexOf(pieces.length - 1);
    if (last >= 0 && t.up[last * 3 + 1] < 0.3) add('upside_down', pieces.length - 1, 'Finish the layout right side up before it heads home');
  }
  return issues;
}

// ------------------------------------------------------------------------------------------------
// Ride physics: the train is locked to the rails, gravity acts along the track, plus rolling
// friction and air drag; lifts, launches and brakes work to the speeds the builder set. In a
// driven coaster the rider also has the park's motors and brakes (as on Thunder Loop).
// ------------------------------------------------------------------------------------------------

export const PHYSICS = {
  g: 9.81,
  motor: 4.5,
  turbo: 9,
  brake: 10,
  maxPowered: 32,
  launchAccel: 12,
  liftAccel: 6,
  brakeDecel: 16,
  stationMax: 5,
  stationCrawl: 2.5,
  drag: 0.0012,
  rolling: 0.05,
} as const;

export interface TrainState {
  s: number;
  v: number;
  launching: boolean;
}

const wrapIndex = (t: Track, s: number) => (((s / DS) % t.n) + t.n) % t.n;

/** The zone under the train at s. */
export function zoneOf(t: Track, s: number) {
  return t.zone[Math.round(wrapIndex(t, s)) % t.n];
}

/** One physics step (dt seconds); throttle -1..1 only matters on driven coasters. */
export function stepTrain(t: Track, st: TrainState, throttle: number, turbo: boolean, dt: number): TrackZone | null {
  const x = wrapIndex(t, st.s);
  const i = Math.floor(x) % t.n;
  const j = (i + 1) % t.n;
  const f = x - Math.floor(x);
  const tx = t.tan[i * 3] + (t.tan[j * 3] - t.tan[i * 3]) * f;
  const ty = t.tan[i * 3 + 1] + (t.tan[j * 3 + 1] - t.tan[i * 3 + 1]) * f;
  const tz = t.tan[i * 3 + 2] + (t.tan[j * 3 + 2] - t.tan[i * 3 + 2]) * f;
  const slope = ty / (Math.hypot(tx, ty, tz) || 1);
  const at = Math.round(x) % t.n;
  const z = t.zone[at];
  const target = t.speed[at];
  const P = PHYSICS;

  let a = -P.g * slope;
  const thr = Math.max(-1, Math.min(1, throttle));
  if (thr > 0 && st.v < P.maxPowered) a += thr * (turbo ? P.turbo : P.motor);
  st.launching = false;
  if (z === 'launch' && st.v > -0.5 && st.v < target) {
    a += Math.min(P.launchAccel, (target - st.v) / dt + P.g * Math.max(0, slope));
    st.launching = true;
  }
  a -= P.drag * st.v * Math.abs(st.v) + P.rolling * Math.sign(st.v);
  let v = st.v + a * dt;
  if (thr < 0) {
    const b = -thr * P.brake * dt;
    v = Math.abs(v) <= b ? 0 : v - Math.sign(v) * b;
  }
  // chain/LSM lift: holds the train against gravity however steep it climbs, and brings it up to
  // its speed (anti-rollbacks catch a train sliding back onto it)
  if (z === 'lift' && v < target) {
    v = Math.min(target, Math.max(0, v + P.g * Math.max(0, slope) * dt) + P.liftAccel * dt);
    st.launching = true;
  }
  if (z === 'brake' && Math.abs(v) > target) v = Math.sign(v) * Math.max(target, Math.abs(v) - P.brakeDecel * dt);
  // station tyres: gently roll trains through (and pull a stopped train out)
  if (z === 'station') {
    if (Math.abs(v) > P.stationMax) v = Math.sign(v) * Math.max(P.stationMax, Math.abs(v) - 14 * dt);
    else if (thr >= 0 && v < P.stationCrawl) v = Math.min(P.stationCrawl, v + 3 * dt);
  }
  st.v = v;
  st.s += v * dt;
  return z;
}

/**
 * Times how long a train has been rolling back or standing still, and how far it has got (`run`,
 * its furthest point `best`, and how long since it last got further), to call a stall.
 */
export interface StallWatch {
  back: number;
  still: number;
  run: number;
  best: number;
  idle: number;
}
export const stallWatch = (): StallWatch => ({ back: 0, still: 0, run: 0, best: 0, idle: 0 });

/** Seconds without getting any further before a train going back and forth counts as stalled. */
const NO_HEADWAY_S: Record<RideMode, number> = { passive: 10, driven: 30 };

/**
 * True once the train has clearly run out of speed: rolling backwards (1 s; 2.5 s on a driven
 * coaster, whose rider can still power out of it) or, on a passive one, standing still for 3 s.
 * Never in the station, on a lift or a launch, except for a train that keeps going back and
 * forth without ever getting further (falling back onto its lift or launch, again and again).
 */
export function isStalled(w: StallWatch, v: number, zone: TrackZone | null, dt: number, mode: RideMode) {
  w.run += v * dt;
  if (w.run > w.best + 0.5) {
    w.best = w.run;
    w.idle = 0;
  } else if ((w.idle += dt) > NO_HEADWAY_S[mode]) return true;
  if (zone === 'station' || zone === 'lift' || zone === 'launch') {
    w.back = w.still = 0;
    return false;
  }
  const driven = mode === 'driven';
  w.back = v < (driven ? -0.5 : -0.3) ? w.back + dt : 0;
  w.still = !driven && Math.abs(v) < 0.15 ? w.still + dt : 0;
  return w.back > (driven ? 2.5 : 1) || w.still > 3;
}

export interface RideStats {
  lengthM: number;
  maxHeightM: number;
  dropM: number;
  inversions: number;
  topSpeedKmh: number;
  maxG: number;
  minG: number;
  /** Seconds from leaving the station to coming back (when it does). */
  durationS: number;
  completes: boolean;
  /** How far the train got before it stalled (metres from the station's start). */
  stallAtM: number | null;
}

/** A driven coaster's numbers assume a steady driver: motors on below this speed (m/s), no turbo. */
export const STEADY_DRIVER = 15;

/**
 * Rides the train round once in simulation: a passive coaster on its own, a driven one with a
 * steady driver (see STEADY_DRIVER). Shapes come straight from the track.
 */
export function rideStats(t: Track, mode: RideMode): RideStats {
  let maxH = 0;
  let drop = 0;
  let top = -Infinity;
  let low = Infinity;
  let inversions = 0;
  let inverted = false;
  for (let i = 0; i < t.n; i++) {
    const y = t.pos[i * 3 + 1];
    maxH = Math.max(maxH, y);
    // the biggest single descent (climbing more than half a metre out of a dip starts a new one)
    if (y >= top || y > low + 0.5) top = low = y;
    else low = Math.min(low, y);
    drop = Math.max(drop, top - low);
    const inv = t.up[i * 3 + 1] < 0;
    if (inv && !inverted) inversions++;
    inverted = inv;
  }

  // curvature vectors (dT/ds), for the forces riders feel
  const kv = new Array<number>(t.n * 3);
  for (let i = 0; i < t.n; i++) {
    const a = (i - 1 + t.n) % t.n;
    const b = (i + 1) % t.n;
    for (let c = 0; c < 3; c++) kv[i * 3 + c] = (t.tan[b * 3 + c] - t.tan[a * 3 + c]) / (2 * DS);
  }
  const st: TrainState = { s: START_S, v: 0, launching: false };
  const watch = stallWatch();
  const dt = 1 / 120;
  let time = 0;
  let progress = 0;
  let peak = 0;
  let vmax = 0;
  let g = 1;
  let maxG = 1;
  let minG = 1;
  let completes = false;
  let stallAt: number | null = null;
  const lap = t.length - START_S;
  while (time < 900) {
    const s0 = st.s;
    const z = stepTrain(t, st, mode === 'driven' && st.v < STEADY_DRIVER ? 1 : 0, false, dt);
    time += dt;
    progress += st.s - s0;
    peak = Math.max(peak, progress);
    if (progress >= lap) {
      completes = true;
      break;
    }
    if (isStalled(watch, st.v, z, dt, mode)) {
      stallAt = START_S + peak;
      break;
    }
    vmax = Math.max(vmax, Math.abs(st.v));
    const i = Math.round(wrapIndex(t, st.s)) % t.n;
    const v2 = st.v * st.v;
    const felt = (v2 * kv[i * 3] * t.up[i * 3] + (v2 * kv[i * 3 + 1] + PHYSICS.g) * t.up[i * 3 + 1] + v2 * kv[i * 3 + 2] * t.up[i * 3 + 2]) / PHYSICS.g;
    if (Number.isFinite(felt)) g += (Math.max(-8, Math.min(16, felt)) - g) * Math.min(1, dt * 6);
    if (z !== 'station') {
      maxG = Math.max(maxG, g);
      minG = Math.min(minG, g);
    }
  }
  if (!completes && stallAt === null) stallAt = START_S + peak;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  return {
    lengthM: Math.round(t.length),
    maxHeightM: r1(maxH),
    dropM: r1(drop),
    inversions,
    topSpeedKmh: Math.round(vmax * 3.6),
    maxG: r1(maxG),
    minG: r1(minG),
    durationS: Math.round(time),
    completes,
    stallAtM: stallAt === null ? null : Math.round(stallAt),
  };
}
