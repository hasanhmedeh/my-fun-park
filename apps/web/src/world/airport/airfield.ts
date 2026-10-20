// An airport's airfield: the runway, taxiways and apron with all their paint, the runway, approach
// and taxiway lighting, the PAPI, the ILS antennas, the signs, the windsocks, the perimeter fence
// and its security road. Built for either airport from its numbers (world/geo.ts) and its taxi
// network (aviation/airports.ts), so what the pilot sees is exactly what the flight model, ATC and
// the taxi guidance use.
//
// The plan (airfield-plan.ts) works out every shape, stroke, light and sign as plain data; the
// pavement is rasterised into a distance-field texture (airfield-field.ts) that the ground's
// shader draws from (airfield-ground.ts) and surfaceAt reads back; the thin paint is one ribbon
// mesh (airfield-paint.ts); lights are one instanced flare mesh (airfield-lights.ts); signs one
// merged mesh (airfield-signs.ts); the masts, antennas, fence and road a few more
// (airfield-furniture.ts). About a dozen draw calls in all.

import * as THREE from 'three';
import type { Ctx } from '../context';
import type { Airport } from '../../aviation/airports';
import type { Surface } from '../../aviation/types';
import { buildField, paveAt, surfaceOf, type PaveField } from './airfield-field';
import { addTaxiEdgeLights, guidanceLights, planAirfield, type AirfieldPlan } from './airfield-plan';
import { StripOverlay, decalMesh, designatorDecals, groundMesh } from './airfield-ground';
import { AirfieldLights } from './airfield-lights';
import { PaintLines } from './airfield-paint';
import { signsMesh } from './airfield-signs';
import { Windsocks, fence, fittings, hardware, securityRoad } from './airfield-furniture';

/** How far ahead of the aircraft follow-the-greens lights the route (m). */
const GUIDANCE_AHEAD = 650;
/** By day the lamps the pilot must obey (stop bars, guard lights, the PAPI, the guidance) still show this bright. */
const DAY_MIN = 0.85;

/**
 * Beyond these distances (m, from the airfield's area) things aren't drawn: the small things
 * soon, the pavement once the haze has swallowed it, the lights last (they read from far off).
 */
const LOD = { ground: 22000, lights: 30000, paint: 7000, fittings: 2500, signs: 4000, fence: 3500, socks: 3000, decals: 7000, hardware: 8000, road: 9000 };

export class Airfield {
  readonly group = new THREE.Group();
  readonly plan: AirfieldPlan;
  private field: PaveField;
  private lights: AirfieldLights;
  private socks: Windsocks;
  private strip: StripOverlay;
  private paint: PaintLines;
  private signs: THREE.Mesh;
  private signMat: THREE.MeshStandardMaterial;
  private parts: { obj: THREE.Object3D; range: number }[] = [];
  private k = 0;
  private route: string[] | null = null;
  private routeFrom = 0;
  private red = new Map<string, boolean>();

  constructor(
    private ctx: Ctx,
    ap: Airport,
  ) {
    const q = ctx.quality;
    this.plan = planAirfield(ap);
    const texel = q.tier === 'lowest' ? 2 : q.tier === 'low' ? 1.5 : 1;
    this.field = buildField(this.plan, texel);
    addTaxiEdgeLights(this.plan, (x, z) => paveAt(this.field, x, z));
    for (const h of this.plan.holds) this.red.set(h.id, true);

    const origin = new THREE.Vector3(this.plan.runway.cx, 0, this.plan.runway.cz);
    const ground = groundMesh(this.plan, this.field);
    this.strip = new StripOverlay(this.plan, this.field);
    this.paint = new PaintLines(this.plan, origin);
    const decals = decalMesh([...this.plan.decals, ...designatorDecals(this.plan)], ctx.renderer);
    this.lights = new AirfieldLights(this.plan.lights, origin);
    this.signs = signsMesh(this.plan.signs, ctx.renderer, origin);
    this.signMat = this.signs.material as THREE.MeshStandardMaterial;
    const kit = hardware(this.plan, origin);
    this.socks = new Windsocks(this.plan.windsocks, origin);
    const road = securityRoad(this.plan, ctx.renderer, origin);
    for (const m of [kit, this.signs, this.socks.mesh]) {
      m.castShadow = q.shadows;
      m.receiveShadow = q.shadows;
    }
    this.group.add(ground, this.strip.mesh, this.paint.mesh, decals, this.lights.mesh, this.signs, kit, this.socks.mesh, road);
    this.parts.push(
      { obj: ground, range: LOD.ground },
      { obj: this.strip.mesh, range: LOD.ground },
      { obj: this.lights.mesh, range: LOD.lights },
      { obj: decals, range: LOD.decals },
      { obj: this.paint.mesh, range: LOD.paint },
      { obj: this.signs, range: LOD.signs },
      { obj: kit, range: LOD.hardware },
      { obj: this.socks.mesh, range: LOD.socks },
      { obj: road, range: LOD.road },
    );
    if (q.tier !== 'lowest') {
      const fit = fittings(this.plan, origin);
      this.group.add(fit);
      this.parts.push({ obj: fit, range: LOD.fittings });
      const f = fence(this.plan, origin);
      this.group.add(f);
      this.parts.push({ obj: f, range: LOD.fence });
    }
    this.setLights(0);
  }

  /** The pavement under a point: 'runway' (with its shoulders and blast pads), 'taxiway' or 'apron'; null off it. */
  surfaceAt(x: number, z: number): Surface | null {
    return surfaceOf(this.plan, this.field, x, z);
  }

  /** 0 off (day) .. 1 full (night / low visibility). The lamps the pilot must obey stay on by day. */
  setLights(k: number) {
    this.k = k;
    const L = this.lights;
    for (const g of ['runway', 'approach', 'taxiEdge', 'obstruction'] as const) L.setGroup(g, k);
    for (const g of ['papi', 'stopbar', 'guard'] as const) L.setGroup(g, Math.max(k, DAY_MIN));
    L.setGroup('taxi', this.route ? Math.max(k, DAY_MIN) : k);
    // the signs are lit from inside
    this.signMat.emissiveIntensity = 0.8 * k;
  }

  /**
   * Follow the greens: light the taxiway centreline along these taxi nodes, from node `fromIndex`
   * for GUIDANCE_AHEAD metres, up to the first red stop bar (null: the normal lighting, all on).
   */
  setGuidance(route: string[] | null, fromIndex = 0) {
    const next = route && route.length > 1 ? route : null;
    // cheap to call every frame: only a new route or a new node along it relights anything
    const same = next === this.route || (next && this.route && next.length === this.route.length && next.every((id, i) => id === this.route![i]));
    if (same && fromIndex === this.routeFrom) return;
    this.route = next;
    this.routeFrom = fromIndex;
    this.refreshTaxi();
    this.setLights(this.k);
  }

  /** A holding point's stop bar (by its hold node id, e.g. 'HA4'): red, or off (crossing cleared). */
  setStopBar(hold: string, red: boolean) {
    if (!this.red.has(hold) || this.red.get(hold) === red) return;
    this.red.set(hold, red);
    this.plan.lights.forEach((l, i) => {
      if (l.group === 'stopbar' && l.hold === hold) this.lights.set(i, red);
    });
    this.refreshTaxi();
  }

  /** The wind the windsocks show. */
  setWind(fromDeg: number, kt: number) {
    this.socks.setWind(fromDeg, kt);
  }

  private refreshTaxi() {
    const red = (h: string) => this.red.get(h) ?? false;
    const lit = this.route ? guidanceLights(this.plan, this.route, this.routeFrom, GUIDANCE_AHEAD, red) : null;
    this.plan.lights.forEach((l, i) => {
      if (l.group !== 'taxi') return;
      // the lead-on lights past a red stop bar stay dark
      this.lights.set(i, lit ? lit.has(i) : !(l.hold && red(l.hold)));
    });
    this.lights.commit();
  }

  /** The flares' clock and projection, the windsocks, and what's near enough to draw. */
  update(_dt: number, t: number, camera: THREE.Camera) {
    const cam = camera as THREE.PerspectiveCamera;
    const fog = this.ctx.scene.fog as THREE.FogExp2 | null;
    this.lights.update(t, cam, this.ctx.renderer, fog, this.k);
    this.paint.setPixelScale(this.ctx.renderer.domElement.height / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) / cam.zoom));
    this.strip.setFog(fog && 'density' in fog ? fog.density : 0);
    const r = this.plan.region;
    const p = camera.position;
    const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
    const dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
    const d = Math.hypot(dx, dz, p.y);
    for (const part of this.parts) part.obj.visible = d < part.range;
    if (this.socks.mesh.visible) this.socks.update(t);
  }
}
