import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { isPlot } from '../account/api';
import { CHECKIN, DESK_Z, DOORS, GATES, INFO_DESK, KERB_Z, RECLAIM, SECURITY } from './airport/terminal-plan';
import { shadowed, staticCylinder, std, type Ctx } from './context';
import { Obstacles } from './crowd/obstacles';
import { ISLAND_SPOTS, SKYLINK, regionAt, type Region } from './geo';
import { DISTRICTS, LAYOUT, onFootprint, onPath, PLAZAS, ZONES, type DistrictId } from './layout';
import { nearTrack } from './rides';
import { DISPLAY_FONT, PALETTE, signMaterial, signTexture } from './textures';

/** Where an arm on a fingerpost points: its label, its colour, and the place it points at. */
type Arm = { label: string; color: string; x: number; z: number };

const district = (id: DistrictId): Arm => {
  const d = DISTRICTS[id];
  // the main gate's arm points at the entrance itself
  const [x, z] = id === 'gate' ? [ZONES.entrance.x, ZONES.entrance.z] : d.plaza;
  return { label: `${d.icon} ${d.name}`, color: d.color, x, z };
};
/** An arm to a place (its ring), labelled with its own title unless given one. */
const place = (id: keyof typeof ZONES, icon: string, label = ZONES[id].title, color: string = DISTRICTS.lagoon.color): Arm => ({ label: `${icon} ${label}`, color, x: ZONES[id].x, z: ZONES[id].z });

const AIR = DISTRICTS.airport.color;
const ISLE = DISTRICTS.palmport.color;
/** The gates either side of gate 3 (the flight's), so the concourse's arms point down each wing to their middle. */
const wing = (side: -1 | 1): Arm => {
  const here = ZONES.flight.x;
  const gs = GATES.filter((g) => Math.sign(g.sx - here) === side).sort((a, b) => a.gate - b.gate);
  const nums = gs.map((g) => g.gate);
  const label = nums.length > 1 ? `✈️ Gates ${nums[0]}–${nums[nums.length - 1]}` : `✈️ Gate ${nums[0]}`;
  const x = gs.reduce((sum, g) => sum + g.sx, 0) / Math.max(1, gs.length);
  return { label, color: AIR, x, z: DESK_Z };
};

/** Every arm's target. */
const ARMS = {
  // the fair
  ...(Object.fromEntries((['gate', 'midway', 'falcon', 'cosmos', 'thrill', 'motor', 'valley'] as DistrictId[]).map((id) => [id, district(id)])) as Record<DistrictId, Arm>),
  hub: { label: '🎠 The Hub', color: PALETTE.violet, x: LAYOUT.carousel.x, z: LAYOUT.carousel.z },
  wheel: { label: '🎡 Giant Wheel', color: PALETTE.sky, x: ZONES.ferris.x, z: ZONES.ferris.z },
  // the airport is a SkyLink ride away: its arm points at the park's station
  toAirport: { label: '✈️ Airport · SkyLink', color: AIR, x: SKYLINK.park.x, z: SKYLINK.park.z },
  // in the terminal
  gates: { label: '✈️ Gates 1–6', color: AIR, x: (SECURITY.lanes[0] + SECURITY.lanes[SECURITY.lanes.length - 1]) / 2, z: SECURITY.screenZ },
  gatesWest: wing(-1),
  gatesEast: wing(1),
  gate3: { label: '✈️ Gate 3 · FA101', color: PALETTE.candy, x: ZONES.flight.x, z: ZONES.flight.z },
  checkIn: { label: '🧳 Check-in', color: '#2ec4b6', x: CHECKIN.xs[1], z: (CHECKIN.z0 + CHECKIN.z1) / 2 },
  reclaim: { label: '🛄 Baggage reclaim', color: '#ffb627', x: RECLAIM.exitX, z: RECLAIM.z0 },
  wayOut: { label: '🚪 Way out', color: '#ffb627', x: RECLAIM.entryX, z: RECLAIM.z1 },
  info: { label: 'ℹ️ Information', color: '#4a90d9', x: INFO_DESK.x, z: INFO_DESK.z },
  exit: { label: '🚕 Exit · Taxis · Car park', color: '#4a90d9', x: DOORS.find((d) => d.kind === 'departures')!.x, z: KERB_Z },
  toFair: { label: '🚝 SkyLink to the fair', color: PALETTE.teal, x: SKYLINK.airport.x, z: SKYLINK.airport.z },
  // on Palm Cay: each game in a colour of its own, so the arms tell apart at a glance
  jetski: place('jetski', '🚤', undefined, '#ff7a3d'),
  slides: place('slides', '🌊', undefined, '#3f8cff'),
  cannons: place('cannons', '🏴‍☠️', undefined, '#8a5a3c'),
  volley: place('volley', '🏐', undefined, '#ff4d6d'),
  beach: { label: '🏖️ The Beach', color: '#e8b04a', x: ISLAND_SPOTS.jetski.x - 120, z: 41436 },
  beachPlaza: { label: '⛲ Beach Plaza', color: DISTRICTS.lagoon.color, x: ISLAND_SPOTS.plaza.x, z: ISLAND_SPOTS.plaza.z },
  islandAirport: place('flightBack', '✈️', 'Airport · Gate 2', ISLE),
} satisfies Record<string, Arm>;
type Target = keyof typeof ARMS;

/**
 * The fingerposts where the main paths meet, region by region: where, how far round it to look
 * for a free spot, what each arm points to (top arm first), and (`toward`) which side of the ring
 * to try first when the side facing the region's middle is the walking line itself. Inside the
 * terminal they stand in the halls' open floor (the colliders round them must exist before this
 * is built).
 */
const FINGERPOSTS: { at: [number, number]; r: number; arms: Target[]; toward?: [number, number] }[] = [
  // the fair
  { at: [LAYOUT.carousel.x, LAYOUT.carousel.z], r: 15.4, arms: ['cosmos', 'falcon', 'thrill', 'valley', 'midway', 'motor', 'gate', 'toAirport'] },
  { at: [DISTRICTS.gate.plaza[0], DISTRICTS.gate.plaza[1]], r: 9.4, arms: ['hub', 'midway', 'motor', 'toAirport', 'gate'] },
  { at: [0, -112], r: 9.4, arms: ['wheel', 'cosmos', 'thrill', 'falcon', 'hub'] },
  // Funfair International: in the hall, beside the line from the main doors to security; and on
  // the concourse by gate 3
  { at: [ZONES.airport.x, ZONES.airport.z + 6], r: 8, arms: ['gates', 'checkIn', 'info', 'reclaim', 'exit', 'toFair'], toward: [ZONES.airport.x + 40, ZONES.airport.z + 6] },
  { at: [ZONES.flight.x + 9, 518], r: 3, arms: ['gate3', 'gatesWest', 'gatesEast', 'wayOut'] },
  // Palm Cay: the arrivals plaza, and the Beach Plaza where the paths to the games start
  { at: [ZONES.palmcay.x, ZONES.palmcay.z + 22], r: 9, arms: ['beachPlaza', 'slides', 'cannons', 'volley', 'jetski', 'beach', 'islandAirport'] },
  { at: [ISLAND_SPOTS.plaza.x, ISLAND_SPOTS.plaza.z], r: 30, arms: ['slides', 'cannons', 'volley', 'jetski', 'beach', 'islandAirport'] },
];

/**
 * Where a district's sign stands, when not just outside its plaza's ring on the side facing the
 * region's middle: the island's plazas are big, with a fountain in the Beach Plaza's middle, and
 * the arrivals plaza's side facing the beach is where everyone walks from the doors to the
 * promenade, so its sign stands off to the west of that line, facing the doors.
 */
const SIGN_AT: Partial<Record<DistrictId, { r: number; toward?: [number, number] }>> = {
  palmport: { r: 22, toward: [-40, DISTRICTS.palmport.plaza[1] + 20] },
  lagoon: { r: 30 },
};

/** What the signs face from: each region's middle (the carousel; Palm Cay's Beach Plaza). */
const CENTRE: Record<Region, { x: number; z: number }> = { home: LAYOUT.carousel, island: ISLAND_SPOTS.plaza };

/** Pixels of one arm's board in the posts' texture atlases. */
const ARM_W = 760;
const ARM_H = 144;

/**
 * The world's signposting, so the plan reads on the ground as well as on the map: a tall sign at
 * each district's plaza, in the district's colour, naming it and what's there; and fingerposts
 * where the main paths meet, with an arm pointing towards each district or place, in the fair,
 * in the airport's halls and on Palm Cay. Each one finds itself a free spot at the edge of its
 * plaza (off the paths, clear of lamps, stalls, trees, rides and walls).
 */
export class Wayfinding {
  private obstacles: Obstacles;
  private taken: [number, number][] = [];

  constructor(private ctx: Ctx) {
    this.obstacles = new Obstacles(ctx.world);
    for (const [id, d] of Object.entries(DISTRICTS) as [DistrictId, (typeof DISTRICTS)[DistrictId]][]) {
      // the terminal has its own signs over its halls
      if (id === 'airport') continue;
      const plaza = PLAZAS.find(([x, z]) => x === d.plaza[0] && z === d.plaza[1]);
      const at = SIGN_AT[id];
      const spot = this.spot(d.plaza[0], d.plaza[1], at?.r ?? (plaza?.[2] ?? 8) + 1.6, 1.6, at?.toward);
      if (spot) this.districtSign(id, spot);
    }
    for (const f of FINGERPOSTS) {
      const spot = this.spot(f.at[0], f.at[1], f.r, 1, f.toward);
      if (spot) this.fingerpost(spot, f.arms);
    }
  }

  /**
   * A free spot on a ring of radius r round (x, z), as near the side facing `toward` (by default its
   * region's middle) as can be.
   */
  private spot(x: number, z: number, r: number, clearance: number, toward?: [number, number]) {
    const [cx, cz] = toward ?? [CENTRE[regionAt(x, z)].x, CENTRE[regionAt(x, z)].z];
    const inward = Math.atan2(cz - z, cx - x);
    for (let k = 0; k < 48; k++) {
      // try either side of the inward direction, a little further round each time
      const a = inward + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 24);
      const sx = x + Math.cos(a) * r;
      const sz = z + Math.sin(a) * r;
      if (onPath(sx, sz, clearance) || onFootprint(sx, sz, 3) || nearTrack(sx, sz, 4)) continue;
      if (this.obstacles.inside(sx, sz, clearance + 0.4)) continue;
      if (this.taken.some(([tx, tz]) => Math.hypot(tx - sx, tz - sz) < 4)) continue;
      this.taken.push([sx, sz]);
      return { x: sx, z: sz, face: Math.atan2(x - sx, z - sz) };
    }
    return null;
  }

  /** A tall double-sided sign in the district's colour: its name, and the attractions there. */
  private districtSign(id: DistrictId, at: { x: number; z: number; face: number }) {
    const d = DISTRICTS[id];
    const g = new THREE.Group();
    const iron = std('#2c2433', { metalness: 0.7, roughness: 0.4 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 6.4, 12), iron);
    post.position.y = 3.2;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.3, 16), std(d.color, { roughness: 0.6 }));
    foot.position.y = 0.15;
    // (the valley's plots change hands: its sign names what's always there)
    const names = d.zones.filter((z) => z !== 'entrance' && !isPlot(z) && ZONES[z].radius > 0).map((z) => ZONES[z].title);
    if (id === 'valley') names.push('Coasters built by members');
    const tex = signTexture(`${d.icon} ${d.name.toUpperCase()}`, { sub: names.join(' · '), border: d.color, width: 1024, height: 448 });
    const mat = signMaterial(tex);
    for (const side of [0, Math.PI]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.575), mat);
      board.position.set(0, 5.6, side ? -0.06 : 0.06);
      board.rotation.y = side;
      g.add(board);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.7, 1.66, 0.1), std(d.color, { roughness: 0.6 }));
    back.position.y = 5.6;
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), std(PALETTE.mustard, { metalness: 0.8, roughness: 0.25 }));
    finial.position.y = 6.62;
    g.add(post, foot, back, finial);
    g.position.set(at.x, 0, at.z);
    g.rotation.y = at.face;
    shadowed(g);
    this.ctx.scene.add(g);
    staticCylinder(this.ctx, at.x, at.z, 0.3, 3);
  }

  /**
   * A signpost with an arm pointing towards each target, the first at the top. All its arms'
   * boards (both faces) share one texture and one merged mesh: a post is three draw calls.
   */
  private fingerpost(at: { x: number; z: number }, arms: Target[]) {
    const g = new THREE.Group();
    const wood = std('#7a5236', { roughness: 0.8 });
    const top = 1.5 + arms.length * 0.4;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, top + 0.4, 10), wood);
    post.position.y = (top + 0.4) / 2;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.3, 10), std(PALETTE.candy, { roughness: 0.5 }));
    cap.position.y = top + 0.55;
    g.add(post, cap);

    // the atlas: a row per face, front faces first
    const rows = arms.length * 2;
    const canvas = document.createElement('canvas');
    canvas.width = ARM_W;
    canvas.height = ARM_H * rows;
    const cg = canvas.getContext('2d')!;
    const boards: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    arms.forEach((id, i) => {
      const t = ARMS[id];
      const angle = Math.atan2(-(t.z - at.z), t.x - at.x); // local +x towards the target
      for (const back of [false, true]) {
        const row = i * 2 + (back ? 1 : 0);
        cg.save();
        cg.translate(0, row * ARM_H);
        paintArm(cg, t.label, t.color, back);
        cg.restore();
        const face = new THREE.PlaneGeometry(1.9, 0.36);
        // this face's row of the atlas (v runs bottom-up)
        const uv = face.attributes.uv as THREE.BufferAttribute;
        const v0 = 1 - (row + 1) / rows;
        const v1 = 1 - row / rows;
        for (let k = 0; k < uv.count; k++) uv.setY(k, uv.getY(k) > 0.5 ? v1 : v0);
        // out along the arm, then turned to point at the target (the back face turned round to read from behind)
        m.makeTranslation(1.03, 0, back ? -0.035 : 0.035);
        if (back) m.multiply(new THREE.Matrix4().makeRotationY(Math.PI));
        face.applyMatrix4(m);
        face.applyMatrix4(new THREE.Matrix4().makeRotationY(angle));
        face.translate(0, top - i * 0.4, 0);
        boards.push(face);
      }
    });
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const board = new THREE.Mesh(mergeGeometries(boards), signMaterial(tex, { emissiveIntensity: 1.6, transparent: true, alphaTest: 0.5 }));
    for (const b of boards) b.dispose();
    g.add(board);
    g.position.set(at.x, 0, at.z);
    shadowed(g);
    this.ctx.scene.add(g);
    staticCylinder(this.ctx, at.x, at.z, 0.2, 3);
  }
}

/** One arm of a fingerpost: a pointed board in `color` with its label, pointing right (or, for the back face, left). */
function paintArm(g: CanvasRenderingContext2D, label: string, color: string, left: boolean) {
  const w = ARM_W;
  const h = ARM_H;
  g.save();
  if (left) {
    g.translate(w, 0);
    g.scale(-1, 1);
  }
  const tip = 60;
  const board = new Path2D();
  board.moveTo(10, 14);
  board.lineTo(w - tip, 14);
  board.lineTo(w - 8, h / 2);
  board.lineTo(w - tip, h - 14);
  board.lineTo(10, h - 14);
  board.closePath();
  g.fillStyle = PALETTE.ink;
  g.fill(board);
  g.save();
  g.translate(8, 8);
  g.scale(1 - 16 / w, 1 - 16 / h);
  g.fillStyle = color;
  g.fill(board);
  g.restore();
  g.restore();
  // the label reads left to right whichever way the board points
  g.fillStyle = PALETTE.cream;
  g.textBaseline = 'middle';
  g.textAlign = 'center';
  let size = 64;
  g.font = `${size}px ${DISPLAY_FONT}`;
  while (g.measureText(label).width > w - tip - 60 && size > 24) g.font = `${(size -= 2)}px ${DISPLAY_FONT}`;
  g.lineWidth = 6;
  g.strokeStyle = 'rgba(29, 18, 56, 0.55)';
  const cx = left ? (w + tip) / 2 : (w - tip) / 2;
  g.strokeText(label, cx, h / 2 + 3);
  g.fillText(label, cx, h / 2 + 3);
}
