// The ILS guide: a tunnel of open frames in the sky along the arrival runway's 3° glide path, one
// every 0.3 NM from 8 NM out to half a mile, for a first-time pilot to fly through on final (the
// real instruments say the same thing; this makes it obvious). It's one instanced mesh, placed
// once per runway, and shown only on the approach while the visitor has it switched on.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { runwayFrame, type RunwayEnd } from '../../aviation/airports';
import { NM } from '../geo';

const STEP_NM = 0.3;
const FIRST_NM = 0.5;
const LAST_NM = 8;
const COUNT = Math.floor((LAST_NM - FIRST_NM) / STEP_NM) + 1;
/** Frame size (m): wide enough to fly through with a little drift, the bars thick enough to see from a mile off. */
const W = 64;
const H = 40;
const BAR = 1.4;
/** The frames' centre sits this far above the path of the reference point (the main gear), near the pilot's eye. */
const LIFT = 4;
const D2R = Math.PI / 180;

export class IlsGuide {
  readonly mesh: THREE.InstancedMesh;
  private runway: RunwayEnd | null = null;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly p = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    const bar = (w: number, h: number, x: number, y: number) => new THREE.BoxGeometry(w, h, BAR).translate(x, y, 0);
    const geo = mergeGeometries([bar(W, BAR, 0, H / 2), bar(W, BAR, 0, -H / 2), bar(BAR, H, -W / 2, 0), bar(BAR, H, W / 2, 0)]);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#ff4fd8').multiplyScalar(1.6), transparent: true, opacity: 0.7, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, COUNT);
    this.mesh.name = 'ils-guide';
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /** Lays the frames along this runway's glide path. */
  setRunway(rw: RunwayEnd) {
    if (rw === this.runway) return;
    this.runway = rw;
    const ils = rw.ils;
    const h = rw.heading * D2R;
    // out along the approach (against the landing direction)
    const bx = -Math.sin(h);
    const bz = Math.cos(h);
    const gpiAlong = runwayFrame(rw, ils.gpi.x, ils.gpi.z).along;
    const tan = Math.tan(ils.slopeDeg * D2R);
    // each frame faces along the course
    this.q.setFromAxisAngle(this.axis, -h);
    for (let i = 0; i < COUNT; i++) {
      const out = (FIRST_NM + i * STEP_NM) * NM;
      const y = (gpiAlong + out) * tan + LIFT;
      this.p.set(rw.threshold.x + bx * out, y, rw.threshold.z + bz * out);
      this.m.compose(this.p, this.q, this.one);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  show(on: boolean) {
    this.mesh.visible = on;
  }
}
