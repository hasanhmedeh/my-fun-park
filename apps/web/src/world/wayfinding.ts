import * as THREE from 'three';
import { shadowed, staticCylinder, std, type Ctx } from './context';
import { Obstacles } from './crowd/obstacles';
import { DISTRICTS, LAYOUT, onFootprint, onPath, PLAZAS, ZONES, type DistrictId } from './layout';
import { nearTrack } from './rides';
import { DISPLAY_FONT, PALETTE, signMaterial, signTexture } from './textures';

/** Where an arm on a fingerpost points: a district (at its plaza) or a place of its own. */
type Target = DistrictId | 'hub' | 'wheel';

/** The fingerposts where the main paths meet: where, and what each arm points to (top arm first). */
const FINGERPOSTS: { at: [number, number]; r: number; arms: Target[] }[] = [
  { at: [LAYOUT.carousel.x, LAYOUT.carousel.z], r: 15.4, arms: ['cosmos', 'falcon', 'thrill', 'midway', 'motor', 'gate'] },
  { at: [DISTRICTS.gate.plaza[0], DISTRICTS.gate.plaza[1]], r: 9.4, arms: ['hub', 'midway', 'motor', 'gate'] },
  { at: [0, -112], r: 9.4, arms: ['wheel', 'cosmos', 'thrill', 'falcon', 'hub'] },
];

/** Each arm's label, colour and the place it points at (a district's plaza; the main gate's arm points at the entrance itself). */
const TARGETS = Object.fromEntries([
  ...(Object.entries(DISTRICTS) as [DistrictId, (typeof DISTRICTS)[DistrictId]][]).map(([id, d]) => {
    const [x, z] = id === 'gate' ? [ZONES.entrance.x, ZONES.entrance.z] : d.plaza;
    return [id, { label: `${d.icon} ${d.name}`, color: d.color, x, z }];
  }),
  ['hub', { label: '🎠 The Hub', color: PALETTE.violet, x: LAYOUT.carousel.x, z: LAYOUT.carousel.z }],
  ['wheel', { label: '🎡 Giant Wheel', color: PALETTE.sky, x: ZONES.ferris.x, z: ZONES.ferris.z }],
]) as Record<Target, { label: string; color: string; x: number; z: number }>;

/**
 * The park's signposting, so the plan reads on the ground as well as on the map: a tall sign at
 * each district's plaza, in the district's colour, naming it and what's there; and fingerposts
 * where the main paths meet, with an arm pointing towards each district. Each one finds itself a
 * free spot at the edge of its plaza (off the paths, clear of lamps, stalls, trees and rides).
 */
export class Wayfinding {
  private obstacles: Obstacles;
  private taken: [number, number][] = [];

  constructor(private ctx: Ctx) {
    this.obstacles = new Obstacles(ctx.world);
    for (const [id, d] of Object.entries(DISTRICTS) as [DistrictId, (typeof DISTRICTS)[DistrictId]][]) {
      const plaza = PLAZAS.find(([x, z]) => x === d.plaza[0] && z === d.plaza[1]);
      const spot = this.spot(d.plaza[0], d.plaza[1], (plaza?.[2] ?? 8) + 1.6, 1.6);
      if (spot) this.districtSign(id, spot);
    }
    for (const f of FINGERPOSTS) {
      const spot = this.spot(f.at[0], f.at[1], f.r, 1);
      if (spot) this.fingerpost(spot, f.arms);
    }
  }

  /** A free spot on a ring of radius r round (x, z), as near the side facing the park's middle as can be. */
  private spot(x: number, z: number, r: number, clearance: number) {
    const inward = Math.atan2(LAYOUT.carousel.z - z, LAYOUT.carousel.x - x);
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
    const names = d.zones.filter((z) => z !== 'entrance').map((z) => ZONES[z].title);
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

  /** A signpost with an arm pointing towards each target, the first at the top. */
  private fingerpost(at: { x: number; z: number }, arms: Target[]) {
    const g = new THREE.Group();
    const wood = std('#7a5236', { roughness: 0.8 });
    const top = 1.5 + arms.length * 0.4;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, top + 0.4, 10), wood);
    post.position.y = (top + 0.4) / 2;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.3, 10), std(PALETTE.candy, { roughness: 0.5 }));
    cap.position.y = top + 0.55;
    g.add(post, cap);
    arms.forEach((id, i) => {
      const t = TARGETS[id];
      const dx = t.x - at.x;
      const dz = t.z - at.z;
      const arm = new THREE.Group();
      // two faces, each reading left to right, both pointing the same way
      for (const back of [false, true]) {
        const face = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.36), signMaterial(armTexture(t.label, t.color, back), { emissiveIntensity: 1.6, transparent: true, alphaTest: 0.5 }));
        face.position.set(1.03, 0, back ? -0.035 : 0.035);
        face.rotation.y = back ? Math.PI : 0;
        arm.add(face);
      }
      arm.position.y = top - i * 0.4;
      arm.rotation.y = Math.atan2(-dz, dx); // local +x towards the target
      g.add(arm);
    });
    g.position.set(at.x, 0, at.z);
    shadowed(g);
    this.ctx.scene.add(g);
    staticCylinder(this.ctx, at.x, at.z, 0.2, 3);
  }
}

/** One arm of a fingerpost: a pointed board in `color` with its label, pointing right (or, for the back face, left). */
function armTexture(label: string, color: string, left: boolean) {
  const w = 760;
  const h = 144;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
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
  // the label reads left to right whichever way the board points
  if (left) g.setTransform(1, 0, 0, 1, 0, 0);
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
