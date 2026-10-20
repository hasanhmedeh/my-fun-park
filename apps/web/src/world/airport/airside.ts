// An airport's airside: the buildings round the apron (control tower, hangars, cargo, the fire
// station, the fuel farm, the floodlight masts), the aircraft parked at the stands nobody else
// needs, the ground equipment working them, and the vehicles driving the service roads.
//
// Everything static is merged into a few vertex-coloured meshes (airside-kit.ts) placed relative
// to the airport's own origin; every vehicle and crew member is one instance of one BatchedMesh
// (vehicles.ts); lamps are point sprites. A whole airport draws in about a dozen calls plus one
// per parked aircraft (two at night, with its lights). Detail fades with the camera's distance:
// small fittings go at 2.5 km, the vehicles at 4 km, the buildings at 14 km, and the floodlights'
// flares carry on to 30 km.
//
// The player's stand gets the pushback tug (exported as `tug`, driven by the flight attraction)
// and a marshaller who waves the aircraft in; the stands left for AI traffic get belt loaders that
// drive up to the holds while an aircraft is on the stand (`setStandService`).

import * as THREE from 'three';
import type { Ctx } from '../context';
import type { Airport } from '../../aviation/airports';
import { AIRFIELDS } from '../../aviation/airports';
import { A320_POINTS } from '../../aviation/a320';
import type { PlaneModel, PlaneVisual } from '../../aviation/types';
import { headingVec, type Region } from '../geo';
import { createA320, restVisual } from './a320-model';
import { LIVERIES } from './liveries';
import { Kit, Lamps, Paving, kitMaterials, lightPools, signMesh, type KitMaterials, type LampSpec } from './airside-kit';
import type { Parts } from './airside-buildings';
import { homeSite, islandSite, type ParkedSpec, type Site } from './airside-sites';
import type { Path, Pose2 } from './airside-path';
import { Drivers, Fleet, PushbackTug, SIGNALS, VEHICLE, VEHICLE_NIGHT, placeCrew, type ArmPose, type Body, type VehicleKind } from './vehicles';

const DEG = Math.PI / 180;

/** The stands each airport keeps free for AI traffic (besides the player's). */
export const TRAFFIC_STANDS: Record<Region, readonly string[]> = { home: ['S5', 'S6'], island: ['S3', 'S4'] };

/** The stands to leave free at an airport: the player's and the traffic's (pass as `reserved`). */
export function reservedStands(region: Region): string[] {
  return [AIRFIELDS[region].playerStand, ...TRAFFIC_STANDS[region]];
}

/** How far from the airport's centre (m) each layer is drawn. */
const RANGE = { buildings: 14000, signs: 3000, detail: 2500, vehicles: 4000, pools: 8000, lamps: 30000 };
/** Below this the vehicles' logic runs every frame; beyond it a few times a second. */
const SLOW_STEP = 0.25;

const FONT = '"Arial Narrow", "Roboto Condensed", Arial, Helvetica, sans-serif';

/** An aircraft's footprint for the vehicles to keep clear of (wings included). */
const AIRCRAFT_HL = 19;
const AIRCRAFT_HW = 18;

interface ServiceCar {
  id: number;
  kind: VehicleKind;
  path: Path;
  s: number;
  v: number;
  lamp: number;
}

interface ParkedPlane {
  spec: ParkedSpec;
  model: PlaneModel;
  visual: PlaneVisual;
}

const _pose: Pose2 = { x: 0, z: 0, heading: 0 };
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Airside {
  readonly group = new THREE.Group();
  /** The player's pushback tug, waiting at the player's stand. */
  readonly tug: PushbackTug;
  /** The stands with a parked aircraft (the terminal should dock their jet bridges). */
  readonly parkedStands: readonly string[];

  private readonly ap: Airport;
  private readonly origin: THREE.Vector3;
  private readonly mats: KitMaterials;
  private readonly buildings: THREE.Object3D[] = [];
  private readonly detail: THREE.Mesh;
  private readonly signs: THREE.Mesh;
  private readonly lamps: Lamps;
  private readonly pools: ReturnType<typeof lightPools>;
  private readonly fleet: Fleet;
  private readonly drivers: Drivers;
  private readonly parked: ParkedPlane[] = [];
  private readonly service = new Map<string, { cars: ServiceCar[]; on: boolean }>();
  /** Lamps on the vehicles the airside moves itself (the stands' belt loaders) and the marshaller's wands. */
  private readonly ownLamps: Lamps;
  private readonly marshal: { ids: [number, number, number]; x: number; z: number; heading: number; wands: number };
  private readonly playerStand: { x: number; z: number; heading: number; noseX: number; noseZ: number };
  /** The player's aircraft (the marshaller watches it, the vehicles keep clear of it). */
  private player: { x: number; z: number; heading: number } | null = null;
  private lastGap = Infinity;
  private parkedFor = 0;
  /** Outside bodies the vehicles give way to: the player's aircraft, the tug, AI aircraft. */
  private readonly playerBody: Body = { x: 0, z: 0, heading: 0, hl: AIRCRAFT_HL, hw: AIRCRAFT_HW };
  private readonly obstacles: Body[] = [];
  private traffic: readonly Body[] = [];
  private night = -1;
  private lightsOn = false;
  private slow = 0;

  /**
   * `reserved`: stands left free (the player's, which is always kept free, and the AI traffic's).
   */
  constructor(ctx: Ctx, ap: Airport, opts: { reserved: string[] }) {
    this.ap = ap;
    const reserved = [...new Set([ap.playerStand, ...opts.reserved])];
    const st0 = ap.stands[0];
    // the airport's own origin keeps vertices precise 40 km out (Palm Cay)
    this.origin = new THREE.Vector3(0, 0, Math.round(st0.z));
    this.mats = kitMaterials();
    this.group.name = `airside-${ap.geo.id}`;

    const parts: Parts = { paint: new Kit(), detail: new Kit(), glass: new Kit(), paving: new Paving(), signs: [], lamps: [], pools: [] };
    const site: Site = ap.geo.id === 'home' ? homeSite(ap, parts, reserved) : islandSite(ap, parts, reserved);
    const shadows = ctx.quality.shadows;

    // ---------------------------------------------------------------- static meshes
    const mesh = (k: Kit, m: THREE.Material, name: string, cast: boolean) => {
      const g = k.build().translate(-this.origin.x, 0, -this.origin.z);
      g.computeBoundingSphere();
      const o = new THREE.Mesh(g, m);
      o.position.copy(this.origin);
      o.castShadow = cast && shadows;
      o.receiveShadow = shadows;
      o.name = name;
      this.group.add(o);
      return o;
    };
    this.buildings.push(mesh(parts.paint, this.mats.paint, 'airside-buildings', true));
    this.buildings.push(mesh(parts.glass, this.mats.glass, 'airside-glass', false));
    this.detail = mesh(parts.detail, this.mats.paint, 'airside-detail', true);
    const paving = parts.paving.build(this.origin, ctx.renderer, this.mats.u);
    this.group.add(paving);
    this.buildings.push(paving);
    this.signs = signMesh(parts.signs, this.origin, ctx.renderer, this.mats.u, FONT);
    this.group.add(this.signs);
    this.lamps = new Lamps(parts.lamps, this.origin);
    this.group.add(this.lamps.points);
    this.pools = lightPools(parts.pools, this.origin, ctx.renderer);
    this.group.add(this.pools.mesh);

    // ---------------------------------------------------------------- the vehicles and the crew
    const kinds: { kind: VehicleKind; variant: number; count: number }[] = [];
    const need = (kind: VehicleKind, variant = 0) => kinds.push({ kind, variant, count: 1 });
    for (const s of site.statics) {
      need(s.kind, s.variant);
      if (s.kind === 'catering') need('cateringBox');
    }
    for (const r of site.routes) {
      need(r.kind, r.variant);
      if (r.kind === 'catering') need('cateringBox');
      for (let i = 0; i < (r.train?.count ?? 0); i++) need(r.train!.kind, i + (r.variant ?? 0));
    }
    for (const cars of Object.values(site.service)) for (const c of cars) need(c.kind);
    // every crew member and the marshaller: a body and two arms
    for (let i = 0; i <= site.crew.length; i++) {
      need('crew');
      need('armL');
      need('armR');
    }
    this.fleet = new Fleet(this.origin, kinds, shadows);
    this.group.add(this.fleet.mesh);

    for (const s of site.statics) {
      const id = this.fleet.add(s.kind, s.variant ?? 0);
      this.fleet.place(id, s.x, s.y ?? 0, s.z, s.heading);
      if (s.kind === 'catering') {
        // the box up at the cabin door (as the drivers lift it, vehicles.ts)
        const f = headingVec(s.heading);
        this.fleet.place(this.fleet.add('cateringBox'), s.x + f.x * 0.6, A320_POINTS.doorL1.y - 0.05, s.z + f.z * 0.6, s.heading);
      }
    }
    for (const c of site.crew) {
      const ids = this.crewIds();
      placeCrew(this.fleet, ids, c.x, c.z, c.heading, SIGNALS.rest, this.origin);
    }
    const m = site.marshaller;
    this.marshal = { ids: this.crewIds(), x: m.x, z: m.z, heading: m.heading, wands: 0 };
    placeCrew(this.fleet, this.marshal.ids, m.x, m.z, m.heading, SIGNALS.rest, this.origin);

    // the reserved stands' belt loaders, waiting at the head of their stands, with their lamps
    const own: LampSpec[] = [];
    for (const [standId, cars] of Object.entries(site.service)) {
      const list: ServiceCar[] = cars.map((c) => {
        const id = this.fleet.add(c.kind);
        const lamp = own.length;
        const V = VEHICLE[c.kind];
        if (V.beacon) own.push({ x: 0, y: -100, z: 0, r: 2.6, g: 1.2, b: 0.15, size: 0.28, mode: 'beacon', day: 0.55, phase: Math.random() });
        return { id, kind: c.kind, path: c.path, s: 0, v: 0, lamp: V.beacon ? lamp : -1 };
      });
      this.service.set(standId, { cars: list, on: false });
    }
    this.marshal.wands = own.length;
    for (let i = 0; i < 2; i++) own.push({ x: 0, y: -100, z: 0, r: 3.2, g: 1.1, b: 0.12, size: 0.2, mode: 'steady', day: 0.6 });
    this.ownLamps = new Lamps(own, this.origin, true);
    this.group.add(this.ownLamps.points);
    for (const s of this.service.values()) for (const c of s.cars) this.placeService(c);

    this.drivers = new Drivers(this.fleet, site.routes, this.origin);
    this.group.add(this.drivers.lamps.points);

    // ---------------------------------------------------------------- the parked fleet
    for (const spec of site.parked) {
      const model = createA320({ livery: LIVERIES[spec.livery], detail: 'parked', shadows });
      model.group.position.set(spec.x, 0, spec.z);
      model.group.rotation.set(0, -spec.heading * DEG, 0, 'YXZ');
      const visual = restVisual();
      if (spec.doors) {
        visual.doorL1 = 1;
        visual.cargo = 1;
      }
      model.setVisual(visual, 0, 0);
      this.group.add(model.group);
      this.parked.push({ spec, model, visual });
    }
    this.parkedStands = site.parked.filter((p) => p.stand).map((p) => p.stand!);

    // ---------------------------------------------------------------- the player's stand
    this.tug = new PushbackTug(ctx, ap);
    this.group.add(this.tug.group);
    const ps = ap.stands.find((s) => s.id === ap.playerStand)!;
    this.playerStand = { x: ps.x, z: ps.z, heading: ps.heading, noseX: ps.noseStop.x, noseZ: ps.noseStop.z };
    this.setNight(0);
  }

  private crewIds(): [number, number, number] {
    return [this.fleet.add('crew'), this.fleet.add('armL'), this.fleet.add('armR')];
  }

  /** The night level (0 day .. 1 night): lit windows, signs, floodlights, the parked aircraft's lights. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 1e-3) return;
    this.night = k;
    this.mats.u.uNight.value = k;
    VEHICLE_NIGHT.uNight.value = k;
    this.pools.set(k);
    for (const p of this.parked) p.model.setNight(k);
    // the parked aircraft being worked have their nav lights, logo lights and cabin on after dark
    const on = k > 0.35;
    if (on !== this.lightsOn) {
      this.lightsOn = on;
      for (const p of this.parked) {
        const lit = on && p.spec.doors && !p.spec.hangar;
        const l = p.visual.lights;
        l.nav = lit;
        l.logo = lit;
        l.cabin = on && p.spec.doors;
        p.model.setVisual(p.visual, 0, 0);
      }
    }
  }

  /**
   * The player's aircraft on the ground here (its reference point and heading), or null when it's
   * elsewhere: the marshaller guides it onto the stand, and the vehicles give way to it.
   */
  setPlayerAircraft(pose: { x: number; z: number; heading: number } | null) {
    this.player = pose;
  }

  /** The AI aircraft on the ground here, for the vehicles to give way to (Traffic.bodies). */
  setAircraft(bodies: readonly Body[]) {
    this.traffic = bodies;
  }

  /** Whether the stand's belt loaders drive up to the holds (an aircraft is on it) or wait at the head of the stand. */
  setStandService(standId: string, on: boolean) {
    const s = this.service.get(standId);
    if (s) s.on = on;
  }

  update(dt: number, t: number, camera: THREE.Camera) {
    const dist = Math.hypot(camera.position.x - this.origin.x, camera.position.z - this.origin.z);
    const near = dist < RANGE.vehicles;
    for (const b of this.buildings) b.visible = dist < RANGE.buildings;
    for (const p of this.parked) p.model.group.visible = dist < RANGE.buildings;
    this.detail.visible = dist < RANGE.detail;
    this.signs.visible = dist < RANGE.signs;
    this.pools.mesh.visible = this.night > 0.02 && dist < RANGE.pools;
    this.lamps.points.visible = dist < RANGE.lamps;
    this.fleet.mesh.visible = near;
    this.drivers.lamps.points.visible = near;
    this.ownLamps.points.visible = near;
    this.tug.group.visible = near;
    const night = Math.max(0, this.night);
    this.lamps.update(t, night);
    this.ownLamps.update(t, night);
    this.drivers.setTime(t, night);
    this.tug.update(dt, t, night);

    // what the vehicles give way to
    this.obstacles.length = 0;
    if (this.player) {
      this.playerBody.x = this.player.x;
      this.playerBody.z = this.player.z;
      this.playerBody.heading = this.player.heading;
      this.obstacles.push(this.playerBody);
    }
    this.obstacles.push(this.tug.body);
    for (const b of this.traffic) this.obstacles.push(b);

    if (near) {
      this.drivers.update(dt, this.obstacles, true);
      this.updateService(dt);
      this.updateMarshaller(dt, t);
      this.ownLamps.commit();
    } else {
      // nobody can see them: keep them going round, a few steps a second
      this.slow += dt;
      if (this.slow >= SLOW_STEP) {
        this.drivers.update(Math.min(this.slow, 1), this.obstacles, false);
        this.slow = 0;
      }
    }
  }

  // ------------------------------------------------------------------------------------------------

  private updateService(dt: number) {
    for (const [standId, s] of this.service) {
      // the player's stand: loaders up while the aircraft sits on the stand, away before the tug comes
      const on = standId === this.ap.playerStand ? this.parkedFor > 12 && !this.tug.attached : s.on;
      for (const c of s.cars) {
        const target = on ? c.path.length : 0;
        const left = target - c.s;
        if (Math.abs(left) < 0.02 && c.v === 0) continue;
        const vmax = left > 0 ? 3 : 1.6; // in forwards, out in reverse
        const want = Math.min(vmax, Math.sqrt(2 * 0.8 * Math.abs(left)));
        c.v = Math.min(want, c.v + 0.9 * dt);
        const step = Math.min(Math.abs(left), c.v * dt);
        c.s += Math.sign(left) * step;
        if (Math.abs(target - c.s) < 0.02) {
          c.s = target;
          c.v = 0;
        }
        this.placeService(c);
      }
    }
  }

  private placeService(c: ServiceCar) {
    c.path.at(c.s, _pose);
    this.fleet.place(c.id, _pose.x, 0, _pose.z, _pose.heading);
    if (c.lamp < 0) return;
    const b = VEHICLE[c.kind].beacon!;
    const f = headingVec(_pose.heading);
    // vehicle frame: −z forward, +x right; the beacon shows only while it's moving or working
    const lit = c.v > 0 || c.s > 0;
    this.ownLamps.move(c.lamp, _pose.x - f.z * b[0] - f.x * b[2] - this.origin.x, lit ? b[1] : -100, _pose.z + f.x * b[0] - f.z * b[2] - this.origin.z);
  }

  /** The marshaller's signals, from where the player's nose wheel is against the stand's stop mark. */
  private updateMarshaller(dt: number, t: number) {
    const M = this.marshal;
    let arms: ArmPose = SIGNALS.rest;
    let wands = false;
    const p = this.player;
    if (p) {
      const st = this.playerStand;
      const f = headingVec(p.heading);
      const nx = p.x + f.x * -A320_POINTS.noseGear.z;
      const nz = p.z + f.z * -A320_POINTS.noseGear.z;
      const sf = headingVec(st.heading);
      // how far the nose wheel still has to go along the lead-in line, and how far off it it is
      const gap = (st.noseX - nx) * sf.x + (st.noseZ - nz) * sf.z;
      const off = Math.abs((nx - st.noseX) * -sf.z + (nz - st.noseZ) * sf.x);
      const closing = gap < this.lastGap - 0.01 * dt;
      const moving = Math.abs(gap - this.lastGap) > 0.05 * dt;
      this.lastGap = gap;
      if (off < 25 && gap > -3 && gap < 1.2 && !moving) {
        // on the mark: "stop" held a while, then the arms come down
        this.parkedFor += dt;
        arms = this.parkedFor < 10 ? SIGNALS.stop : SIGNALS.rest;
        wands = this.parkedFor < 10;
      } else {
        if (moving) this.parkedFor = 0;
        if (off < 25 && closing && gap > 1.2 && gap < 160) {
          arms = gap > 18 ? SIGNALS.ahead(t) : gap > 3 ? SIGNALS.slow(t) : SIGNALS.stop;
          wands = true;
        } else if (!closing && moving && gap < 60 && this.tug.attached) {
          // pushed back: the all-clear
          arms = SIGNALS.clear;
        }
      }
    } else {
      this.lastGap = Infinity;
      this.parkedFor = 0;
    }
    placeCrew(this.fleet, M.ids, M.x, M.z, M.heading, arms, this.origin);
    for (let i = 0; i < 2; i++) {
      if (!wands) {
        this.ownLamps.move(M.wands + i, 0, -100, 0);
        continue;
      }
      // the wand's glowing tip, wherever the arm has put it
      this.fleet.mesh.getMatrixAt(M.ids[1 + i], _m);
      _v.set(0, -1.3, 0).applyMatrix4(_m);
      this.ownLamps.move(M.wands + i, _v.x, _v.y, _v.z);
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const p of this.parked) p.model.dispose();
    this.tug.dispose();
    this.drivers.dispose();
    this.lamps.dispose();
    this.ownLamps.dispose();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.name.startsWith('airside')) mesh.geometry.dispose();
    });
    this.fleet.mesh.dispose();
    for (const m of [this.mats.paint, this.mats.glass]) m.dispose();
  }
}
