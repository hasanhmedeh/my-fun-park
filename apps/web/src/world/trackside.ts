import * as THREE from 'three';
import { std, type Ctx } from './context';
import { broadleafGeometry, pineGeometry } from './environment';
import { inPark, LAYOUT, PARK } from './layout';
import { mulberry } from './random';
import { FALCON_TRACK, nearTrack } from './rides';
import { addWind } from './wind';

/**
 * Scenery along the Sky Falcon wherever it runs close to the ground outside the park: trees,
 * shrubs and rocks at varying distances, plus a row of marker posts right beside the rails.
 * Things whipping past close to the train are what sell its speed.
 */
export class Trackside {
  /** Crest of the giant hill: the highest point after the tunnel. */
  static hillCrest() {
    const d = FALCON_TRACK;
    let best = d.zone.lastIndexOf('tunnel');
    for (let i = best; i < d.pos.length; i++) if (d.pos[i].y > d.pos[best].y) best = i;
    return best;
  }

  /**
   * A tapering square lattice pylon (white tube legs, rings and X-bracing on every face) from
   * the desert floor up to the underside of the crest, with a cross-beam carrying the track.
   */
  private hillTower(ctx: Ctx, ground: (x: number, z: number) => number) {
    const d = FALCON_TRACK;
    const i = Trackside.hillCrest();
    const c = d.pos[i];
    const top = c.y - d.up[i].y - 1.6;
    const base = ground(c.x, c.z);
    const along = new THREE.Vector3(d.tan[i].x, 0, d.tan[i].z).normalize();
    const side = new THREE.Vector3(-along.z, 0, along.x);
    const corner = (y: number, sx: number, sz: number) => {
      const half = THREE.MathUtils.lerp(9, 3.2, (y - base) / (top - base));
      return new THREE.Vector3(c.x, y, c.z).addScaledVector(side, sx * half).addScaledVector(along, sz * half);
    };
    const struts: [THREE.Vector3, THREE.Vector3, number][] = [];
    const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const levels = Math.ceil((top - base) / 11);
    for (let l = 0; l < levels; l++) {
      const y0 = base + ((top - base) * l) / levels;
      const y1 = base + ((top - base) * (l + 1)) / levels;
      for (let k = 0; k < 4; k++) {
        const [ax, az] = corners[k];
        const [bx, bz] = corners[(k + 1) % 4];
        struts.push([corner(y0, ax, az), corner(y1, ax, az), 0.55]); // leg
        struts.push([corner(y1, ax, az), corner(y1, bx, bz), 0.3]); // ring
        struts.push([corner(y0, ax, az), corner(y1, bx, bz), 0.22]); // X-bracing
        struts.push([corner(y0, bx, bz), corner(y1, ax, az), 0.22]);
      }
    }
    // cross-beam under the rails
    struts.push([corner(top, -1, 0).addScaledVector(side, -1.5), corner(top, 1, 0).addScaledVector(side, 1.5), 0.7]);
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const tower = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), std('#eef0f2', { metalness: 0.4, roughness: 0.4 }), struts.length);
    struts.forEach(([a, b, r], k) => {
      const dir = b.clone().sub(a);
      q.setFromUnitVectors(up, dir.clone().normalize());
      m.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(r, dir.length(), r));
      tower.setMatrixAt(k, m);
    });
    // the tower stands on a plinth; nothing else should grow through it
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(22, 2, 22), std('#cdbfa8', { roughness: 0.9 }));
    plinth.position.set(c.x, base + 0.6, c.z);
    plinth.receiveShadow = true;
    ctx.scene.add(plinth);
    return tower;
  }

  constructor(ctx: Ctx, ground: (x: number, z: number) => number) {
    const d = FALCON_TRACK;
    const n = d.pos.length;
    const rnd = mulberry(91);
    const rail = (i: number) => d.pos[i].y - d.up[i].y;
    const wheel = LAYOUT.ferris;
    // places nothing may stand: the park, the road out to the wheel, the giant wheel's legs, any track
    const blocked = (x: number, z: number, clearance: number) =>
      inPark(x, z, 5.5) ||
      (Math.abs(x - wheel.x) < 14 && z < PARK.z && z > wheel.z) ||
      (Math.abs(x - wheel.x) < 72 && Math.abs(z - wheel.z) < 56) ||
      nearTrack(x, z, clearance);

    const trees: { x: number; z: number; s: number; pine: boolean }[] = [];
    const shrubs: THREE.Matrix4[] = [];
    const rocks: THREE.Matrix4[] = [];
    const posts: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const side = new THREE.Vector3();
    const step = 12; // samples (6 m)
    for (let i = 0; i < n; i += step) {
      if (d.zone[i] === 'station' || d.zone[i] === 'tunnel') continue;
      const p = d.pos[i];
      const g = ground(p.x, p.z);
      const height = rail(i) - g;
      if (height > 10 || height < -1) continue; // only where the track is near the ground
      side.set(d.tan[i].z, 0, -d.tan[i].x).normalize();
      for (const s of [-1, 1]) {
        // scattered trees and shrubs 7–34 m out (the near ones streak past)
        for (let k = 0; k < 2; k++) {
          const off = 7 + rnd() * 27;
          const along = (rnd() - 0.5) * 6;
          const x = p.x + side.x * s * off + d.tan[i].x * along;
          const z = p.z + side.z * s * off + d.tan[i].z * along;
          if (blocked(x, z, 5)) continue;
          const y = ground(x, z);
          const r = rnd();
          if (r < 0.55) trees.push({ x, z, s: 0.8 + rnd() * 0.9, pine: rnd() < 0.5 });
          else if (r < 0.8) {
            const sc = 0.6 + rnd() * 0.9;
            q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28);
            shrubs.push(m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sc * 1.4, sc, sc * 1.4)).clone());
          } else {
            const sc = 0.5 + rnd() * 1.6;
            q.setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28));
            rocks.push(m.compose(new THREE.Vector3(x, y + sc * 0.2, z), q, new THREE.Vector3(sc * 1.3, sc * 0.8, sc)).clone());
          }
        }
      }
      // marker posts 2.6 m from the rails, alternating sides every 6 m
      if (height < 4) {
        const s = (i / step) % 2 ? 1 : -1;
        const x = p.x + side.x * s * 2.6;
        const z = p.z + side.z * s * 2.6;
        if (!blocked(x, z, 2.2)) posts.push(m.makeTranslation(x, ground(x, z), z).clone());
      }
    }

    // ---- trees: the same broadleaf / pine models as the park, swaying in the same wind ----
    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 2.6, 7).translate(0, 1.3, 0);
    const trunkMat = std('#5b4033', { roughness: 0.95 });
    const leafMat = std('#ffffff', { vertexColors: true, roughness: 0.82 });
    const pineMat = std('#ffffff', { vertexColors: true, roughness: 0.85 });
    addWind(leafMat, 0.05);
    addWind(pineMat, 0.035);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
    const broad = new THREE.InstancedMesh(broadleafGeometry(), leafMat, trees.length);
    const pines = new THREE.InstancedMesh(pineGeometry(), pineMat, trees.length);
    let nb = 0;
    let np = 0;
    trees.forEach((t, i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6.28);
      m.compose(new THREE.Vector3(t.x, ground(t.x, t.z) - 0.1, t.z), q, new THREE.Vector3(t.s, t.s * (0.9 + rnd() * 0.3), t.s));
      trunks.setMatrixAt(i, m);
      if (t.pine) pines.setMatrixAt(np++, m);
      else broad.setMatrixAt(nb++, m);
    });
    broad.count = nb;
    pines.count = np;

    // ---- shrubs, rocks and posts ----
    const shrubGeo = new THREE.IcosahedronGeometry(1, 1).translate(0, 0.55, 0);
    const shrubMesh = new THREE.InstancedMesh(shrubGeo, std('#4f7a3a', { roughness: 0.9, flatShading: true }), Math.max(1, shrubs.length));
    shrubs.forEach((mm, i) => shrubMesh.setMatrixAt(i, mm));
    shrubMesh.count = shrubs.length;
    const rockMesh = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), std('#b08a64', { roughness: 0.95, flatShading: true }), Math.max(1, rocks.length));
    rocks.forEach((mm, i) => rockMesh.setMatrixAt(i, mm));
    rockMesh.count = rocks.length;
    // white posts with a red reflector band
    const postGeo = new THREE.CylinderGeometry(0.09, 0.11, 1.6, 8).translate(0, 0.8, 0);
    const bandGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.22, 8).translate(0, 1.32, 0);
    const postMesh = new THREE.InstancedMesh(postGeo, std('#f4f1ea', { roughness: 0.6 }), Math.max(1, posts.length));
    const bandMesh = new THREE.InstancedMesh(bandGeo, std('#e0303d', { roughness: 0.4, emissive: '#ff2030', emissiveIntensity: 0.6 }), Math.max(1, posts.length));
    posts.forEach((mm, i) => {
      postMesh.setMatrixAt(i, mm);
      bandMesh.setMatrixAt(i, mm);
    });
    postMesh.count = bandMesh.count = posts.length;

    // ---- the lattice tower under the 163 m hill's crest ----
    const tower = this.hillTower(ctx, ground);

    for (const im of [trunks, broad, pines, shrubMesh, rockMesh, postMesh, bandMesh, tower]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      ctx.scene.add(im);
    }
  }
}
