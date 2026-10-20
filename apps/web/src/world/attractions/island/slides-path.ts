// Splash Tower's three slides as paths and physics. Each slide is a list of pieces (straights,
// turns about world up that keep the current grade, so a turn while descending is a helix, and
// pitch changes) that a turtle integrates into the flume's centreline, like the coaster's track
// builder (track.ts) but open-ended: from the tower's deck to the lip over the splash pool.
//
// The rider is a bead on the flume's circular cross-section: the apparent gravity (gravity minus
// the centreline's centripetal acceleration) swings them up the wall in a curve, the wall's
// normal force sets the water friction and the G they feel. Every slide is simulated once at
// build time without input; the walls are raised where that run swings high (as real slide
// designers set wall heights from a simulation), and the ghost riders replay it.
//
// Self-contained (only depends on three), so the layouts can be checked from a Node script.
import * as THREE from 'three';

/** Sample spacing along a slide (m). */
export const DS = 0.25;
export const G = 9.81;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

/**
 * What a stretch of flume is: an open trough, an enclosed tube (opaque or clear), or the
 * Kamikaze's splash lane (a shallow run-out channel of standing water that brakes the rider).
 */
export type Section = 'open' | 'tube' | 'clear' | 'lane';

export type Piece = (
  | { t: 'straight'; len: number }
  | { t: 'turn'; angle: number; radius: number }
  | { t: 'pitch'; angle: number; radius: number }
) & { sec?: Section };

export type SlideId = 'kamikaze' | 'typhoon' | 'lazy';

export interface SlideSpec {
  id: SlideId;
  /** 1, 2, 3: the picker's keys and the `slide` stat. */
  n: 1 | 2 | 3;
  name: string;
  /** The flume's inner radius (m): a body slide's tube, or the family raft slide's wide trough. */
  radius: number;
  /** Where the rider's centre runs, this far in from the wall (lying on a mat, sitting in a ring). */
  inset: number;
  /** Water friction coefficient on the wall, and air drag k (a = k·v²). */
  mu: number;
  drag: number;
  /** Start of the centreline (local to the attraction) and the heading (deg, clockwise from north). */
  start: { x: number; y: number; z: number };
  heading: number;
  pieces: Piece[];
  /** Body colour of the fibreglass, its stripe, and the night LEDs along the lips. */
  colour: string;
  stripe: string;
  led: string;
}

export interface SlidePath {
  spec: SlideSpec;
  pos: THREE.Vector3[];
  tan: THREE.Vector3[];
  /** The cross-section's up (no banking: the flume is level across, the rider does the banking). */
  up: THREE.Vector3[];
  right: THREE.Vector3[];
  /** Curvature vector dT/ds (points to the centre of the bend, 1/radius long). */
  curv: THREE.Vector3[];
  sec: Section[];
  length: number;
  /** Per sample: how far up each wall the trough goes (radians from the bottom; π = closed). */
  lipL: number[];
  lipR: number[];
}

/**
 * Builds the centreline: the turtle walks the pieces in DS steps. Frames are kept level across
 * (right is horizontal), which is how slides are built: fibreglass sections bolted on the level,
 * the banking coming from the rider climbing the wall.
 */
export function buildSlide(spec: SlideSpec): SlidePath {
  const pos: THREE.Vector3[] = [];
  const sec: Section[] = [];
  const p = new THREE.Vector3(spec.start.x, spec.start.y, spec.start.z);
  let heading = spec.heading * DEG;
  let pitch = 0;
  const dir = () => new THREE.Vector3(Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch));
  const push = (s: Section) => {
    pos.push(p.clone());
    sec.push(s);
  };
  for (const e of spec.pieces) {
    const s = e.sec ?? 'open';
    if (e.t === 'straight') {
      const n = Math.max(1, Math.round(e.len / DS));
      for (let i = 0; i < n; i++) {
        push(s);
        p.addScaledVector(dir(), DS);
      }
    } else {
      const total = e.angle * DEG;
      const n = Math.max(1, Math.round((Math.abs(total) * e.radius) / DS));
      for (let i = 0; i < n; i++) {
        push(s);
        p.addScaledVector(dir(), DS);
        // a turn's angle is measured in plan view: positive turns left (anticlockwise from above)
        if (e.t === 'turn') heading -= total / n;
        else pitch += total / n;
      }
    }
  }
  push(spec.pieces[spec.pieces.length - 1].sec ?? 'open');

  const n = pos.length;
  const tan: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const a = pos[Math.max(0, i - 1)];
    const b = pos[Math.min(n - 1, i + 1)];
    tan.push(b.clone().sub(a).normalize());
  }
  const right = tan.map((t) => new THREE.Vector3().crossVectors(t, UP).normalize());
  const up = tan.map((t, i) => new THREE.Vector3().crossVectors(right[i], t).normalize());
  // curvature from the tangents two samples apart (smoothed over three, so piece joins don't spike)
  const raw = tan.map((_, i) => {
    const a = tan[Math.max(0, i - 2)];
    const b = tan[Math.min(n - 1, i + 2)];
    const span = (Math.min(n - 1, i + 2) - Math.max(0, i - 2)) * DS;
    return b.clone().sub(a).divideScalar(span);
  });
  const curv = raw.map((_, i) => raw[Math.max(0, i - 1)].clone().add(raw[i]).add(raw[Math.min(n - 1, i + 1)]).divideScalar(3));
  const closed = (s: Section) => s === 'tube' || s === 'clear';
  const path: SlidePath = {
    spec,
    pos,
    tan,
    up,
    right,
    curv,
    sec,
    length: (n - 1) * DS,
    lipL: sec.map((s) => (closed(s) ? Math.PI : 0)),
    lipR: sec.map((s) => (closed(s) ? Math.PI : 0)),
  };
  setLips(path);
  return path;
}

/**
 * Raises the open troughs' walls where the design run (no input) swings the rider high: the
 * outer wall of a curve goes up to 40° above the highest the rider got, never lower than 80°,
 * and the walls ease along the slide so they read as moulded sections, not steps.
 */
function setLips(path: SlidePath) {
  const run = simulate(path, null, 1 / 240);
  const n = path.pos.length;
  const want = (side: 1 | -1) => {
    const out = new Array<number>(n).fill(80 * DEG);
    for (const r of run.samples) {
      const i = Math.round(r.s / DS);
      for (let k = Math.max(0, i - 24); k <= Math.min(n - 1, i + 24); k++) {
        const swing = Math.max(0, side * r.phi);
        out[k] = Math.max(out[k], Math.min(150 * DEG, swing + 40 * DEG));
      }
    }
    // ease the steps (a moving average over ±3 m)
    const eased = out.map((_, i) => {
      let sum = 0;
      let c = 0;
      for (let k = Math.max(0, i - 12); k <= Math.min(n - 1, i + 12); k++) {
        sum += out[k];
        c++;
      }
      return sum / c;
    });
    return eased;
  };
  const r = want(1);
  const l = want(-1);
  for (let i = 0; i < n; i++) {
    if (path.lipR[i] === Math.PI) continue;
    path.lipR[i] = r[i];
    path.lipL[i] = l[i];
  }
}

export interface Frame {
  p: THREE.Vector3;
  t: THREE.Vector3;
  u: THREE.Vector3;
  r: THREE.Vector3;
  k: THREE.Vector3;
}
export const frame = (): Frame => ({ p: new THREE.Vector3(), t: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3(), k: new THREE.Vector3() });

/** The centreline's frame at arc length s (clamped to the slide). */
export function sampleSlide(path: SlidePath, s: number, out: Frame) {
  const n = path.pos.length;
  const x = THREE.MathUtils.clamp(s / DS, 0, n - 1.0001);
  const i = Math.floor(x);
  const j = i + 1;
  const k = x - i;
  out.p.copy(path.pos[i]).lerp(path.pos[j], k);
  out.t.copy(path.tan[i]).lerp(path.tan[j], k).normalize();
  out.r.crossVectors(out.t, UP).normalize();
  out.u.crossVectors(out.r, out.t).normalize();
  out.k.copy(path.curv[i]).lerp(path.curv[j], k);
  return out;
}

export function sectionAt(path: SlidePath, s: number): Section {
  return path.sec[THREE.MathUtils.clamp(Math.round(s / DS), 0, path.sec.length - 1)];
}

/** The rider: arc length, speed, and the swing round the cross-section (rad from the bottom, + up the right wall). */
export interface RiderState {
  s: number;
  v: number;
  phi: number;
  omega: number;
  /** The wall's push on the rider (m/s²): the G they feel is this over g. */
  normal: number;
}

/** The rider's body English: tuck (+1, arms crossed, heels together) or spread out to brake (−1), and lean (−1 left .. +1 right). */
export interface RiderInput {
  tuck: number;
  lean: number;
}

const tmp = frame();
const A = new THREE.Vector3();

/** One physics step; returns false once the rider has run off the end of the flume. */
export function stepRider(path: SlidePath, st: RiderState, inp: RiderInput | null, dt: number) {
  const spec = path.spec;
  const f = sampleSlide(path, st.s, tmp);
  const sec = sectionAt(path, st.s);
  const Re = spec.radius - spec.inset;
  // apparent gravity in the centreline's frame: gravity minus the bend's centripetal acceleration
  A.set(0, -G, 0).addScaledVector(f.k, -st.v * st.v);
  const ar = A.dot(f.r);
  const au = A.dot(f.u);
  const tuck = inp ? THREE.MathUtils.clamp(inp.tuck, -1, 1) : 0;
  const lean = inp ? THREE.MathUtils.clamp(inp.lean, -1, 1) * 1.6 : 0;
  const c = Math.cos(st.phi);
  const sn = Math.sin(st.phi);
  // the swing: a bead on a circle, with the water and the rider's body soaking up the sway
  const alpha = (ar * c + au * sn + lean * c) / Re - 2.2 * st.omega;
  st.omega += alpha * dt;
  st.phi += st.omega * dt;
  const lipR = path.lipR[Math.min(path.lipR.length - 1, Math.round(st.s / DS))];
  const lipL = path.lipL[Math.min(path.lipL.length - 1, Math.round(st.s / DS))];
  // an open trough's lip: the rider rides up against the wall's top and slides back
  if (st.phi > lipR - 0.25) {
    st.phi = lipR - 0.25;
    st.omega = Math.min(0, st.omega) * 0.3;
  } else if (st.phi < -(lipL - 0.25)) {
    st.phi = -(lipL - 0.25);
    st.omega = Math.max(0, st.omega) * 0.3;
  }
  // the wall's push, outward from the axis through the rider
  const nr = Math.sin(st.phi);
  const nu = -Math.cos(st.phi);
  st.normal = Math.max(0, ar * nr + au * nu + Re * st.omega * st.omega);
  const mu = spec.mu * (tuck > 0 ? 1 - 0.3 * tuck : 1 - 0.9 * tuck);
  const drag = spec.drag * (tuck > 0 ? 1 - 0.25 * tuck : 1 - 0.6 * tuck);
  let a = -G * f.t.y - drag * st.v * Math.abs(st.v) - mu * st.normal * Math.sign(st.v);
  // the splash lane's standing water ploughs the rider to a gentle speed
  if (sec === 'lane') a -= 0.075 * st.v * Math.abs(st.v) + 0.4 * Math.sign(st.v);
  st.v += a * dt;
  // a slide never runs backwards: at worst the rider is stuck and scoots along (the start's lip, a flat run-out)
  if (st.v < 0.8) st.v = 0.8;
  st.s += st.v * dt;
  return st.s < path.length;
}

export interface RunSample {
  t: number;
  s: number;
  v: number;
  phi: number;
  g: number;
}

export interface Run {
  samples: RunSample[];
  duration: number;
  topSpeed: number;
  maxG: number;
  exitSpeed: number;
}

/** Runs a rider down the slide (with no input when `inp` is null) from the push-off. */
export function simulate(path: SlidePath, inp: RiderInput | null, dt = 1 / 120): Run {
  const st: RiderState = { s: 0, v: 1.6, phi: 0, omega: 0, normal: G };
  const samples: RunSample[] = [];
  let t = 0;
  let top = 0;
  let maxG = 1;
  let next = 0;
  let gs = 1;
  while (t < 300) {
    const going = stepRider(path, st, inp, dt);
    t += dt;
    top = Math.max(top, st.v);
    gs += (st.normal / G - gs) * Math.min(1, dt * 8);
    maxG = Math.max(maxG, gs);
    if (t >= next || !going) {
      samples.push({ t, s: Math.min(st.s, path.length), v: st.v, phi: st.phi, g: gs });
      next += 1 / 30;
    }
    if (!going) break;
  }
  return { samples, duration: t, topSpeed: top, maxG, exitSpeed: st.v };
}

// ---------------------------------------------------------------------------------------------
// The layout, local to the attraction's anchor (ISLAND_SPOTS.slides): the tower stands north of
// the splash pool, its deck 24 m up. The Kamikaze drops off the south face straight into its
// splash lane; the Typhoon leaves west and corkscrews down a helix inside a tube; the Lazy Loop
// leaves east, swings round a big descending loop that passes under itself, and wiggles down to
// the pool. All three end on the pool's north wall, side by side, heading south.
// ---------------------------------------------------------------------------------------------

/** The tower's centre (local x, z), its deck's height and half-width. */
export const TOWER = { x: 0, z: -34, deck: 24, half: 4.5 };
/** The splash pool (local rectangle) and its water's height (a raised pool, its coping at `rim`). */
export const POOL = { x0: -30, x1: 30, z0: 30, z1: 60, water: 0.85, rim: 1.1 };

export const SLIDES: SlideSpec[] = [
  {
    id: 'kamikaze',
    n: 1,
    name: 'Kamikaze',
    radius: 0.62,
    inset: 0.16,
    mu: 0.035,
    drag: 0.0016,
    start: { x: 0, y: TOWER.deck + 0.05 + 0.62, z: TOWER.z + TOWER.half - 0.6 },
    heading: 180,
    pieces: [
      { t: 'straight', len: 2.2 },
      { t: 'pitch', angle: -52, radius: 5.5 },
      { t: 'straight', len: 15.6 },
      { t: 'pitch', angle: 52, radius: 26 },
      { t: 'straight', len: 3 },
      { t: 'straight', len: 25.4, sec: 'lane' },
    ],
    colour: '#e8333b',
    stripe: '#ffffff',
    led: '#ff4a5a',
  },
  {
    id: 'typhoon',
    n: 2,
    name: 'Typhoon',
    radius: 0.7,
    inset: 0.17,
    mu: 0.04,
    drag: 0.0018,
    start: { x: TOWER.x - TOWER.half + 0.6, y: TOWER.deck + 0.05 + 0.7, z: TOWER.z },
    heading: 270,
    pieces: [
      { t: 'straight', len: 2.4 },
      { t: 'pitch', angle: -14, radius: 8, sec: 'tube' },
      { t: 'straight', len: 7, sec: 'tube' },
      { t: 'turn', angle: 360, radius: 7.2, sec: 'clear' },
      { t: 'straight', len: 3, sec: 'tube' },
      { t: 'turn', angle: -50, radius: 9, sec: 'tube' },
      { t: 'turn', angle: 140, radius: 8.5, sec: 'clear' },
      { t: 'pitch', angle: 4, radius: 20, sec: 'tube' },
      { t: 'straight', len: 9, sec: 'tube' },
      { t: 'turn', angle: -35, radius: 12, sec: 'clear' },
      { t: 'turn', angle: 35, radius: 12, sec: 'clear' },
      { t: 'straight', len: 6, sec: 'tube' },
      { t: 'pitch', angle: 10, radius: 10, sec: 'tube' },
      { t: 'straight', len: 2.2 },
    ],
    colour: '#1e7fd6',
    stripe: '#ffd23d',
    led: '#3fb8ff',
  },
  {
    id: 'lazy',
    n: 3,
    name: 'Lazy Loop',
    radius: 1.25,
    inset: 0.45,
    mu: 0.05,
    drag: 0.0028,
    start: { x: TOWER.x + TOWER.half - 0.6, y: TOWER.deck + 0.05 + 1.25, z: TOWER.z },
    heading: 90,
    pieces: [
      { t: 'straight', len: 3 },
      { t: 'pitch', angle: -9, radius: 14 },
      { t: 'straight', len: 3 },
      { t: 'turn', angle: -90, radius: 13 },
      { t: 'straight', len: 7 },
      { t: 'turn', angle: 360, radius: 11 },
      { t: 'straight', len: 5 },
      { t: 'turn', angle: -40, radius: 12 },
      { t: 'turn', angle: 40, radius: 12 },
      { t: 'straight', len: 10 },
      { t: 'pitch', angle: 9, radius: 14 },
      { t: 'straight', len: 2 },
    ],
    colour: '#ffb12b',
    stripe: '#ff5d7a',
    led: '#ffd23d',
  },
];
