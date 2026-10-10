import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shadowed, staticBox, staticCylinder, std, type Attraction, type Ctx } from '../context';
import { LAYOUT, MUSEUM, museumLocal, museumPoint, ZONES } from '../layout';
import { BODY_FONT, DISPLAY_FONT, hdr, PALETTE, signMaterial, signTexture } from '../textures';
import { EXHIBITS, PROFILE, SECTIONS, SKILLS, type Exhibit, type SectionId } from '../../data/museum';

// The Career Museum: a long gallery hall under a glass roof, at the end of the East Avenue. Hasan
// Hmedeh's CV hangs down both walls in order, one framed picture per job, project or achievement,
// zig-zagging from the door (2019) to the end wall (today), where the toolbox of skills hangs.
// A banner over the aisle and a gold bar on the carpet mark where each year starts. Walk in and
// look around, or take the guided tour (world/gallery.ts): the camera glides from frame to frame.

const { halfW: HW, halfL: HL, wall: T, height: H, porch: PORCH } = MUSEUM;
const RIDGE = 9.2;
/** Half the door's width, and its height. */
const DOOR = 2;
const DOOR_H = 4.4;
/** Every framed picture: 4:3, its centre at this height. */
const FRAME = { w: 2.1, h: 1.575, y: 2.35, mould: 0.12 };
/** How far in front of a frame its viewing spot is (where "Look closer" is offered). */
const SPOT = 2;
/** The first and last frames hang this far from the hall's ends; each new year adds this gap. */
const END_MARGIN = 1.7;
const YEAR_GAP = 1;
/** The toolbox on the end wall. */
const BOARD = { w: 7.6, h: 3.8, y: 2.75 };
/** The year banners hang over the aisle at this height: above the toolbox's top, below the tie beams. */
const BANNER_Y = 5.6;
/** The porch's columns stand on this line, in the hall's frame. */
const COLUMN_Z = HL + T + PORCH - 0.55;

/** A stop on the guided tour: the poster outside, each frame in turn, then the toolbox. */
export type MuseumStop = { kind: 'facade' } | { kind: 'exhibit'; exhibit: Exhibit } | { kind: 'toolbox' };
export const STOPS: MuseumStop[] = [{ kind: 'facade' }, ...EXHIBITS.map((exhibit) => ({ kind: 'exhibit' as const, exhibit })), { kind: 'toolbox' }];

/** What the guided tour's camera has to fit in: the screen's shape, and how much of it the sheet leaves. */
export interface ShotFit {
  aspect: number;
  fov: number;
  /** Fractions of the width and height not covered by the sheet. */
  fx: number;
  fy: number;
}

/** Where each frame hangs: down the hall in order, alternating walls, with a gap where a new year starts. */
function hang() {
  const n = EXHIBITS.length;
  let breaks = 0;
  for (let i = 1; i < n; i++) if (EXHIBITS[i].section !== EXHIBITS[i - 1].section) breaks++;
  const first = HL - END_MARGIN;
  const step = (2 * first - breaks * YEAR_GAP) / Math.max(1, n - 1);
  let lz = first;
  const frames = EXHIBITS.map((exhibit, i) => {
    const fresh = i === 0 || exhibit.section !== EXHIBITS[i - 1].section;
    if (i > 0) lz -= step + (fresh ? YEAR_GAP : 0);
    // -1: the left wall as you walk in, +1: the right
    return { exhibit, lz, side: i % 2 === 0 ? -1 : 1, fresh };
  });
  // each year's banner hangs over the aisle just before its first frame
  const years = frames.filter((f) => f.fresh).map((f) => ({ section: f.exhibit.section, lz: f.lz + (step + YEAR_GAP) / 2 }));
  return { frames, years, step };
}

interface StopPlace {
  /** The middle of what the camera frames, and the way it faces (into the hall, or out of the porch). */
  center: THREE.Vector3;
  normal: THREE.Vector3;
  /** The size to fit on screen, with a margin. */
  w: number;
  h: number;
  min: number;
  max: number;
  /** Where "Look closer" is offered, in the hall's frame (none for the facade: its ring does that). */
  spot: { lx: number; lz: number; r: number } | null;
  /** Where the visitor stands when they leave the tour here, and the way they face. */
  stand: { lx: number; lz: number; facing: [number, number] };
}

export class Museum implements Attraction {
  readonly root = new THREE.Group();
  private places: StopPlace[] = [];
  private banners: THREE.Group[] = [];
  private posters: { exhibit: Exhibit; canvas: HTMLCanvasElement; texture: THREE.CanvasTexture }[] = [];

  constructor(private ctx: Ctx) {
    const root = this.root;
    root.position.set(LAYOUT.museum.x, 0, LAYOUT.museum.z);
    root.rotation.y = MUSEUM.yaw;
    const { frames, years } = hang();

    this.buildShell();
    this.buildRoof();
    this.buildPorch();
    this.buildFloor(years);
    this.buildFrames(frames);
    this.buildToolbox();
    this.buildBanners(years);
    this.buildBenches(frames);

    ctx.scene.add(root);
    root.updateMatrixWorld(true);

    // where the tour's camera goes for each stop, in the order of STOPS
    const facadeZ = HL + T + PORCH;
    this.places.push({
      center: new THREE.Vector3(0, 4.6, facadeZ),
      normal: new THREE.Vector3(0, 0, 1),
      w: 2 * (HW + T) + 3,
      h: RIDGE + 1.6,
      min: 10,
      max: 34,
      spot: null,
      stand: { lx: museumLocal(ZONES.museum.x, ZONES.museum.z).lx, lz: museumLocal(ZONES.museum.x, ZONES.museum.z).lz, facing: [0, -1] },
    });
    for (const f of frames)
      this.places.push({
        center: new THREE.Vector3(f.side * HW, FRAME.y, f.lz),
        normal: new THREE.Vector3(-f.side, 0, 0),
        w: FRAME.w + 0.9,
        h: FRAME.h + 0.9,
        min: 2.4,
        max: 2 * HW - 0.7,
        spot: { lx: f.side * (HW - SPOT), lz: f.lz, r: 1.7 },
        stand: { lx: f.side * (HW - SPOT), lz: f.lz, facing: [f.side, 0] },
      });
    this.places.push({
      center: new THREE.Vector3(0, BOARD.y, -HL),
      normal: new THREE.Vector3(0, 0, 1),
      w: BOARD.w + 0.8,
      h: BOARD.h + 1,
      min: 4,
      max: 2 * HL - 0.8,
      spot: { lx: 0, lz: -HL + 3.2, r: 2.4 },
      stand: { lx: 0, lz: -HL + 3.2, facing: [0, -1] },
    });

    // the pictures arrive once the fair is up; until then (or if one never does) the frames show placeholders
    void this.loadPictures();
  }

  // ---------- Walking about ----------

  /** True if (x, z) is inside the hall (not the doorway or the porch). */
  inside(p: THREE.Vector3) {
    const { lx, lz } = museumLocal(p.x, p.z);
    return Math.abs(lx) < HW && lz > -HL && lz < HL;
  }

  /**
   * Inside the hall, the follow camera stays within its walls and under its roof: it slides in
   * along its line to `target` (a spring arm), so it comes closer rather than looking down steeper.
   */
  clampCamera(target: THREE.Vector3, v: THREE.Vector3) {
    const a = museumLocal(target.x, target.z);
    const b = museumLocal(v.x, v.z);
    const room = [
      [a.lx, b.lx, HW - 0.5],
      [a.lz, b.lz, HL - 0.5],
    ];
    let t = 1;
    for (const [from, to, lim] of room) {
      if (to > lim) t = Math.min(t, (lim - from) / (to - from));
      if (to < -lim) t = Math.min(t, (-lim - from) / (to - from));
    }
    if (v.y > H - 0.4) t = Math.min(t, (H - 0.4 - target.y) / (v.y - target.y));
    v.lerpVectors(target, v, Math.max(0, t));
  }

  /** The tour stop whose viewing spot the visitor is standing on, or -1. */
  stopAt(p: THREE.Vector3) {
    if (!this.inside(p)) return -1;
    const { lx, lz } = museumLocal(p.x, p.z);
    let best = -1;
    let bd = Infinity;
    this.places.forEach((s, i) => {
      if (!s.spot) return;
      const d = Math.hypot(lx - s.spot.lx, lz - s.spot.lz);
      if (d < s.spot.r && d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  // ---------- The guided tour ----------

  /** The camera for a tour stop: square on, just far enough back to fit it beside the sheet. */
  shot(i: number, fit: ShotFit) {
    const s = this.places[THREE.MathUtils.clamp(i, 0, this.places.length - 1)];
    const tan = Math.tan(THREE.MathUtils.degToRad(fit.fov) / 2);
    const d = THREE.MathUtils.clamp(Math.max(s.h / (2 * tan * fit.fy), s.w / (2 * tan * fit.aspect * fit.fx)), s.min, s.max);
    const look = s.center.clone().applyMatrix4(this.root.matrixWorld);
    const normal = s.normal.clone().applyQuaternion(this.root.quaternion);
    const pos = look.clone().addScaledVector(normal, d);
    // outside, a little below the facade's middle, so it rises over the camera
    if (STOPS[i]?.kind === 'facade') pos.y = 2.4;
    return { pos, look };
  }

  /** Where the visitor stands (and faces) when they leave the tour at stop `i`. */
  standSpot(i: number) {
    const s = this.places[THREE.MathUtils.clamp(i, 0, this.places.length - 1)].stand;
    const p = museumPoint(s.lx, s.lz);
    const c = Math.cos(MUSEUM.yaw);
    const n = Math.sin(MUSEUM.yaw);
    const [fx, fz] = s.facing;
    const dx = fx * c + fz * n;
    const dz = -fx * n + fz * c;
    return { x: p.x, z: p.z, heading: Math.atan2(-dx, -dz) };
  }

  update(_dt: number, t: number) {
    this.banners.forEach((b, i) => (b.rotation.x = Math.sin(t * 0.7 + i * 1.7) * 0.025));
  }

  // ---------- The building ----------

  private add(geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], x: number, y: number, z: number) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    this.root.add(m);
    return m;
  }

  /** A static collider in the hall's own frame. */
  private solid(lx: number, lz: number, y: number, hx: number, hy: number, hz: number) {
    const p = museumPoint(lx, lz);
    staticBox(this.ctx, p.x, y, p.z, hx, hy, hz, MUSEUM.yaw);
  }

  /** The walls: cream plaster outside, a deep gallery colour with a dado inside, and a door at the front. */
  private buildShell() {
    const plaster = std('#f2e5cc', { roughness: 0.88 });
    const inner = std('#ffffff', { map: innerWallTexture(), roughness: 0.92 });
    const band = std(PALETTE.violet, { roughness: 0.6 });
    const gold = std('#e0ac3c', { metalness: 0.45, roughness: 0.34 });
    // box faces: +x, -x, +y, -y, +z, -z; `inside` is the face that looks into the hall
    const faces = (inside: number) => Array.from({ length: 6 }, (_, i) => (i === inside ? inner : plaster));
    const long = 2 * HL + 2 * T;
    for (const side of [-1, 1]) {
      shadowed(this.add(new THREE.BoxGeometry(T, H, long), faces(side < 0 ? 0 : 1), side * (HW + T / 2), H / 2, 0), true);
      this.solid(side * (HW + T / 2), 0, H / 2, T / 2, H / 2, HL + T);
      // outside: a violet plinth, a gold cornice and pilasters
      this.add(new THREE.BoxGeometry(0.1, 0.8, long + 0.2), band, side * (HW + T + 0.05), 0.4, 0);
      this.add(new THREE.BoxGeometry(0.26, 0.3, long + 0.5), gold, side * (HW + T + 0.11), H - 0.15, 0);
    }
    // the end wall, and the front either side of the door with a lintel over it
    shadowed(this.add(new THREE.BoxGeometry(2 * HW, H, T), faces(4), 0, H / 2, -HL - T / 2), true);
    this.solid(0, -HL - T / 2, H / 2, HW, H / 2, T / 2);
    this.add(new THREE.BoxGeometry(2 * HW + 2 * T + 0.2, 0.8, 0.1), band, 0, 0.4, -HL - T - 0.05);
    this.add(new THREE.BoxGeometry(2 * HW + 2 * T + 0.5, 0.3, 0.26), gold, 0, H - 0.15, -HL - T - 0.11);
    const seg = HW - DOOR;
    for (const side of [-1, 1]) {
      shadowed(this.add(new THREE.BoxGeometry(seg, H, T), faces(5), side * (DOOR + seg / 2), H / 2, HL + T / 2), true);
      this.solid(side * (DOOR + seg / 2), HL + T / 2, H / 2, seg / 2, H / 2, T / 2);
      // the door's gilded architrave
      this.add(new THREE.BoxGeometry(0.26, DOOR_H, 0.08), gold, side * (DOOR + 0.13), DOOR_H / 2, HL + T + 0.04);
    }
    shadowed(this.add(new THREE.BoxGeometry(2 * DOOR, H - DOOR_H, T), faces(5), 0, (H + DOOR_H) / 2, HL + T / 2), true);
    this.add(new THREE.BoxGeometry(2 * DOOR + 0.52, 0.3, 0.08), gold, 0, DOOR_H + 0.15, HL + T + 0.04);
    // a gold threshold
    this.add(new THREE.BoxGeometry(2 * DOOR, 0.02, T), gold, 0, 0.01, HL + T / 2);

    // pilasters down both long sides, between the plinth and the cornice
    const spots: number[] = [];
    for (let z = -HL; z <= HL + 0.01; z += (2 * HL) / 6) spots.push(z);
    const pil = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, H - 1.1, 0.55), plaster, spots.length * 2);
    const m = new THREE.Matrix4();
    let k = 0;
    for (const side of [-1, 1]) for (const z of spots) pil.setMatrixAt(k++, m.makeTranslation(side * (HW + T + 0.07), 0.8 + (H - 1.1) / 2, z));
    pil.castShadow = true;
    this.root.add(pil);

    // the gables under the roof's ends
    const tri = new THREE.Shape();
    tri.moveTo(-HW - T, 0);
    tri.lineTo(HW + T, 0);
    tri.lineTo(0, RIDGE - H);
    tri.closePath();
    const gable = new THREE.ExtrudeGeometry(tri, { depth: T, bevelEnabled: false });
    gable.translate(0, H, -T / 2);
    for (const z of [-HL - T / 2, HL + T / 2]) shadowed(this.add(gable, plaster, 0, 0, z));
  }

  /** A pitched glass roof on iron trusses: the hall stays sunlit, and the trusses stripe the floor with shadow. */
  private buildRoof() {
    const run = HW + T + 0.35;
    const rise = RIDGE - H;
    const len = 2 * HL + 2 * T + 0.7;
    const glass = new THREE.MeshStandardMaterial({
      color: '#d4ecff',
      transparent: true,
      opacity: 0.16,
      roughness: 0.06,
      metalness: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (const side of [-1, 1]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, RIDGE, -len / 2),
        new THREE.Vector3(side * run, H - 0.12, -len / 2),
        new THREE.Vector3(side * run, H - 0.12, len / 2),
        new THREE.Vector3(0, RIDGE, len / 2),
      ]);
      g.setIndex(side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
      g.computeVertexNormals();
      const pane = this.add(g, glass, 0, 0.01, 0);
      pane.renderOrder = 2;
    }
    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    const slope = Math.hypot(run, rise);
    const angle = Math.atan2(rise, run);
    const n = 11;
    const bars = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), iron, n * 4 + 7);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    let k = 0;
    const bar = (x: number, y: number, z: number, sx: number, sy: number, sz: number, rz = 0) => {
      q.setFromEuler(e.set(0, 0, rz));
      bars.setMatrixAt(k++, m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz)));
    };
    for (let i = 0; i < n; i++) {
      const z = -len / 2 + 0.35 + ((len - 0.7) * i) / (n - 1);
      // two rafters, a tie beam across the hall and a king post up to the ridge
      for (const side of [-1, 1]) bar((side * run) / 2, H + rise / 2 - 0.06, z, slope, 0.12, 0.09, -side * angle);
      bar(0, H - 0.05, z, 2 * HW, 0.12, 0.09);
      bar(0, (H + RIDGE) / 2, z, 0.08, rise, 0.08);
    }
    // the ridge, the eaves and two purlins down each slope
    bar(0, RIDGE, 0, 0.18, 0.18, len);
    for (const side of [-1, 1]) {
      bar(side * (HW + T), H, 0, 0.16, 0.16, len);
      for (const f of [1 / 3, 2 / 3]) bar(side * run * f, RIDGE - rise * f - 0.04, 0, 0.07, 0.07, len);
    }
    bars.count = k;
    bars.castShadow = true;
    this.root.add(bars);
  }

  /** The porch: steps, four columns, an entablature carrying the sign, a pediment, and the exhibition's banners. */
  private buildPorch() {
    const marble = std('#f7f0e2', { roughness: 0.5 });
    const gold = std('#e0ac3c', { metalness: 0.45, roughness: 0.34 });
    const front = HL + T;
    const wide = 2 * (HW + T);
    // a marble porch, nearly flush with the lawn (no collider: the visitor walks straight on), under the zone's ring
    this.add(new THREE.BoxGeometry(wide + 1.2, 0.012, PORCH + 0.6), marble, 0, 0.006, front + (PORCH + 0.6) / 2).receiveShadow = true;
    this.add(new THREE.BoxGeometry(wide + 0.6, 0.024, PORCH), marble, 0, 0.012, front + PORCH / 2).receiveShadow = true;

    for (const x of [-5.1, -2.7, 2.7, 5.1]) {
      const col = new THREE.Group();
      col.add(new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.22, 0.86), marble).translateY(0.19));
      col.add(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 5.35, 20), marble).translateY(0.3 + 5.35 / 2));
      col.add(new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.25, 0.86), marble).translateY(5.775));
      col.position.set(x, 0, COLUMN_Z);
      this.root.add(shadowed(col, true));
      const p = museumPoint(x, COLUMN_Z);
      staticCylinder(this.ctx, p.x, p.z, 0.36, 6);
    }
    // the entablature, with the sign along its frieze
    const depth = PORCH + 0.25;
    shadowed(this.add(new THREE.BoxGeometry(wide + 0.5, 1.2, depth), marble, 0, 6.5, front + depth / 2), true);
    for (const y of [5.93, 7.07]) this.add(new THREE.BoxGeometry(wide + 0.56, 0.07, 0.06), gold, 0, y, front + depth + 0.02);
    const sign = signTexture('CAREER MUSEUM', { width: 2048, height: 384, sub: `${PROFILE.name} · ${PROFILE.since} – today`, border: PALETTE.violet, fontSize: 168 });
    this.add(new THREE.PlaneGeometry(5.9, 1.1), signMaterial(sign, { emissiveIntensity: 2.4 }), 0, 6.5, front + depth + 0.01);

    // the pediment: violet tympanum with a gold medallion, a gilded raking cornice, a flag on top
    const tri = new THREE.Shape();
    const half = wide / 2 + 0.25;
    const top = 2.3;
    tri.moveTo(-half, 0);
    tri.lineTo(half, 0);
    tri.lineTo(0, top);
    tri.closePath();
    const ped = new THREE.ExtrudeGeometry(tri, { depth, bevelEnabled: false });
    shadowed(this.add(ped, [std(PALETTE.violet, { roughness: 0.6 }), marble], 0, 7.1, front));
    const rake = Math.hypot(half, top);
    const tilt = Math.atan2(top, half);
    for (const side of [-1, 1]) {
      const r = this.add(new THREE.BoxGeometry(rake + 0.1, 0.14, 0.1), gold, (side * half) / 2, 7.1 + top / 2 + 0.05, front + depth + 0.04);
      r.rotation.z = -side * tilt;
    }
    const medal = this.add(new THREE.CircleGeometry(0.78, 40), std('#ffffff', { map: medallionTexture(), metalness: 0.35, roughness: 0.4 }), 0, 7.1 + 0.95, front + depth + 0.012);
    medal.castShadow = false;
    const pole = this.add(new THREE.CylinderGeometry(0.04, 0.04, 1.6), std('#3a2f4a', { metalness: 0.6, roughness: 0.4 }), 0, 7.1 + top + 0.8, front + depth / 2);
    pole.castShadow = true;
    const flag = this.add(new THREE.ConeGeometry(0.32, 0.9, 3), std(PALETTE.candy), 0.45, 7.1 + top + 1.3, front + depth / 2);
    flag.rotation.z = -Math.PI / 2;

    // the exhibition's banners, hung between the outer pairs of columns (their backs show through, darker)
    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    for (const side of [-1, 1]) {
      const tex = facadeBannerTexture(side < 0 ? 'name' : 'years');
      const cloth = new THREE.PlaneGeometry(1.6, 2.84);
      const face = new THREE.Mesh(cloth, std('#ffffff', { map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.32, roughness: 0.75, alphaTest: 0.5 }));
      face.position.set(side * 3.9, 4.1, COLUMN_Z + 0.02);
      const rear = new THREE.Mesh(cloth, std('#6b5a9e', { map: tex, roughness: 0.8, alphaTest: 0.5 }));
      rear.rotation.y = Math.PI;
      rear.position.set(side * 3.9, 4.1, COLUMN_Z + 0.01);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2), iron);
      rod.rotation.z = Math.PI / 2;
      rod.position.set(side * 3.9, 5.58, COLUMN_Z + 0.02);
      this.root.add(face, rear, rod);
    }

    // two clipped cypresses in pots either side of the steps
    const pot = std('#b5653a', { roughness: 0.85 });
    const leaf = std('#2f5a36', { roughness: 0.9 });
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.34, 0.7, 16), pot).translateY(0.35));
      g.add(new THREE.Mesh(new THREE.ConeGeometry(0.62, 2.8, 12), leaf).translateY(0.7 + 1.4));
      g.position.set(side * (HW + T + 0.1), 0, front + PORCH + 0.7);
      this.root.add(shadowed(g));
      const p = museumPoint(side * (HW + T + 0.1), front + PORCH + 0.7);
      staticCylinder(this.ctx, p.x, p.z, 0.46, 1.2);
    }
  }

  /** A polished parquet floor, and a red carpet down the aisle that marks where each year starts. */
  private buildFloor(years: { section: SectionId; lz: number }[]) {
    const parquet = parquetTexture();
    parquet.repeat.set(HW, HL);
    const floor = this.add(new THREE.PlaneGeometry(2 * HW, 2 * HL).rotateX(-Math.PI / 2), std('#ffffff', { map: parquet, roughness: 0.42, metalness: 0.02 }), 0, 0.012, 0);
    floor.receiveShadow = true;
    const len = 2 * HL - 0.4;
    const runner = this.add(
      new THREE.PlaneGeometry(2.4, len).rotateX(-Math.PI / 2),
      std('#ffffff', { map: runnerTexture(years, len), roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1 }),
      0,
      0.02,
      0,
    );
    runner.receiveShadow = true;
  }

  /** Each exhibit: a print in a gilded frame, a picture light, a soft wash of light, and a rope in front. */
  private buildFrames(frames: ReturnType<typeof hang>['frames']) {
    const { w, h, mould } = FRAME;
    const gold = std('#e0ac3c', { metalness: 0.45, roughness: 0.34 });
    const brass = std('#b88a3c', { metalness: 0.85, roughness: 0.3 });
    const velvet = std('#8a1531', { roughness: 0.9 });
    const glow = new THREE.MeshBasicMaterial({ color: hdr('#ffe2ad', 5) });
    const wash = new THREE.MeshBasicMaterial({ map: washTexture(), color: hdr('#ffd9a3', 0.42), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

    // all frames share their pieces, drawn as one instance per frame (in each frame's own space: x along the wall, y up, z out of it)
    const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
    const moulding = mergeGeometries([
      box(w + 2 * mould, mould, 0.09, 0, h / 2 + mould / 2, 0.045),
      box(w + 2 * mould, mould, 0.09, 0, -h / 2 - mould / 2, 0.045),
      box(mould, h, 0.09, -w / 2 - mould / 2, 0, 0.045),
      box(mould, h, 0.09, w / 2 + mould / 2, 0, 0.045),
    ])!;
    const lamp = mergeGeometries([box(0.04, 0.04, 0.34, 0, h / 2 + 0.34, 0.17), box(1.0, 0.07, 0.1, 0, h / 2 + 0.34, 0.36)])!;
    const lampGlow = box(0.92, 0.012, 0.06, 0, h / 2 + 0.3, 0.36);
    const washPlane = new THREE.PlaneGeometry(w + 1.4, h + 1.6).translate(0, 0.2, 0.012);
    const postX = w / 2 + 0.15;
    const ropeZ = 0.85;
    const cyl = (r: number, hh: number, x: number, y: number) => new THREE.CylinderGeometry(r, r, hh, 12).translate(x, y, ropeZ);
    const posts = mergeGeometries(
      [-postX, postX].flatMap((x) => [cyl(0.13, 0.04, x, 0.02), cyl(0.024, 0.9, x, 0.47), new THREE.SphereGeometry(0.05, 12, 8).translate(x, 0.95, ropeZ)]),
    )!;
    const rope = new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(new THREE.Vector3(-postX, 0.88, ropeZ), new THREE.Vector3(0, 0.58, ropeZ), new THREE.Vector3(postX, 0.88, ropeZ)),
      20,
      0.022,
      8,
    );
    const n = frames.length;
    const sets = [
      new THREE.InstancedMesh(moulding, gold, n),
      new THREE.InstancedMesh(lamp, brass, n),
      new THREE.InstancedMesh(lampGlow, glow, n),
      new THREE.InstancedMesh(washPlane, wash, n),
      new THREE.InstancedMesh(posts, brass, n),
      new THREE.InstancedMesh(rope, velvet, n),
    ];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const scale = this.ctx.quality.tier === 'low' || this.ctx.quality.tier === 'lowest' ? 0.625 : 1;
    frames.forEach((f, i) => {
      // turned so the frame's z points into the hall
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, (-f.side * Math.PI) / 2);
      m.compose(new THREE.Vector3(f.side * HW, FRAME.y, f.lz), q, one);
      for (const s of sets.slice(0, 4)) s.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(f.side * HW, 0, f.lz), q, one);
      for (const s of sets.slice(4)) s.setMatrixAt(i, m);
      this.solid(f.side * (HW - ropeZ), f.lz, 0.5, 0.04, 0.5, postX);

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(1024 * scale);
      canvas.height = Math.round(768 * scale);
      drawPoster(canvas, f.exhibit, null);
      const texture = canvasTexture(canvas);
      const picture = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        std('#ffffff', { map: texture, emissive: '#ffffff', emissiveMap: texture, emissiveIntensity: 0.5, roughness: 0.62 }),
      );
      picture.position.set(f.side * (HW - 0.03), FRAME.y, f.lz);
      picture.quaternion.copy(q);
      this.root.add(picture);
      this.posters.push({ exhibit: f.exhibit, canvas, texture });
    });
    for (const s of sets) {
      s.computeBoundingSphere();
      this.root.add(s);
    }
    sets[0].castShadow = sets[4].castShadow = sets[5].castShadow = true;
    sets[3].renderOrder = 1;
  }

  /** The toolbox: every skill on the CV, on a big board on the end wall, facing the door. */
  private buildToolbox() {
    const { w, h, y } = BOARD;
    const canvas = document.createElement('canvas');
    const scale = this.ctx.quality.tier === 'low' || this.ctx.quality.tier === 'lowest' ? 0.5 : 1;
    canvas.width = Math.round(2048 * scale);
    canvas.height = Math.round(1024 * scale);
    drawToolbox(canvas, new Map());
    this.toolbox = { canvas, texture: canvasTexture(canvas) };
    const z = -HL;
    this.add(
      new THREE.PlaneGeometry(w, h),
      std('#ffffff', { map: this.toolbox.texture, emissive: '#ffffff', emissiveMap: this.toolbox.texture, emissiveIntensity: 0.45, roughness: 0.7 }),
      0,
      y,
      z + 0.03,
    );
    const gold = std('#e0ac3c', { metalness: 0.45, roughness: 0.34 });
    const mo = 0.18;
    for (const sy of [-1, 1]) this.add(new THREE.BoxGeometry(w + 2 * mo, mo, 0.1), gold, 0, y + sy * (h / 2 + mo / 2), z + 0.05);
    for (const sx of [-1, 1]) this.add(new THREE.BoxGeometry(mo, h, 0.1), gold, sx * (w / 2 + mo / 2), y, z + 0.05);
    this.add(new THREE.BoxGeometry(w * 0.8, 0.08, 0.12), std('#b88a3c', { metalness: 0.85, roughness: 0.3 }), 0, y + h / 2 + 0.42, z + 0.42);
    this.add(new THREE.BoxGeometry(w * 0.78, 0.014, 0.07), new THREE.MeshBasicMaterial({ color: hdr('#ffe2ad', 5) }), 0, y + h / 2 + 0.375, z + 0.42);
    const wash = this.add(
      new THREE.PlaneGeometry(w + 2.4, h + 2),
      new THREE.MeshBasicMaterial({ map: washTexture(), color: hdr('#ffd9a3', 0.36), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      0,
      y + 0.2,
      z + 0.015,
    );
    wash.renderOrder = 1;
  }
  private toolbox: { canvas: HTMLCanvasElement; texture: THREE.CanvasTexture } | null = null;

  /** A swallowtail banner over the aisle where each year begins (one face toward the door, one toward the end). */
  private buildBanners(years: { section: SectionId; lz: number }[]) {
    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    const wireMat = new THREE.LineBasicMaterial({ color: '#2c2433' });
    years.forEach(({ section, lz }) => {
      const g = new THREE.Group();
      const tex = yearBannerTexture(section);
      const mat = std('#ffffff', { map: tex, emissive: '#ffffff', emissiveMap: tex, emissiveIntensity: 0.4, roughness: 0.8, alphaTest: 0.5 });
      const front = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.55), mat);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.55), mat);
      back.rotation.y = Math.PI;
      back.position.z = -0.01;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4), iron);
      rod.rotation.z = Math.PI / 2;
      rod.position.y = 0.8;
      // hung by two wires from the ridge
      const wire = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-1.05, 0.8, 0), new THREE.Vector3(-0.12, RIDGE - BANNER_Y, 0), new THREE.Vector3(1.05, 0.8, 0), new THREE.Vector3(0.12, RIDGE - BANNER_Y, 0)]),
        wireMat,
      );
      g.add(front, back, rod, wire);
      g.position.set(0, BANNER_Y, lz);
      this.root.add(g);
      this.banners.push(g);
    });
  }

  /** Padded benches down the aisle, in the middle of the years with the most to see. */
  private buildBenches(frames: ReturnType<typeof hang>['frames']) {
    const bySection = new Map<SectionId, number[]>();
    for (const f of frames) bySection.set(f.exhibit.section, [...(bySection.get(f.exhibit.section) ?? []), f.lz]);
    const spots = [...bySection.values()].filter((zs) => zs.length >= 3).map((zs) => (zs[0] + zs[zs.length - 1]) / 2);
    if (!spots.length) return;
    const velvet = std('#5b3d8f', { roughness: 0.85 });
    const gold = std('#e0ac3c', { metalness: 0.45, roughness: 0.34 });
    const seat = new THREE.BoxGeometry(2.2, 0.14, 0.62).translate(0, 0.47, 0);
    const frame = mergeGeometries([
      new THREE.BoxGeometry(2.04, 0.06, 0.52).translate(0, 0.37, 0),
      ...[-0.92, 0.92].flatMap((x) => [-0.2, 0.2].map((z) => new THREE.BoxGeometry(0.07, 0.36, 0.07).translate(x, 0.18, z))),
    ])!;
    const seats = new THREE.InstancedMesh(seat, velvet, spots.length);
    const legs = new THREE.InstancedMesh(frame, gold, spots.length);
    const m = new THREE.Matrix4();
    spots.forEach((lz, i) => {
      // turned along the aisle, so a visitor sits facing a wall
      m.makeRotationY(Math.PI / 2).setPosition(0, 0, lz);
      seats.setMatrixAt(i, m);
      legs.setMatrixAt(i, m);
      this.solid(0, lz, 0.27, 0.32, 0.27, 1.1);
    });
    for (const s of [seats, legs]) {
      s.castShadow = s.receiveShadow = true;
      s.computeBoundingSphere();
      this.root.add(s);
    }
  }

  /** Fetches every picture (public/museum/…), redrawing each frame as its picture arrives. */
  private async loadPictures() {
    await Promise.all(
      this.posters.map(async (p) => {
        if (!p.exhibit.image) return;
        const img = await loadImage(p.exhibit.image);
        if (!img) return;
        drawPoster(p.canvas, p.exhibit, img);
        p.texture.needsUpdate = true;
      }),
    );
    const logos = new Map<string, HTMLImageElement>();
    await Promise.all(
      SKILLS.map(async (s) => {
        if (!s.image) return;
        const img = await loadImage(s.image);
        if (img) logos.set(s.name, img);
      }),
    );
    if (this.toolbox && logos.size) {
      drawToolbox(this.toolbox.canvas, logos);
      this.toolbox.texture.needsUpdate = true;
    }
  }
}

// ---------- Pictures and prints ----------

const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

/** A picture from public/, or null if it can't be had. */
function loadImage(path: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img.naturalWidth > 0 ? img : null);
    img.onerror = () => resolve(null);
    img.src = `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
  });
}

function canvasTexture(c: HTMLCanvasElement) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Sets the largest font (from `size` down) that fits `text` in `maxW`. */
function fitFont(g: CanvasRenderingContext2D, text: string, maxW: number, size: number, font: (px: number) => string) {
  let s = size;
  g.font = font(s);
  while (g.measureText(text).width > maxW && s > 10) g.font = font((s -= 2));
  return s;
}

const display = (px: number) => `${px}px ${DISPLAY_FONT}`;
const bold = (px: number) => `700 ${px}px ${BODY_FONT}`;

/** A darker shade of a colour, for text on cream. */
function shade(hex: string, k: number) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(k);
  return `#${c.getHexString()}`;
}

/**
 * A picture fitted into a box: whole (a logo, on a card) or filling it (a photo). A small logo is
 * blown up at most `grow` times, so it stays sharp.
 */
function drawPicture(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number, cover: boolean, pad: number, grow = 2) {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const k = cover ? Math.max(w / iw, h / ih) : Math.min((w - 2 * pad) / iw, (h - 2 * pad) / ih, grow);
  const dw = iw * k;
  const dh = ih * k;
  g.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/** Where there's no picture yet: the exhibit's emoji on its colour, marked as a picture to come. */
function drawPlaceholder(g: CanvasRenderingContext2D, ex: Exhibit, x: number, y: number, w: number, h: number, k: number) {
  const grad = g.createLinearGradient(x, y, x + w, y + h);
  grad.addColorStop(0, shade(ex.accent, 1.15));
  grad.addColorStop(1, shade(ex.accent, 0.55));
  g.fillStyle = grad;
  g.fillRect(x, y, w, h);
  // soft diagonal hatching
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.lineWidth = 18 * k;
  for (let d = -h; d < w; d += 56 * k) {
    g.beginPath();
    g.moveTo(x + d, y + h);
    g.lineTo(x + d + h, y);
    g.stroke();
  }
  g.restore();
  g.setLineDash([16 * k, 12 * k]);
  g.strokeStyle = 'rgba(255,255,255,0.55)';
  g.lineWidth = 4 * k;
  g.strokeRect(x + 18 * k, y + 18 * k, w - 36 * k, h - 36 * k);
  g.setLineDash([]);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${Math.round(h * 0.46)}px ${EMOJI_FONT}`;
  g.fillStyle = '#ffffff';
  g.fillText(ex.icon, x + w / 2, y + h * 0.44);
  g.font = bold(Math.round(22 * k));
  g.fillStyle = 'rgba(255,255,255,0.85)';
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${4 * k}px`;
  g.fillText('PICTURE TO COME', x + w / 2, y + h - 44 * k);
  if ('letterSpacing' in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0px';
}

/** An exhibit's print: the dates and year on a coloured band, the picture, then its title and who it was for. */
function drawPoster(c: HTMLCanvasElement, ex: Exhibit, img: HTMLImageElement | null) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const k = W / 1024;
  const m = 44 * k;
  g.fillStyle = '#fbf5e9';
  g.fillRect(0, 0, W, c.height);
  // the band: when, and the year it hangs under
  g.fillStyle = ex.accent;
  g.fillRect(0, 0, W, 112 * k);
  g.textBaseline = 'middle';
  g.textAlign = 'right';
  g.fillStyle = '#ffffff';
  g.font = display(Math.round(72 * k));
  g.fillText(ex.section, W - m, 62 * k);
  const yearW = g.measureText(ex.section).width;
  g.textAlign = 'left';
  fitFont(g, ex.when.toUpperCase(), W - 3 * m - yearW, Math.round(42 * k), bold);
  g.fillText(ex.when.toUpperCase(), m, 60 * k);

  // the picture, on a white card (or an ink one for a white logo), or the placeholder
  const box = { x: m, y: 136 * k, w: W - 2 * m, h: 368 * k };
  g.save();
  rounded(g, box.x, box.y, box.w, box.h, 20 * k);
  g.clip();
  if (img) {
    g.fillStyle = ex.bg ?? '#ffffff';
    g.fillRect(box.x, box.y, box.w, box.h);
    drawPicture(g, img, box.x, box.y, box.w, box.h, ex.fill === 'cover', 40 * k, 2 * k);
  } else drawPlaceholder(g, ex, box.x, box.y, box.w, box.h, k);
  g.restore();
  g.strokeStyle = 'rgba(29, 18, 56, 0.18)';
  g.lineWidth = 3 * k;
  rounded(g, box.x, box.y, box.w, box.h, 20 * k);
  g.stroke();

  // the title, and who / what it was
  g.textBaseline = 'alphabetic';
  g.fillStyle = PALETTE.ink;
  fitFont(g, ex.title, W - 2 * m, Math.round(78 * k), display);
  g.fillText(ex.title, m, 594 * k);
  g.fillStyle = shade(ex.accent, 0.8);
  fitFont(g, ex.org, W - 2 * m, Math.round(48 * k), bold);
  g.fillText(ex.org, m, 658 * k);
  if (ex.kicker) {
    g.fillStyle = '#5c4d7a';
    fitFont(g, ex.kicker, W - 2 * m, Math.round(40 * k), (px) => `600 ${px}px ${BODY_FONT}`);
    g.fillText(ex.kicker, m, 718 * k);
  }
}

/** The toolbox board: the CV's skills as logo tiles (a monogram where there's no logo), and the languages. */
function drawToolbox(c: HTMLCanvasElement, logos: Map<string, HTMLImageElement>) {
  const g = c.getContext('2d')!;
  const W = c.width;
  const Hc = c.height;
  const k = W / 2048;
  const bg = g.createLinearGradient(0, 0, 0, Hc);
  bg.addColorStop(0, '#2a1b52');
  bg.addColorStop(1, PALETTE.ink);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, Hc);
  g.strokeStyle = PALETTE.mustard;
  g.lineWidth = 6 * k;
  g.strokeRect(28 * k, 28 * k, W - 56 * k, Hc - 56 * k);

  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = PALETTE.mustard;
  g.font = display(Math.round(118 * k));
  g.fillText('THE TOOLBOX', 90 * k, 175 * k);
  g.fillStyle = PALETTE.cream;
  g.font = bold(Math.round(38 * k));
  g.textAlign = 'right';
  g.fillText(`${SKILLS.length} languages, frameworks and tools from the CV`, W - 90 * k, 168 * k);

  const cols = Math.ceil(SKILLS.length / 2);
  const left = 90 * k;
  const cell = (W - 2 * left) / cols;
  const tile = cell - 26 * k;
  SKILLS.forEach((s, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = left + col * cell + (cell - tile) / 2;
    const y = 240 * k + row * 300 * k;
    rounded(g, x, y, tile, tile, 22 * k);
    const img = logos.get(s.name);
    g.fillStyle = img ? '#ffffff' : s.color;
    g.fill();
    if (img) {
      g.save();
      rounded(g, x, y, tile, tile, 22 * k);
      g.clip();
      drawPicture(g, img, x, y, tile, tile, false, 20 * k, 4);
      g.restore();
    } else {
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const mono = monogram(s.name);
      fitFont(g, mono, tile * 0.8, Math.round(tile * 0.42), display);
      g.fillText(mono, x + tile / 2, y + tile / 2 + 4 * k);
    }
    g.fillStyle = PALETTE.cream;
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    fitFont(g, s.name, cell - 6 * k, Math.round(30 * k), bold);
    g.fillText(s.name, x + tile / 2, y + tile + 46 * k);
  });

  // the languages along the bottom
  const y = Hc - 120 * k;
  g.strokeStyle = 'rgba(255, 245, 227, 0.25)';
  g.lineWidth = 3 * k;
  g.beginPath();
  g.moveTo(90 * k, y - 78 * k);
  g.lineTo(W - 90 * k, y - 78 * k);
  g.stroke();
  g.textAlign = 'left';
  g.fillStyle = PALETTE.mustard;
  g.font = display(Math.round(56 * k));
  g.fillText('Languages', 90 * k, y);
  let x = 90 * k + g.measureText('Languages').width + 50 * k;
  for (const l of PROFILE.languages) {
    g.fillStyle = PALETTE.cream;
    g.font = display(Math.round(52 * k));
    g.fillText(l.name, x, y);
    x += g.measureText(l.name).width + 16 * k;
    g.fillStyle = 'rgba(255, 245, 227, 0.7)';
    g.font = bold(Math.round(32 * k));
    g.fillText(l.level, x, y);
    x += g.measureText(l.level).width + 60 * k;
  }
}

/** A skill's initials for its tile without a logo: "C#", ".NET", "JS", "Py". */
function monogram(name: string) {
  const first = name.split(' ')[0];
  if (first.length <= 4) return first;
  const caps = name.replace(/[^A-Z]/g, '');
  return caps.length >= 2 ? caps.slice(0, 3) : first.slice(0, 2);
}

/** Inside walls: a dark dado with a gilded rail, a deep gallery colour, and a cream frieze under the roof. */
function innerWallTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 660;
  const g = c.getContext('2d')!;
  const at = (m: number) => c.height - (m / H) * c.height;
  g.fillStyle = '#4d4290';
  g.fillRect(0, 0, 8, c.height);
  g.fillStyle = '#efe3c8';
  g.fillRect(0, 0, 8, at(H - 0.55));
  g.fillStyle = '#d8a93a';
  g.fillRect(0, at(H - 0.55), 8, 4);
  g.fillStyle = '#30255c';
  g.fillRect(0, at(1.05), 8, c.height - at(1.05));
  g.fillStyle = '#d8a93a';
  g.fillRect(0, at(1.1), 8, 5);
  return canvasTexture(c);
}

/** Oak parquet in staggered boards (one tile covers 2 m × 2 m). */
function parquetTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  let seed = 5;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = 8;
  const rh = 512 / rows;
  for (let r = 0; r < rows; r++) {
    let x = -rnd() * 200;
    while (x < 512) {
      const len = 140 + rnd() * 160;
      const l = 0.42 + rnd() * 0.12;
      g.fillStyle = `hsl(${28 + rnd() * 8}, ${42 + rnd() * 12}%, ${l * 100}%)`;
      g.fillRect(x, r * rh, len, rh);
      // grain
      g.strokeStyle = 'rgba(60, 30, 10, 0.12)';
      g.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const y = r * rh + 6 + rnd() * (rh - 12);
        g.beginPath();
        g.moveTo(x, y);
        g.bezierCurveTo(x + len / 3, y + (rnd() - 0.5) * 6, x + (2 * len) / 3, y + (rnd() - 0.5) * 6, x + len, y);
        g.stroke();
      }
      g.fillStyle = 'rgba(40, 20, 8, 0.55)';
      g.fillRect(x, r * rh, 2, rh);
      x += len;
    }
    g.fillStyle = 'rgba(40, 20, 8, 0.5)';
    g.fillRect(0, r * rh, 512, 2);
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** The red carpet down the aisle, `len` metres long: a gold bar and the year where each one starts. */
function runnerTexture(years: { section: SectionId; lz: number }[], len: number) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = Math.round((256 * len) / 2.4); // square pixels: 2.4 m across
  const g = c.getContext('2d')!;
  const px = c.height / len;
  g.fillStyle = '#7d1c36';
  g.fillRect(0, 0, c.width, c.height);
  // a faint diamond weave
  g.strokeStyle = 'rgba(255, 210, 150, 0.06)';
  g.lineWidth = 2;
  for (let y = -256; y < c.height; y += 32) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(256, y + 256);
    g.moveTo(256, y);
    g.lineTo(0, y + 256);
    g.stroke();
  }
  g.fillStyle = '#d8a93a';
  for (const x of [14, 236]) g.fillRect(x, 0, 6, c.height);
  // the canvas's top is the far end (lz = -len / 2); text reads walking in
  for (const { section, lz } of years) {
    const y = (lz + len / 2) * px;
    g.fillStyle = '#d8a93a';
    g.fillRect(14, y - 4, 228, 8);
    g.font = display(84);
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillStyle = 'rgba(255, 214, 120, 0.9)';
    g.fillText(section, 128, y - 26);
  }
  return canvasTexture(c);
}

/** A soft warm glow, brightest where a picture light points. */
function washTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 40, 4, 64, 58, 70);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return canvasTexture(c);
}

/** The pediment's gold medallion with the initials. */
function medallionTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(100, 90, 10, 128, 128, 128);
  grad.addColorStop(0, '#ffe08a');
  grad.addColorStop(1, '#b8861f');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = PALETTE.ink;
  g.lineWidth = 8;
  g.beginPath();
  g.arc(128, 128, 104, 0, Math.PI * 2);
  g.stroke();
  const initials = PROFILE.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('');
  g.fillStyle = PALETTE.ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, initials, 150, 120, display);
  g.fillText(initials, 128, 136);
  return canvasTexture(c);
}

/** A swallowtail banner (transparent notch at the bottom). */
function swallowtail(g: CanvasRenderingContext2D, w: number, h: number, notch: number, fill: string, border: string, k: number) {
  const path = () => {
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(w, 0);
    g.lineTo(w, h);
    g.lineTo(w / 2, h - notch);
    g.lineTo(0, h);
    g.closePath();
  };
  path();
  g.fillStyle = fill;
  g.fill();
  g.save();
  path();
  g.clip();
  g.strokeStyle = border;
  g.lineWidth = 16 * k;
  g.stroke();
  g.restore();
}

/** A year's banner over the aisle: the year, and what it's about. */
function yearBannerTexture(section: SectionId) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 360;
  const g = c.getContext('2d')!;
  swallowtail(g, 512, 360, 56, PALETTE.ink, PALETTE.mustard, 1);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.fillStyle = PALETTE.mustard;
  g.font = display(150);
  g.fillText(section, 256, 172);
  g.fillStyle = PALETTE.cream;
  fitFont(g, SECTIONS[section].title, 440, 42, bold);
  g.fillText(SECTIONS[section].title, 256, 236);
  return canvasTexture(c);
}

/** The two banners on the porch: who the exhibition is about, and the years it covers. */
function facadeBannerTexture(which: 'name' | 'years') {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 908;
  const g = c.getContext('2d')!;
  swallowtail(g, 512, 908, 70, which === 'name' ? PALETTE.violet : PALETTE.ink, PALETTE.mustard, 1);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  if (which === 'name') {
    g.fillStyle = PALETTE.mustard;
    g.font = bold(34);
    g.fillText('NOW SHOWING', 256, 110);
    const [first, ...rest] = PROFILE.name.toUpperCase().split(' ');
    g.fillStyle = PALETTE.cream;
    fitFont(g, first, 430, 120, display);
    g.fillText(first, 256, 250);
    fitFont(g, rest.join(' '), 430, 120, display);
    g.fillText(rest.join(' '), 256, 370);
    g.font = bold(34);
    const words = PROFILE.headline.split(' ');
    const lines: string[] = [];
    for (const w of words) {
      const last = lines[lines.length - 1];
      if (last && g.measureText(`${last} ${w}`).width < 420) lines[lines.length - 1] = `${last} ${w}`;
      else lines.push(w);
    }
    lines.forEach((l, i) => g.fillText(l, 256, 470 + i * 46));
    g.fillStyle = PALETTE.mustard;
    g.font = display(84);
    g.fillText(`${PROFILE.since} →`, 256, 690);
    g.font = display(64);
    g.fillText('today', 256, 760);
  } else {
    g.fillStyle = PALETTE.mustard;
    g.font = bold(34);
    g.fillText('FREE ENTRY', 256, 110);
    const ids = Object.keys(SECTIONS) as SectionId[];
    ids.forEach((id, i) => {
      const y = 200 + i * 104;
      g.fillStyle = PALETTE.mustard;
      g.font = display(64);
      g.fillText(id, 256, y);
      g.fillStyle = PALETTE.cream;
      fitFont(g, SECTIONS[id].title, 420, 30, bold);
      g.fillText(SECTIONS[id].title, 256, y + 38);
    });
  }
  return canvasTexture(c);
}
