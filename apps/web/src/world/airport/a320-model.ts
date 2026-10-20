// The 3D Airbus A320neo: a procedurally built, livery-painted, fully animated model for the
// player's aircraft, the AI traffic and the parked fleet (see aviation/types.ts PlaneModel).
//
// One skinned mesh draws the whole airframe (every moving part is a bone: a320/rig.ts), with one
// material over one painted texture atlas (a320/paint.ts). Each detail level's geometry is built
// once and shared by every aircraft of that level; atlases are shared per livery. Flying traffic
// and the hero swap to lighter geometry with distance (THREE.LOD, all levels on one skeleton).
// The lights are one point-sprite draw for the flares and one for the beams.
//
// Draw calls per aircraft: parked 1 (+1 for its lights when any are on), ai 1–3, hero 1–3 (plus
// the shadow pass when it casts shadows).

import * as THREE from 'three';
import { withFogSun } from '../fog';
import { canvasTex } from '../textures';
import type { Livery, PlaneModel, PlaneModelOptions, PlaneVisual } from '../../aviation/types';
import { A320_POINTS } from '../../aviation/a320';
import { LIVERIES, isFreighter } from './liveries';
import { airframeGeometry } from './a320/build';
import type { Detail } from './a320/airframe';
import { paintGlow, paintLivery, paintSurface } from './a320/paint';
import { Beams, Flares, type Lamp } from './a320/lights';
import { Pose } from './a320/pose';

export { LIVERIES };

/** Options beyond the shared PlaneModelOptions contract (all optional). */
export interface A320Extras {
  /** The hero's shadowless landing-light SpotLight (default true; pass `ctx.quality.extraLights`). */
  spotLight?: boolean;
  /** Paint the hero's atlas at the base 2048 × 1024 instead of 4096 × 2048 (phones, low tiers). */
  lowMemory?: boolean;
}

/** A visual at rest: on the ground, gear down, everything stowed, lights off. */
export function restVisual(): PlaneVisual {
  return {
    flapsDeg: 0,
    slatsDeg: 0,
    gear: 1,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    spoilerL: 0,
    spoilerR: 0,
    reverser: 0,
    n1: [0, 0],
    nosewheel: 0,
    wheelSpin: 0,
    compression: [0.2, 0.22, 0.22],
    doorL1: 0,
    doorL2: 0,
    cargo: 0,
    lights: { nav: false, beacon: false, strobe: false, landing: false, taxi: false, logo: false, cabin: false },
  };
}

// ------------------------------------------------------------------------------------------------
// Shared textures
// ------------------------------------------------------------------------------------------------

interface Atlas {
  tex: THREE.CanvasTexture;
  users: number;
}
const atlases = new Map<string, Atlas>();
const dataMaps = new Map<string, THREE.CanvasTexture>();

const liveryKey = (l: Livery, k: number) => `${k}|${l.name}|${l.code}|${l.fuselage}|${l.belly}|${l.cheatline}|${l.tail}|${l.tailArt}|${l.engines}|${l.registration}`;

function liveryAtlas(l: Livery, k: number) {
  const key = liveryKey(l, k);
  let a = atlases.get(key);
  if (!a) {
    const freighter = isFreighter(l);
    const tex = canvasTex(paintLivery(l, k, freighter));
    tex.anisotropy = 8;
    a = { tex, users: 0 };
    atlases.set(key, a);
    // titles use the display font: repaint once it has loaded if it wasn't ready yet
    if (typeof document !== 'undefined' && document.fonts && !document.fonts.check('40px "Lilita One"')) {
      const t = tex;
      void document.fonts.load('40px "Lilita One"').then(() => {
        if (!document.fonts.check('40px "Lilita One"')) return;
        t.image = paintLivery(l, k, freighter);
        t.needsUpdate = true;
      });
    }
  }
  a.users++;
  return { key, tex: a.tex };
}

function releaseAtlas(key: string) {
  const a = atlases.get(key);
  if (!a) return;
  if (--a.users <= 0) {
    a.tex.dispose();
    atlases.delete(key);
  }
}

function dataMap(kind: 'surface' | 'glow', freighter: boolean) {
  const key = `${kind}|${freighter}`;
  let t = dataMaps.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(kind === 'surface' ? paintSurface(freighter) : paintGlow(freighter));
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 4;
    dataMaps.set(key, t);
  }
  return t;
}

// ------------------------------------------------------------------------------------------------
// The material: standard PBR with the night lighting read from the glow map's channels
// ------------------------------------------------------------------------------------------------

interface SkinUniforms {
  uCabin: THREE.IUniform<number>;
  uLogo: THREE.IUniform<number>;
  uLamp: THREE.IUniform<number>;
  /** 1 in the cockpit camera: the nose round the flight deck isn't drawn, the wings and engines still are. */
  uCockpit: THREE.IUniform<number>;
}

/** In the cockpit view the fuselage ahead of this station (body z) is cut away, round the captain's eye. */
const COCKPIT_CUT_Z = A320_POINTS.eye.z + 4.6;

function skinMaterial(map: THREE.Texture, freighter: boolean) {
  const surface = dataMap('surface', freighter);
  const m = new THREE.MeshStandardMaterial({
    map,
    roughnessMap: surface,
    metalnessMap: surface,
    roughness: 1,
    metalness: 1,
    emissive: '#ffffff',
    emissiveMap: dataMap('glow', freighter),
    envMapIntensity: 1.1,
  });
  const u: SkinUniforms = { uCabin: { value: 0 }, uLogo: { value: 0 }, uLamp: { value: 0 }, uCockpit: { value: 0 } };
  m.onBeforeCompile = (shader) => {
    withFogSun(shader);
    Object.assign(shader.uniforms, u);
    // the body-frame position before skinning (the nose is on the root bone, so it never moves)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBody;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBody = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCabin;\nuniform float uLogo;\nuniform float uLamp;\nuniform float uCockpit;\nvarying vec3 vBody;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        if ( uCockpit > 0.5 && vBody.z < ${COCKPIT_CUT_Z.toFixed(2)} && abs( vBody.x ) < 2.3 ) discard;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `vec4 glowTexel = texture2D( emissiveMap, vEmissiveMapUv );
        // warm cabin light through the windows, the logo lights washing the fin in its own colours, the nose-gear lamps
        totalEmissiveRadiance = vec3( 1.0, 0.78, 0.5 ) * glowTexel.r * uCabin + diffuseColor.rgb * glowTexel.g * uLogo + vec3( 1.0, 0.97, 0.9 ) * glowTexel.b * uLamp;`,
      );
  };
  m.customProgramCacheKey = () => 'a320-skin';
  return { m, u };
}

// ------------------------------------------------------------------------------------------------
// The model
// ------------------------------------------------------------------------------------------------

/** Each level and the distance (m) from which the next lighter one takes over. */
/** A rotating beacon's flash: a short bright pulse once per turn (x in turns). */
const pulse = (x: number) => Math.exp(-(((x % 1) - 0.5) ** 2) / 0.004);

const LOD_CHAIN: Record<Detail, [Detail, number][]> = {
  hero: [['hero', 0], ['ai', 320], ['parked', 1400]],
  ai: [['ai', 0], ['parked', 650]],
  parked: [['parked', 0]],
};

class A320Model implements PlaneModel {
  readonly group = new THREE.Group();
  readonly livery: Livery;
  private readonly pose = new Pose();
  private readonly meshes: THREE.SkinnedMesh[] = [];
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly u: SkinUniforms;
  private readonly atlasKey: string;
  private readonly flares = new Flares();
  private readonly beams: Beams | null;
  private readonly spot: THREE.SpotLight | null;
  private night = 0;
  private cockpit = false;
  private readonly lamps: Record<Lamp, number> = { navL: 0, navR: 0, tail: 0, strobeL: 0, strobeR: 0, strobeT: 0, beaconT: 0, beaconB: 0, landL: 0, landR: 0, taxi: 0, turnL: 0, turnR: 0 };
  /** Each aircraft's beacons and strobes keep their own rhythm, as real ones do. */
  private readonly phase = Math.random();

  constructor(opts: PlaneModelOptions, extra: A320Extras) {
    this.livery = opts.livery;
    this.group.name = `A320 ${opts.livery.registration}`;
    const freighter = isFreighter(opts.livery);
    const k = opts.detail === 'hero' && !extra.lowMemory ? 2 : 1;
    const atlas = liveryAtlas(opts.livery, k);
    this.atlasKey = atlas.key;
    const { m, u } = skinMaterial(atlas.tex, freighter);
    this.mat = m;
    this.u = u;

    this.group.add(this.pose.root);
    const chain = LOD_CHAIN[opts.detail];
    const lod = chain.length > 1 ? new THREE.LOD() : null;
    const identity = new THREE.Matrix4();
    for (const [detail, dist] of chain) {
      const mesh = new THREE.SkinnedMesh(airframeGeometry(detail), m);
      mesh.bind(this.pose.skeleton, identity);
      // the airframe always fits this sphere, whatever its gear and surfaces are doing
      mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4, 1), 22);
      mesh.castShadow = opts.shadows;
      mesh.receiveShadow = opts.shadows && detail === 'hero';
      mesh.name = `a320-${detail}`;
      this.meshes.push(mesh);
      if (lod) lod.addLevel(mesh, dist);
    }
    const body = lod ?? this.meshes[0];
    this.group.add(body);
    this.group.add(this.flares.points);

    this.beams = opts.detail === 'parked' ? null : new Beams();
    if (this.beams) this.group.add(this.beams.mesh);
    if (opts.detail === 'hero' && extra.spotLight !== false) {
      // one shadowless spot stands in for both landing lights (it lights the runway, the haze does the beams)
      const p = A320_POINTS.landingLightL;
      const spot = new THREE.SpotLight('#fff4e0', 0, 900, 0.36, 0.55, 1.2);
      spot.position.set(0, p.y, p.z);
      spot.target.position.set(0, p.y - 9, p.z - 160);
      spot.castShadow = false;
      this.group.add(spot, spot.target);
      this.spot = spot;
    } else this.spot = null;

    this.setVisual(restVisual(), 0, 0);
  }

  setVisual(v: PlaneVisual, dt: number, t: number) {
    this.pose.apply(v, dt);
    const L = v.lights;
    const lamps = this.lamps;
    const nav = L.nav ? 1 : 0;
    lamps.navL = nav;
    lamps.navR = nav;
    lamps.tail = nav;
    // strobes: a double flash every 1.1 s (wings), the tail's single flash in between
    const sp = (t / 1.1 + this.phase) % 1;
    const dbl = sp < 0.035 || (sp > 0.11 && sp < 0.145) ? 1 : 0;
    lamps.strobeL = L.strobe ? dbl : 0;
    lamps.strobeR = L.strobe ? dbl : 0;
    lamps.strobeT = L.strobe && sp > 0.5 && sp < 0.535 ? 1 : 0;
    // beacons: a rotating red flash, ~55 per minute, top and bottom alternating a little
    const bp = (t * 0.92 + this.phase * 7) % 1;
    lamps.beaconT = L.beacon ? pulse(bp) : 0;
    lamps.beaconB = L.beacon ? pulse(bp + 0.5) : 0;
    // the landing lights are in the wing roots; the taxi and turn-off lights ride the nose leg
    const land = L.landing ? 1 : 0;
    lamps.landL = land;
    lamps.landR = land;
    const legDown = v.gear > 0.97 ? 1 : 0;
    const taxi = L.taxi ? legDown : 0;
    // (from the flight deck the nose-leg lamps are under the cut-away nose: only their beams show)
    const noseLamps = this.cockpit ? 0 : taxi;
    lamps.taxi = noseLamps;
    lamps.turnL = noseLamps;
    lamps.turnR = noseLamps;
    this.flares.set(lamps, this.night);
    this.beams?.set(land, land, taxi, this.night);
    // (in the scene's units, where the sun is ~3: a pool of light on the runway ahead, never a white-out)
    if (this.spot) this.spot.intensity = land * (12 + 110 * this.night) + taxi * 30 * this.night;
    this.u.uCabin.value = L.cabin ? 0.55 + 1.6 * this.night : 0;
    this.u.uLogo.value = L.logo ? 0.45 * this.night : 0;
    this.u.uLamp.value = taxi * (0.6 + 2.4 * this.night);
  }

  setCockpitView(on: boolean) {
    // the flight deck is a 2D overlay: from the captain's eye the nose would only be in the way, but
    // the wings, engines and their lamps out of the side windows stay (the shadow keeps the whole airframe)
    this.cockpit = on;
    this.u.uCockpit.value = on ? 1 : 0;
  }

  setNight(k: number) {
    this.night = Math.min(1, Math.max(0, k));
  }

  dispose() {
    this.group.removeFromParent();
    this.mat.dispose();
    this.flares.dispose();
    this.beams?.dispose();
    this.spot?.dispose();
    this.pose.skeleton.dispose();
    releaseAtlas(this.atlasKey);
  }
}

/**
 * Builds an A320neo. Geometry is shared per detail level and atlases per livery, so a fleet costs
 * little more than one aircraft in memory; `parked` draws in one call.
 */
export function createA320(opts: PlaneModelOptions, extra: A320Extras = {}): PlaneModel {
  return new A320Model(opts, extra);
}

/**
 * Builds the shared geometry and paints the atlases ahead of time (e.g. during a loading screen),
 * so the first aircraft of each kind appears without a hitch.
 */
export function warmA320(details: Detail[], liveries: Livery[]) {
  for (const d of details) airframeGeometry(d);
  for (const l of liveries) releaseAtlasLater(liveryAtlas(l, 1).key);
}

/** Keep a warmed atlas cached without a user: it's released when the last real user goes. */
function releaseAtlasLater(key: string) {
  const a = atlases.get(key);
  if (a) a.users--;
}
