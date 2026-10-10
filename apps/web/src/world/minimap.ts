import { DISTRICTS, FLIP_YAW, LAYOUT, MUSEUM, museumPoint, PARK, parkBounds, PATHS, PLAZAS, ZONES, type DistrictId, type ZoneId } from './layout';
import { FALCON_TRACK, STACK_TRACK } from './rides';
import { CIRCUIT, CIRCUIT_BOUNDS, circuitPoint, ROAD_HALF, START_S, WALL } from './attractions/speedway-track';
import { START_S as TRAIL_START, TRAIL, TRAIL_BOUNDS, TRAIL_HALF, trailPoint, WALL as TRAIL_WALL } from './attractions/trail-track';
import { PALETTE } from './textures';

type Place = { icon: string; label: string; blurb: string };

/** Every place on the map (keyed by zone, so a new zone can't be left off). */
const PLACES: Record<ZoneId, Place> = {
  entrance: { icon: '🎪', label: 'Entrance', blurb: 'The main gate and the welcome plaza' },
  coaster: { icon: '🎢', label: 'Thunder Loop', blurb: 'Drive the coaster yourself: launch, loop and roll' },
  falcon: { icon: '🦅', label: 'Sky Falcon', blurb: 'A 250 km/h cliff coaster with a 158 m drop' },
  rocket: { icon: '🚀', label: 'Rocket Ride', blurb: 'Fire six stages all the way to orbit' },
  ferris: { icon: '🎡', label: 'Giant Wheel', blurb: 'Ride 250 m up over the whole park' },
  flip: { icon: '🌀', label: 'Sky Flip', blurb: 'Swing 125 m up and flip over the top' },
  ship: { icon: '🛸', label: 'Nebula 360', blurb: 'A pendulum ship that loops all the way round' },
  speedway: { icon: '🏎️', label: 'Turbo Speedway', blurb: 'Race the karts round the circuit' },
  trail: { icon: '🚙', label: 'Rally Trail', blurb: 'A buggy time trial with jumps: today’s fastest top the leaderboard' },
  crates: { icon: '🥫', label: 'Crate Smash', blurb: 'Kick, roll and smash the crate stacks' },
  striker: { icon: '🔔', label: 'High Striker', blurb: 'Swing the hammer and ring the bell' },
  ducks: { icon: '🦆', label: 'Duck Shoot', blurb: 'Knock down the tin ducks before the clock runs out' },
  drone: { icon: '🚁', label: 'Drone Flights', blurb: 'Rent a drone and see it all from the sky' },
  booth: { icon: '🎟️', label: 'Ticket Booth', blurb: 'Free tickets, treats and souvenirs at Rosa’s counter' },
  ideas: { icon: '💡', label: 'Idea Box', blurb: 'Tell us what you’d love to see in the fair' },
  museum: { icon: '🏛️', label: 'Career Museum', blurb: 'Hasan Hmedeh’s work from 2019 to today, in framed pictures' },
};
/** The places in the order the map's legend lists them: district by district, each with its district. */
export const MAP_PLACES = (Object.entries(DISTRICTS) as [DistrictId, (typeof DISTRICTS)[DistrictId]][]).flatMap(([district, d]) =>
  d.zones.map((id) => ({ id, district, ...PLACES[id] })),
);
if (import.meta.env.DEV && new Set(MAP_PLACES.map((p) => p.id)).size !== Object.keys(PLACES).length)
  console.warn('Every zone belongs in exactly one district (DISTRICTS in layout.ts), or the map leaves it out.');

/** Pixels per metre in the pre-rendered map sheet. */
const SHEET_SCALE = 3;
/** Metres visible from the centre to the edge of the minimap. */
const VIEW = 55;

/** The area worth mapping: the park itself plus both coaster tracks, the kart circuit and the Rally Trail. */
export function fairBounds() {
  const c = CIRCUIT_BOUNDS;
  const t = TRAIL_BOUNDS;
  const p = parkBounds();
  let x0 = Math.min(p.x0, c.x0, t.x0), x1 = Math.max(p.x1, c.x1, t.x1), z0 = Math.min(p.z0, c.z0, t.z0), z1 = Math.max(p.z1, c.z1, t.z1);
  for (const d of [STACK_TRACK, FALCON_TRACK])
    for (const p of d.pos) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
  return { x0, z0, x1, z1 };
}

/**
 * Paints the fair from above: lawn, paths, plazas, coaster tracks and the big rides.
 * `X` / `Z` map world metres to canvas pixels and `s` is pixels per metre.
 * The caller fills the desert background first.
 */
export function paintFair(g: CanvasRenderingContext2D, X: (x: number) => number, Z: (z: number) => number, s: number) {
  // the fair's lawn
  g.fillStyle = '#5c9a4e';
  g.beginPath();
  g.arc(X(PARK.x), Z(PARK.z), PARK.r * s, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(29, 18, 56, 0.55)';
  g.lineWidth = 1.2 * s;
  g.stroke();

  // footpaths + plazas
  g.strokeStyle = g.fillStyle = '#efdcb6';
  g.lineCap = g.lineJoin = 'round';
  for (const p of PATHS) {
    g.lineWidth = p.width * s;
    g.beginPath();
    p.points.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
    g.stroke();
  }
  for (const [x, z, r] of PLAZAS) {
    g.beginPath();
    g.arc(X(x), Z(z), r * s, 0, Math.PI * 2);
    g.fill();
  }
  // each district's colour, round its plaza (as it's set into the paving)
  for (const { plaza: [x, z], color } of Object.values(DISTRICTS)) {
    g.strokeStyle = color;
    g.lineWidth = Math.max(1, 1.1 * s);
    g.beginPath();
    g.arc(X(x), Z(z), 6.2 * s, 0, Math.PI * 2);
    g.stroke();
  }

  // the kart circuit outside the south-west fence: its lawn, the asphalt and the start line
  const lap = (d: number) => {
    g.beginPath();
    for (let i = 0; i <= CIRCUIT.n; i++) {
      const p = circuitPoint(i * CIRCUIT.ds, d);
      if (i) g.lineTo(X(p.x), Z(p.z));
      else g.moveTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  g.fillStyle = g.strokeStyle = '#5c9a4e';
  g.lineWidth = (WALL + 3) * 2 * s;
  lap(0);
  g.fill();
  g.stroke();
  for (const [stroke, width] of [
    ['rgba(29, 18, 56, 0.6)', ROAD_HALF * 2 + 2],
    ['#4a4752', ROAD_HALF * 2],
  ] as const) {
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(width * s, 2);
    lap(0);
    g.stroke();
  }
  const a = circuitPoint(START_S, ROAD_HALF);
  const b = circuitPoint(START_S, -ROAD_HALF);
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.6 * s, 1.5);
  g.beginPath();
  g.moveTo(X(a.x), Z(a.z));
  g.lineTo(X(b.x), Z(b.z));
  g.stroke();

  // the Rally Trail outside the south fence: its meadow, the dirt and the start line
  const loop = (d: number) => {
    g.beginPath();
    for (let i = 0; i <= TRAIL.n; i++) {
      const p = trailPoint(i * TRAIL.ds, d);
      if (i) g.lineTo(X(p.x), Z(p.z));
      else g.moveTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  g.fillStyle = g.strokeStyle = '#5c9a4e';
  g.lineWidth = (TRAIL_WALL + 2) * 2 * s;
  loop(0);
  g.fill();
  g.stroke();
  for (const [stroke, width] of [
    ['rgba(29, 18, 56, 0.55)', TRAIL_HALF * 2 + 2],
    ['#a07c52', TRAIL_HALF * 2],
  ] as const) {
    g.strokeStyle = stroke;
    g.lineWidth = Math.max(width * s, 2);
    loop(0);
    g.stroke();
  }
  const ta = trailPoint(TRAIL_START, TRAIL_HALF);
  const tb = trailPoint(TRAIL_START, -TRAIL_HALF);
  g.strokeStyle = '#fff';
  g.lineWidth = Math.max(1.6 * s, 1.5);
  g.beginPath();
  g.moveTo(X(ta.x), Z(ta.z));
  g.lineTo(X(tb.x), Z(tb.z));
  g.stroke();

  // coaster tracks (dark casing under a coloured line so they read on any ground)
  for (const [d, color] of [
    [FALCON_TRACK, PALETTE.teal],
    [STACK_TRACK, PALETTE.candy],
  ] as const) {
    for (const [stroke, width] of [
      ['rgba(29, 18, 56, 0.6)', 2.6],
      [color, 1.4],
    ] as const) {
      g.strokeStyle = stroke;
      g.lineWidth = Math.max(width * s, width);
      g.beginPath();
      d.pos.forEach((p, i) => (i ? g.lineTo(X(p.x), Z(p.z)) : g.moveTo(X(p.x), Z(p.z))));
      g.closePath();
      g.stroke();
    }
  }

  // the giant wheel seen from above: the rim edge-on, the hub, and its two A-frames
  const wz = LAYOUT.ferris.z;
  g.strokeStyle = '#3a3f48';
  g.lineWidth = 1.6 * s;
  for (const side of [-1, 1])
    for (const sx of [-1, 1]) {
      g.beginPath();
      g.moveTo(X(LAYOUT.ferris.x + sx * 56), Z(wz + side * 40));
      g.lineTo(X(LAYOUT.ferris.x), Z(wz + side * 22));
      g.stroke();
    }
  g.strokeStyle = '#e9edf2';
  g.lineWidth = 3 * s;
  g.beginPath();
  g.moveTo(X(LAYOUT.ferris.x - 124), Z(wz));
  g.lineTo(X(LAYOUT.ferris.x + 124), Z(wz));
  g.stroke();

  // the Career Museum from above: its glass roof (with the ridge down the middle) and the porch
  const m = MUSEUM;
  const outline = (hw: number, z0: number, z1: number) => {
    g.beginPath();
    for (const [lx, lz] of [[-hw, z0], [hw, z0], [hw, z1], [-hw, z1]]) {
      const p = museumPoint(lx, lz);
      g.lineTo(X(p.x), Z(p.z));
    }
    g.closePath();
  };
  outline(m.halfW + m.wall + 0.35, -m.halfL - m.wall - 0.35, m.halfL + m.wall + 0.35);
  g.fillStyle = '#bcd9e6';
  g.fill();
  g.strokeStyle = 'rgba(29, 18, 56, 0.6)';
  g.lineWidth = Math.max(0.8 * s, 1);
  g.stroke();
  outline(m.halfW + m.wall + 0.3, m.halfL + m.wall, m.halfL + m.wall + m.porch);
  g.fillStyle = '#f7f0e2';
  g.fill();
  g.stroke();
  const a0 = museumPoint(0, -m.halfL - m.wall);
  const a1 = museumPoint(0, m.halfL + m.wall);
  g.beginPath();
  g.moveTo(X(a0.x), Z(a0.z));
  g.lineTo(X(a1.x), Z(a1.z));
  g.stroke();

  // the Sky Flip from above: its fenced swing and the tower
  const along = { x: Math.cos(FLIP_YAW), z: -Math.sin(FLIP_YAW) };
  const out = { x: Math.sin(FLIP_YAW), z: Math.cos(FLIP_YAW) };
  const fp = (lx: number, lz: number) => [X(LAYOUT.flip.x + along.x * lx + out.x * lz), Z(LAYOUT.flip.z + along.z * lx + out.z * lz)] as const;
  g.fillStyle = 'rgba(255, 138, 61, 0.35)';
  g.beginPath();
  for (const [lx, lz] of [[-26, -4], [26, -4], [26, 16], [-26, 16]]) g.lineTo(...fp(lx, lz));
  g.fill();
  g.strokeStyle = PALETTE.candy;
  g.lineWidth = 2.4 * s;
  g.beginPath();
  g.moveTo(...fp(-60, 3.6));
  g.lineTo(...fp(60, 3.6));
  g.stroke();
  g.fillStyle = '#3a3f48';
  g.beginPath();
  g.arc(...fp(0, 0), 2.6 * s, 0, Math.PI * 2);
  g.fill();
}

/** The visitor's arrow, drawn at the current origin (heading 0 faces up / -z). */
export function paintVisitor(g: CanvasRenderingContext2D, heading: number, size = 1) {
  g.save();
  g.rotate(-heading);
  g.scale(size, size);
  g.fillStyle = PALETTE.candy;
  g.strokeStyle = '#fff';
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(6.5, 7);
  g.lineTo(0, 3.5);
  g.lineTo(-6.5, 7);
  g.closePath();
  g.fill();
  g.stroke();
  g.restore();
}

/** Moving coaster trains as small dots. */
export function paintTrain(g: CanvasRenderingContext2D, x: number, y: number, color: string, r = 3.5) {
  g.fillStyle = color;
  g.strokeStyle = '#1d1238';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
  g.stroke();
}

/**
 * North-up circular minimap in the bottom-left corner. The whole fair is drawn once
 * into an offscreen sheet; each frame we just blit a window of it around the visitor.
 * Click / tap it (or press M) to open the full-screen park map.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private sheet = document.createElement('canvas');
  private bounds = { x0: 0, z0: 0, x1: 0, z1: 0 };
  private sheetScale = 1;
  private size = 0;
  private dpr = 1;
  private centre = { x: 0, z: 0 };
  /** Attractions closed for maintenance: their icon sits on a red disc. */
  closed: ReadonlySet<ZoneId> = new Set();
  onOpen: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.canvas = root.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    this.drawSheet();
    root.addEventListener('click', () => this.onOpen?.());
  }

  private drawSheet() {
    const b = fairBounds();
    const pad = VIEW;
    this.bounds = { x0: b.x0 - pad, z0: b.z0 - pad, x1: b.x1 + pad, z1: b.z1 + pad };
    const w = Math.ceil((this.bounds.x1 - this.bounds.x0) * SHEET_SCALE);
    const h = Math.ceil((this.bounds.z1 - this.bounds.z0) * SHEET_SCALE);
    // stay well inside canvas limits on low-end devices
    const k = Math.min(1, 4096 / Math.max(w, h));
    this.sheet.width = Math.round(w * k);
    this.sheet.height = Math.round(h * k);
    const s = SHEET_SCALE * k;
    this.sheetScale = s;
    const g = this.sheet.getContext('2d')!;
    // desert / outland
    g.fillStyle = '#c9a774';
    g.fillRect(0, 0, this.sheet.width, this.sheet.height);
    paintFair(g, (x) => (x - this.bounds.x0) * s, (z) => (z - this.bounds.z0) * s, s);
  }

  private resize() {
    const size = this.canvas.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (size === this.size && dpr === this.dpr) return;
    this.size = size;
    this.dpr = dpr;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
  }

  /** Converts a world position to minimap CSS pixels (relative to the canvas). */
  private toMap(x: number, z: number) {
    const k = this.size / 2 / VIEW;
    return { x: this.size / 2 + (x - this.centre.x) * k, y: this.size / 2 + (z - this.centre.z) * k };
  }

  update(car: { x: number; z: number; heading: number }, trains: { x: number; z: number; color: string }[]) {
    this.resize();
    if (!this.size) return;
    this.centre.x = car.x;
    this.centre.z = car.z;

    const g = this.g;
    const S = this.size;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    g.clip();

    // blit the window of the sheet around the centre
    const s = this.sheetScale;
    const sx = (this.centre.x - VIEW - this.bounds.x0) * s;
    const sz = (this.centre.z - VIEW - this.bounds.z0) * s;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.sheet, sx, sz, VIEW * 2 * s, VIEW * 2 * s, 0, 0, S, S);

    // moving coaster trains
    for (const t of trains) {
      const p = this.toMap(t.x, t.z);
      paintTrain(g, p.x, p.y, t.color);
    }

    // attraction icons
    const iconSize = Math.round(Math.max(12, Math.min(18, S / 11)));
    g.font = `${iconSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const { id, icon } of MAP_PLACES) {
      const p = this.toMap(ZONES[id].x, ZONES[id].z);
      if (p.x < -10 || p.y < -10 || p.x > S + 10 || p.y > S + 10) continue;
      const shut = this.closed.has(id);
      g.fillStyle = shut ? 'rgba(255, 77, 109, 0.95)' : 'rgba(255, 245, 227, 0.92)';
      g.beginPath();
      g.arc(p.x, p.y, iconSize * 0.72, 0, Math.PI * 2);
      g.fill();
      if (shut) {
        g.strokeStyle = PALETTE.cream;
        g.lineWidth = 2;
        g.stroke();
      }
      g.fillStyle = '#000';
      g.fillText(icon, p.x, p.y + 1);
    }

    // the visitor
    const c = this.toMap(car.x, car.z);
    g.translate(c.x, c.y);
    paintVisitor(g, car.heading);
    g.restore();

    // north marker
    g.fillStyle = 'rgba(255, 245, 227, 0.9)';
    g.font = `700 10px "DM Sans", sans-serif`;
    g.fillText('N', S / 2, 9);
  }
}
