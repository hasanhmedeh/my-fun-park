import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry } from './random';
import { addWind } from './wind';

const CHUNK = 16;

/** One clump = a few curved, tapered blades sharing a root. */
function clumpGeometry() {
  const rnd = mulberry(5);
  const blades: THREE.BufferGeometry[] = [];
  const BLADES = 7;
  for (let b = 0; b < BLADES; b++) {
    const h = 0.2 + rnd() * 0.24;
    const w = 0.035 + rnd() * 0.025;
    const lean = 0.05 + rnd() * 0.12;
    const segs = 3;
    const pos: number[] = [];
    const sway: number[] = [];
    const col: number[] = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = t * h;
      const z = t * t * lean;
      const half = (1 - t * 0.92) * w;
      pos.push(-half, y, z, half, y, z);
      sway.push(t, t);
      // dark, damp base → sun-bleached tips
      const c = new THREE.Color().lerpColors(new THREE.Color('#2a5228'), new THREE.Color('#b9d36c'), Math.pow(t, 0.75));
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    }
    const idx: number[] = [];
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    // Normals pointing up give the soft, uniform shading real lawns have from a distance.
    g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array((pos.length / 3) * 3).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setIndex(idx);
    g.rotateY(rnd() * Math.PI * 2);
    g.translate((rnd() - 0.5) * 0.3, 0, (rnd() - 0.5) * 0.3);
    blades.push(g);
  }
  return mergeGeometries(blades)!;
}

interface Chunk {
  mesh: THREE.InstancedMesh;
  center: THREE.Vector2;
  full: number;
}

export class Grass {
  private chunks: Chunk[] = [];
  private material: THREE.Material;
  /** Set while flying: the lawn stays hidden whatever the LOD would show (see setHidden). */
  private hidden = false;

  /**
   * `growth` gives how densely grass grows at (x, z), from 0 (bare: paths, outside the grounds) to 1,
   * over the area `bounds`.
   */
  constructor(
    scene: THREE.Scene,
    growth: (x: number, z: number) => number,
    bounds: { x0: number; x1: number; z0: number; z1: number },
    density: number,
    private maxDistance: number,
    pbr: boolean,
  ) {
    const geo = clumpGeometry();
    // PBR picks up the sky lighting like the ground does; Lambert is the cheap fallback
    this.material = pbr
      ? new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85 })
      : new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    addWind(this.material, 0.06, true);
    if (density <= 0) return;

    const rnd = mulberry(99);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let cx = bounds.x0; cx < bounds.x1; cx += CHUNK)
      for (let cz = bounds.z0; cz < bounds.z1; cz += CHUNK) {
        const target = Math.round(CHUNK * CHUNK * density);
        const mats: THREE.Matrix4[] = [];
        const tints: THREE.Color[] = [];
        for (let i = 0; i < target; i++) {
          const x = cx + rnd() * CHUNK;
          const z = cz + rnd() * CHUNK;
          const g = growth(x, z);
          if (g <= 0 || (g < 1 && rnd() > g)) continue;
          // patchy meadow: denser in some areas, a few clearings
          const patch = Math.sin(x * 0.13) * Math.cos(z * 0.11) + Math.sin(x * 0.05 + z * 0.07);
          if (patch < -0.9 && rnd() > 0.3) continue;
          const sc = 0.8 + rnd() * 0.5 + Math.max(0, patch) * 0.35;
          q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * Math.PI * 2);
          mats.push(m.compose(p.set(x, 0, z), q, s.set(sc, sc * (0.8 + rnd() * 0.5), sc)).clone());
          tints.push(tint.setHSL(0.18 + rnd() * 0.12, 0.45, 0.78 + rnd() * 0.18).clone());
        }
        if (!mats.length) continue;
        const mesh = new THREE.InstancedMesh(geo, this.material, mats.length);
        mats.forEach((mm, i) => {
          mesh.setMatrixAt(i, mm);
          mesh.setColorAt(i, tints[i]);
        });
        mesh.computeBoundingSphere();
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        scene.add(mesh);
        this.chunks.push({ mesh, center: new THREE.Vector2(cx + CHUNK / 2, cz + CHUNK / 2), full: mats.length });
      }
  }

  /** Distance LOD: thin far chunks out (instances are random, so a prefix is a uniform subset). */
  update(cameraTarget: THREE.Vector3) {
    if (this.hidden) return;
    for (const c of this.chunks) {
      const d = Math.hypot(c.center.x - cameraTarget.x, c.center.y - cameraTarget.z);
      if (d > this.maxDistance) {
        c.mesh.visible = false;
        continue;
      }
      c.mesh.visible = true;
      const k = THREE.MathUtils.clamp(1.25 - d / this.maxDistance, 0.25, 1);
      c.mesh.count = Math.max(1, Math.floor(c.full * k));
    }
  }

  hideAll() {
    for (const c of this.chunks) c.mesh.visible = false;
  }

  /** Keeps every chunk hidden until set back (from the air the LOD, which only measures across the ground, would draw the lot). */
  setHidden(on: boolean) {
    this.hidden = on;
    if (on) this.hideAll();
  }
}
