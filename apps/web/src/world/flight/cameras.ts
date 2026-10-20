// The flight's cameras: the captain's seat (the cockpit overlay's camera), the chase (a spring arm
// behind and above, dragged round and zoomed with the wheel), the left wingtip looking in at the
// engine, the control tower of the nearest airport (or, over the sea, a fixed point the aircraft
// flies past), and a window seat over the wing. Two more are scripted by the flight: a fixed shot
// (the gate window while the passengers board and leave) and the aftermath's slow orbit.
// Everything is preallocated; nothing here allocates per frame.

import * as THREE from 'three';
import { A320_POINTS } from '../../aviation/a320';
import type { AircraftState } from '../../aviation/types';
import { SEA_Y } from '../geo';

export type CamMode = 'cockpit' | 'chase' | 'wing' | 'tower' | 'cabin';
export const CAM_ORDER: CamMode[] = ['cockpit', 'chase', 'wing', 'tower', 'cabin'];
export const CAM_LABEL: Record<CamMode, string> = { cockpit: 'Cockpit', chase: 'Chase', wing: 'Wing', tower: 'Tower', cabin: 'Cabin' };

const D2R = Math.PI / 180;
/** The control towers' cabs (airside-sites.ts builds them at these points, the cab floor this high). */
const TOWERS = [
  { x: 470, y: 53 + 1.6, z: 612 },
  { x: 300, y: 15 + 1.6, z: 40556 },
];
/** The tower watches within this range; beyond it, the fly-by point. */
const TOWER_RANGE = 9000;
const CHASE_DIST = 52;
/** Where the window-seat and the wingtip cameras sit in the body frame (metres from the main gear's reference point). */
const CABIN_EYE = new THREE.Vector3(-1.5, 4.1, -1.2);
const WING_EYE = new THREE.Vector3(-16.2, 4.0, 5.2);
const WING_LOOK = new THREE.Vector3(-5.75, 1.9, -7.5);

export class FlightCameras {
  mode: CamMode = 'cockpit';
  /** Drag offsets (rad) and the chase's zoom (1 = the default arm). */
  lookYaw = 0;
  lookPitch = 0;
  zoom = 1;
  /** A scripted shot (the gate window), and the aftermath orbit, take over from the mode while set. */
  fixed: { pos: THREE.Vector3; look: THREE.Vector3; fov: number } | null = null;
  orbit = false;

  private readonly eye = new THREE.Vector3(A320_POINTS.eye.x, A320_POINTS.eye.y, A320_POINTS.eye.z);
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly m = new THREE.Matrix4();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** The chase's smoothed heading (rad, three's yaw) and position. */
  private chaseYaw = 0;
  private readonly chasePos = new THREE.Vector3();
  private chaseInit = false;
  private orbitT = 0;
  /** The fly-by point over the sea. */
  private readonly flyby = new THREE.Vector3();
  private flybySet = false;

  /** Next camera (C). Drag offsets reset for the new view. */
  cycle() {
    this.mode = CAM_ORDER[(CAM_ORDER.indexOf(this.mode) + 1) % CAM_ORDER.length];
    this.lookYaw = this.lookPitch = 0;
    this.chaseInit = false;
    this.flybySet = false;
    return this.mode;
  }

  set(mode: CamMode) {
    this.mode = mode;
    this.lookYaw = this.lookPitch = 0;
    this.chaseInit = false;
    this.flybySet = false;
  }

  /** Whether the view is from inside the aircraft (the engines sound muffled). */
  get inside() {
    return !this.fixed && !this.orbit && (this.mode === 'cockpit' || this.mode === 'cabin');
  }

  /** The 2D cockpit is drawn over this view. */
  get onFlightDeck() {
    return !this.fixed && !this.orbit && this.mode === 'cockpit';
  }

  look(dx: number, dy: number) {
    const lim = this.mode === 'cockpit' ? 2.6 : this.mode === 'cabin' ? 1.2 : Math.PI;
    this.lookYaw = Math.max(-lim, Math.min(lim, this.lookYaw - dx));
    const plim = this.mode === 'chase' ? [-0.15, 1.2] : [-0.6, 0.5];
    this.lookPitch = Math.max(plim[0], Math.min(plim[1], this.lookPitch + (this.mode === 'chase' ? dy : -dy)));
  }

  zoomBy(d: number) {
    this.zoom = Math.max(0.35, Math.min(4, this.zoom * Math.exp(d * 0.0012)));
  }

  /** Places the camera for this frame. */
  update(camera: THREE.PerspectiveCamera, dt: number, s: AircraftState) {
    camera.up.set(0, 1, 0);
    let fov = 60;
    if (this.fixed) {
      camera.position.copy(this.fixed.pos);
      camera.lookAt(this.fixed.look);
      fov = this.fixed.fov;
    } else if (this.orbit) {
      // the aftermath: a slow circle round the stopped aircraft
      this.orbitT += dt;
      const a = this.orbitT * 0.12;
      const r = 70;
      camera.position.set(s.pos.x + Math.sin(a) * r, Math.max(SEA_Y + 6, s.pos.y + 18), s.pos.z + Math.cos(a) * r);
      this.target.set(s.pos.x, s.pos.y + 3, s.pos.z);
      camera.lookAt(this.target);
      fov = 50;
    } else
      switch (this.mode) {
        case 'cockpit':
          // the captain's eye, looking 7° below the nose (the 2D panel stands in for the real one)
          this.v.copy(this.eye).applyQuaternion(s.quat).add(s.pos);
          camera.position.copy(this.v);
          this.e.set(-7 * D2R + this.lookPitch, this.lookYaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          camera.quaternion.copy(s.quat).multiply(this.q);
          fov = 60;
          break;
        case 'cabin':
          this.v.copy(CABIN_EYE).applyQuaternion(s.quat).add(s.pos);
          camera.position.copy(this.v);
          // out of the left window, a little aft and down, at the wing
          this.e.set(-10 * D2R + this.lookPitch, 78 * D2R + this.lookYaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          camera.quaternion.copy(s.quat).multiply(this.q);
          fov = 62;
          break;
        case 'wing':
          this.v.copy(WING_EYE).applyQuaternion(s.quat).add(s.pos);
          this.w.copy(WING_LOOK).applyQuaternion(s.quat).add(s.pos);
          camera.position.copy(this.v);
          // the wing's up, so the camera banks with it
          this.up.set(0, 1, 0).applyQuaternion(s.quat);
          this.m.lookAt(this.v, this.w, this.up);
          camera.quaternion.setFromRotationMatrix(this.m);
          this.e.set(this.lookPitch, this.lookYaw, 0, 'YXZ');
          this.q.setFromEuler(this.e);
          camera.quaternion.multiply(this.q);
          fov = 58;
          break;
        case 'tower':
          fov = this.tower(camera, s);
          break;
        case 'chase':
        default:
          this.chase(camera, dt, s);
          fov = 55;
          break;
      }
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  private chase(camera: THREE.PerspectiveCamera, dt: number, s: AircraftState) {
    // three's yaw for the aircraft's heading (0 = north, clockwise): −heading
    const want = -s.heading * D2R;
    if (!this.chaseInit) this.chaseYaw = want;
    let d = want - this.chaseYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.chaseYaw += d * (1 - Math.exp(-dt * 2.2));
    const yaw = this.chaseYaw + this.lookYaw;
    const pitch = 0.2 + this.lookPitch;
    const dist = CHASE_DIST * this.zoom;
    this.target.set(s.pos.x, s.pos.y + 3.5, s.pos.z);
    // behind the aircraft: its forward is (−sin yaw, −cos yaw), so behind is +
    this.v.set(Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist).add(this.target);
    this.v.y = Math.max(this.v.y, Math.max(SEA_Y, 0) + 1.6);
    if (!this.chaseInit) {
      this.chasePos.copy(this.v);
      this.chaseInit = true;
    }
    // a stiff spring: fast enough to keep up at 150 kt, soft enough to feel the motion
    this.chasePos.lerp(this.v, 1 - Math.exp(-dt * 9));
    camera.position.copy(this.chasePos);
    camera.lookAt(this.target);
  }

  private tower(camera: THREE.PerspectiveCamera, s: AircraftState) {
    let best = TOWERS[0];
    let bd = Infinity;
    for (const t of TOWERS) {
      const d = Math.hypot(s.pos.x - t.x, s.pos.z - t.z);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    this.target.set(s.pos.x, s.pos.y + 3, s.pos.z);
    if (bd < TOWER_RANGE) {
      camera.position.set(best.x, best.y, best.z);
      this.flybySet = false;
    } else {
      // over the sea: a point ahead of the aircraft and off to one side, which it flies past
      const h = s.track * D2R;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const ahead = (this.flyby.x - s.pos.x) * fx + (this.flyby.z - s.pos.z) * fz;
      if (!this.flybySet || ahead < -900) {
        this.flyby.set(s.pos.x + fx * 1400 - fz * 140, Math.max(SEA_Y + 20, s.pos.y - 25), s.pos.z + fz * 1400 + fx * 140);
        this.flybySet = true;
      }
      camera.position.copy(this.flyby);
    }
    camera.lookAt(this.target);
    // a zoom lens: the aircraft stays about the same size on screen
    const dist = camera.position.distanceTo(this.target);
    return Math.max(2.5, Math.min(55, (2 * Math.atan(46 / Math.max(1, dist)) * 180) / Math.PI)) / this.zoom;
  }
}
