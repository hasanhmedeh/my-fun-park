import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Sky } from 'three/addons/objects/Sky.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { std, staticCylinder, type Ctx } from './context';
import { Grass } from './grass';
import { DISTRICTS, FENCE_GAP, flipLocal, GROUND, inValley, LAYOUT, MIDWAY, onFootprint, onMuseum, onPath, PARK, parkDistance, PATHS, PLAZAS, VALLEY, WHEEL_LAWN, WHEEL_ROAD, type DistrictId } from './layout';
import type { Quality } from './quality';
import { mulberry } from './random';
import { detailNormalTexture, glowTexture, groundTexture, hdr, PALETTE, lawnPatchTexture, poolTexture, stripeTexture } from './textures';
import { addWind } from './wind';
import { nearTrack } from './rides';
import { fogSun, installSunFog, withFogSun } from './fog';
import { nearCircuit, WALL } from './attractions/speedway-track';
import { nearTrail, WALL as TRAIL_WALL } from './attractions/trail-track';
import { Terrain, onLand } from './terrain';
import { Sea } from './sea';
import { Clouds } from './clouds';

export { mulberry };

const FOG_DENSITY = 0.0026;
/** A full 24-hour day lasts this many real seconds (10 minutes). */
export const DAY_SECONDS = 600;
/** For now the park is held at a sunny 4 pm (see TIME_CONTROLS in Game.ts). */
export const START_HOUR = 16;

/** How the park clock moves: the 10-minute day cycle, frozen at a chosen hour, or the visitor's own local time. */
export type TimeMode = 'cycle' | 'paused' | 'local';

const col = (c: string) => new THREE.Color(c);
// palette keyframes: [night, sunrise/sunset glow, full day]
const HEMI_SKY = [col('#2c3866'), col('#9a8ee0'), col('#c9cfd6')];
const HEMI_GROUND = [col('#18131f'), col('#4a3b30'), col('#5e5240')];
const FOG = [col('#0d1426'), col('#584a70'), col('#7f9fc2')];
const FOG_SUN = [col('#1c2850'), col('#f0a06a'), col('#c9c3b4')];
/** The haze seen from the air over tens of kilometres: paler than the park's blue fog, matching the sky at the horizon. */
const AIR_HAZE = [col('#0f182c'), col('#a08c96'), col('#bccad8')];
const SUN_WARM = col('#ffbe86');
const SUN_NOON = col('#fff3e2');
const MOON = col('#9eb6ff');
const ENV_GROUND = [col('#0c1410'), col('#24402f'), col('#3d6a48')];
/** What reflections see below the horizon out over the sea. */
const ENV_SEA = [col('#05080e'), col('#1c2a3a'), col('#28465a')];
/** Inside a cloud: the fog closes in to this (m, 98 %) and turns cloud-grey. */
const IN_CLOUD_VIS = 45;
/** The walking camera's planes (Game.ts builds the camera with them). */
const WALK_FAR = 2400;
const WALK_NEAR = 0.5;
const SHADOW_SPAN = 46;

/** night → glow → day blend of three colours. */
function tri(out: THREE.Color, c: THREE.Color[], day: number, glow: number) {
  return out.copy(c[0]).lerp(c[2], day).lerp(c[1], glow);
}


export class Environment {
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  grass: Grass;
  /** The land beyond the park (hills, country, coast, Palm Cay), the sea round it, and cloud layers to fly through. */
  readonly terrain: Terrain;
  readonly sea: Sea;
  readonly clouds: Clouds;
  /** setVisibility's fog density (null: the park's own). */
  private visDensity: number | null = null;
  /** Flying: the park's near-only details (grass, fireflies, balloons) are skipped. */
  private farFocus = false;
  /** 1 while the reflections were last baked looking out over the sea, 0 over land. */
  private bakedSea = 0;
  private frameDt = 0;
  /** The day / sunrise-glow blend weights applyTime last worked out. */
  private day = 1;
  private glow = 0;
  /** How far back along the light the shadow camera stands (grows with setShadowSpan). */
  private shadowReach = 150;
  private sky: Sky;
  private skyUniforms = {
    uSpace: { value: 0 },
    uSkyExposure: { value: 0.8 },
    uNight: { value: 0 },
    /** Flying (a visibility is set): the sky melts into the fog at the horizon, where the sea and the land fade into it. */
    uHorizonFog: { value: 0 },
    uFogCol: { value: new THREE.Color() },
  };
  private stars: THREE.Points;
  private fireflies: THREE.Points;
  private fireflySeeds: Float32Array;
  private balloons: THREE.Group[] = [];
  private bulbs: THREE.InstancedMesh[] = [];
  /** Lamps in a row along an avenue or the Midway, which the string lights hang between. */
  private stringRows: [number, number][][] = [];
  /** In-game clock, 0–24. */
  hours = START_HOUR;
  timeMode: TimeMode = 'paused';
  private lastT: number | null = null;
  private bakedHours = -99;
  /** 0 in daylight, 1 in full night. */
  night = 0;
  private space = 0;
  private haze = 1;
  private sunDir = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  private lightDir = new THREE.Vector3(-0.92, 0.36, -0.2).normalize();
  private moon: THREE.Group;
  private lampMat!: THREE.MeshBasicMaterial;
  private poolMat!: THREE.MeshBasicMaterial;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envGround: THREE.MeshBasicMaterial;
  private cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  private cubeCam: THREE.CubeCamera;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private tmp = new THREE.Color();
  /** What's drawn beyond the park too: the sky, the sun and moon, the lights, the land, the sea and the clouds (see shareLayer). */
  private shared: THREE.Object3D[] = [];

  constructor(private ctx: Ctx, q: Quality) {
    const { scene } = ctx;

    // ---------- Physically based sky (Preetham scattering + drifting clouds) ----------
    this.sky = new Sky();
    this.sky.scale.setScalar(1800);
    const u = this.sky.material.uniforms;
    // high turbidity + strong Rayleigh + a sun just above the horizon = deep orange/pink sunset
    u.turbidity.value = 9;
    u.rayleigh.value = 3.2;
    u.mieCoefficient.value = 0.0016;
    u.mieDirectionalG.value = 0.72;
    u.cloudCoverage.value = q.clouds ? 0.3 : 0;
    u.cloudDensity.value = 0.5;
    u.cloudElevation.value = 0.55;
    u.cloudScale.value = 0.00016;
    u.cloudSpeed.value = 0.00007; // a gentle breeze: clouds visibly drift across the sky
    this.sky.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.skyUniforms);
      withFogSun(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform float uSpace;\nuniform float uSkyExposure;\nuniform float uNight;\nuniform float uHorizonFog;\nuniform vec3 uFogCol;\nuniform vec3 uFogSunDir;\nuniform vec3 uFogSunColor;\nvoid main() {',
        )
        .replace(
          'gl_FragColor = vec4( texColor, 1.0 );',
          `vec3 spaceCol = mix( vec3( 0.004, 0.002, 0.012 ), vec3( 0.02, 0.01, 0.05 ), smoothstep( -0.3, 0.6, direction.y ) );
          vec3 skyCol = texColor * uSkyExposure;
          // the sun disc is brighter than half-float buffers can hold: clamp it (and scrub NaNs)
          // so the bloom blur can never smear Inf/NaN across the screen
          // only the sun disc itself may go past the bloom threshold: a small glow, no glare
          skyCol = any( isnan( skyCol ) ) ? vec3( 0.0 ) : clamp( skyCol, 0.0, mix( 0.9, 3.0, sundisc ) );
          // night: a deep blue dome, a touch lighter toward the zenith
          vec3 nightCol = mix( vec3( 0.006, 0.008, 0.02 ), vec3( 0.016, 0.026, 0.065 ), smoothstep( -0.1, 0.6, direction.y ) );
          skyCol = mix( skyCol, nightCol, uNight );
          // flying: the haze at the horizon is the fog's colour (sun-tinted as fog.ts tints it)
          vec3 hazeCol = mix( uFogCol, uFogSunColor, pow( max( dot( direction, uFogSunDir ), 0.0 ), 5.0 ) );
          skyCol = mix( skyCol, hazeCol, ( 1.0 - smoothstep( -0.03, 0.12, direction.y ) ) * uHorizonFog );
          gl_FragColor = vec4( mix( skyCol, spaceCol, uSpace ), 1.0 );`,
        );
    };
    scene.add(this.sky);
    if (import.meta.env.DEV && location.search.includes('hidesky')) this.sky.visible = false;

    // Image-based lighting from the same sky, re-baked as the day goes by (see bakeEnvironment)
    this.pmrem = new THREE.PMREMGenerator(ctx.renderer);
    const envSky = new Sky();
    envSky.material = this.sky.material;
    envSky.scale.setScalar(1800);
    this.envScene.add(envSky);
    // a dark ground hemisphere so reflections don't show sky below the horizon
    this.envGround = new THREE.MeshBasicMaterial({ color: '#24402f', side: THREE.BackSide });
    this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), this.envGround));
    this.cubeCam = new THREE.CubeCamera(1, 4000, this.cubeRT);

    // the moon: a pale disc with a soft halo, opposite the sun
    this.moon = new THREE.Group();
    const moonDisc = new THREE.Mesh(new THREE.CircleGeometry(16, 32), new THREE.MeshBasicMaterial({ color: hdr('#eef2ff', 2.4), fog: false }));
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glowTexture('#c8d6ff'), color: hdr('#9fb4ff', 0.6), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
    );
    halo.scale.setScalar(150);
    this.moon.add(halo, moonDisc);
    scene.add(this.moon);

    // stars: invisible at dusk, take over in space
    const starGeo = new THREE.BufferGeometry();
    const sp: number[] = [];
    const sr = mulberry(3);
    for (let i = 0; i < 2200; i++) {
      const v = new THREE.Vector3(sr() * 2 - 1, sr() * 2 - 1, sr() * 2 - 1).normalize();
      if (v.y < 0.03) v.y = Math.abs(v.y) + 0.03;
      v.normalize().multiplyScalar(820);
      sp.push(v.x, v.y, v.z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: hdr('#ffffff', 2), size: 2, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    scene.add(this.stars);

    scene.fog = new THREE.FogExp2('#584a70', FOG_DENSITY);
    installSunFog();

    // ---------- Lights ----------
    this.hemi = new THREE.HemisphereLight('#9a8ee0', '#4a3b30', 0.55);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight('#ffbe86', 4.2);
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -46;
    cam.right = cam.top = 46;
    cam.near = 1;
    cam.far = 320;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.035;
    this.sun.shadow.radius = 2.5;
    scene.add(this.sun, this.sun.target);
    this.shared.push(this.sky, this.moon, this.stars, this.hemi, this.sun, this.sun.target);

    // ---------- Ground ----------
    // the park's lawn with its paths and plazas, each district's colour set into its plaza
    const WORLD = GROUND.size;
    const inlays = Object.values(DISTRICTS).map(({ plaza: [x, z], color }) => ({ x, z, r: 6.2, color }));
    const ground = groundTexture(ctx.mobile || q.tier === 'lowest' ? 2048 : 4096, GROUND, PATHS, PLAZAS, inlays);
    const detail = detailNormalTexture(512);
    detail.repeat.set(90 * (WORLD / 260), 90 * (WORLD / 260));
    const groundMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD, WORLD),
      std('#ffffff', { map: ground.texture, normalMap: detail, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.96 }),
    );
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.set(GROUND.x, 0, GROUND.z);
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);
    // the road to the giant wheel runs on past the edge of the park's ground texture, through a
    // lawn that carries on from the park's and fades out into the open country
    const L = WHEEL_LAWN;
    const lawnRect = { x0: -L.half, x1: L.half, z0: L.z0, z1: L.z1 };
    const lawnW = lawnRect.x1 - lawnRect.x0;
    const lawnH = lawnRect.z1 - lawnRect.z0;
    const lawnDetail = detail.clone();
    lawnDetail.repeat.set((90 * lawnW) / 260, (90 * lawnH) / 260);
    const lawnFadeNear = L.z1 - (GROUND.z - WORLD / 2); // the overlap with the park ground
    const lawn = new THREE.Mesh(
      new THREE.PlaneGeometry(lawnW, lawnH).rotateX(-Math.PI / 2),
      std('#ffffff', {
        map: lawnPatchTexture(lawnRect, ctx.mobile || q.tier === 'lowest' ? 8 : 12, GROUND, { side: L.fade, near: lawnFadeNear }, PATHS, PLAZAS),
        normalMap: lawnDetail,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 0.96,
        transparent: true,
        alphaTest: 0.02,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
      }),
    );
    lawn.position.set((lawnRect.x0 + lawnRect.x1) / 2, 0.03, (lawnRect.z0 + lawnRect.z1) / 2);
    lawn.receiveShadow = true;
    scene.add(lawn);
    // Creators' Valley's lawn, out past the west gate, with the Valley Road running through it
    for (const V of VALLEY.lawns) {
      const valleyW = V.x1 - V.x0;
      const valleyH = V.z1 - V.z0;
      const valleyDetail = detail.clone();
      valleyDetail.repeat.set((90 * valleyW) / 260, (90 * valleyH) / 260);
      const valley = new THREE.Mesh(
        new THREE.PlaneGeometry(valleyW, valleyH).rotateX(-Math.PI / 2),
        std('#ffffff', {
          map: lawnPatchTexture(V, ctx.mobile || q.tier === 'lowest' ? 5 : 8, GROUND, { side: L.fade, near: L.fade }, PATHS, PLAZAS),
          normalMap: valleyDetail,
          normalScale: new THREE.Vector2(0.9, 0.9),
          roughness: 0.96,
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      );
      valley.position.set((V.x0 + V.x1) / 2, 0.03, (V.z0 + V.z1) / 2);
      valley.receiveShadow = true;
      scene.add(valley);
    }
    // the world beyond the park: the ring hills and the country out to the mountains, the coast and
    // Palm Cay (terrain.ts), the sea to the horizon (sea.ts) and, when the weather has them, clouds
    this.terrain = new Terrain(ctx, q);
    this.sea = new Sea(ctx, q);
    this.clouds = new Clouds(ctx, q);
    scene.add(this.terrain.group, this.sea.mesh, this.clouds.mesh);
    this.shared.push(this.terrain.group, this.sea.mesh, this.clouds.mesh);

    const groundBody = new CANNON.Body({ mass: 0, material: ctx.mats.ground });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    ctx.world.addBody(groundBody);

    // grass grows on the park's lawn and on the lawn along the wheel road (thinning out where it fades)
    const R = PARK.r + 1;
    const growth = (x: number, z: number) => {
      if (parkDistance(x, z) < R) return ground.isSand(x, z) || onMuseum(x, z, 0.6) ? 0 : 1;
      if (Math.abs(x - LAYOUT.ferris.x) > L.half || z < L.z0 || z > PARK.z || onPath(x, z, 1.2)) return 0;
      const edge = Math.min(L.half - Math.abs(x - LAYOUT.ferris.x), z - L.z0);
      return THREE.MathUtils.smoothstep(edge, L.fade * 0.25, L.fade);
    };
    const grassBounds = { x0: PARK.x - R, x1: PARK.x + R, z0: L.z0, z1: PARK.z + R };
    this.grass = new Grass(scene, growth, grassBounds, q.grass, q.grassDistance, q.tier !== 'low' && q.tier !== 'lowest');

    this.buildTrees();
    this.buildFence();
    this.buildLamps();
    this.buildStringLights();
    this.buildTents();
    this.buildBalloons();

    // fireflies drifting over the meadow
    const n = q.tier === 'lowest' ? 0 : q.tier === 'low' ? 80 : 240;
    this.fireflySeeds = new Float32Array(n * 4);
    const fr = mulberry(77);
    for (let i = 0; i < n; i++) {
      const a = fr() * Math.PI * 2;
      const r = 14 + fr() * (PARK.r - 30);
      this.fireflySeeds.set([PARK.x + Math.cos(a) * r, PARK.z + Math.sin(a) * r, 0.6 + fr() * 2.4, fr() * 100], i * 4);
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.fireflies = new THREE.Points(
      fg,
      new THREE.PointsMaterial({
        size: 0.35,
        map: glowTexture('#fff2a8'),
        color: hdr('#ffe98a', 4),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.fireflies.frustumCulled = false;
    scene.add(this.fireflies);
  }

  /** Draws the sky, the lights, the land beyond the park and the sea on another render layer too (the Builder's Yard's). */
  shareLayer(layer: number) {
    for (const o of this.shared) o.traverse((c) => c.layers.enable(layer));
  }

  /**
   * The park's trees, planted to a plan: a wood round the outside of the fence, a green belt just
   * inside it, avenues of trees lining North Avenue and the East and West Avenues, and groves in
   * the gardens between the paths. Nothing grows on a path or a plaza, on an attraction's ground,
   * through a coaster, where the Sky Flip swings low, on the road out to the giant wheel, on the
   * kart circuit or the Rally Trail.
   */
  private buildTrees() {
    const rnd = mulberry(42);
    const fence = PARK.r + FENCE_GAP;
    const underFlip = (x: number, z: number) => {
      const [lx, lz] = flipLocal(x, z);
      return Math.abs(lx) < 34 && lz > -3 && lz < 21;
    };
    const onRoad = (x: number, z: number) => z < PARK.z && Math.abs(x - LAYOUT.ferris.x) < WHEEL_ROAD.half + 5 && z > WHEEL_LAWN.z0 - 10;
    const free = (x: number, z: number) =>
      !onPath(x, z, 2.6) &&
      !onFootprint(x, z, 2) &&
      !nearTrack(x, z, 5, 9) &&
      !underFlip(x, z) &&
      !onMuseum(x, z, 4) &&
      !onRoad(x, z) &&
      !nearCircuit(x, z, WALL + 9) &&
      !nearTrail(x, z, TRAIL_WALL + 7) &&
      !inValley(x, z, 6) &&
      Math.abs(parkDistance(x, z) - fence) > 3;
    // [x, z, scale, broadleaf only]
    const spots: [number, number, number, boolean][] = [];
    const plant = (x: number, z: number, sc: number, gap = 3.2, avenue = false) => {
      if (!free(x, z) || spots.some(([sx, sz]) => (sx - x) ** 2 + (sz - z) ** 2 < gap * gap)) return;
      spots.push([x, z, sc, avenue]);
    };
    // the wood outside the fence
    for (let i = 0; i < 230; i++) {
      const a = rnd() * Math.PI * 2;
      const r = fence + 4 + rnd() * 36;
      plant(PARK.x + Math.cos(a) * r, PARK.z + Math.sin(a) * r, 0.85 + rnd() * 0.8);
    }
    // the green belt inside it
    for (let i = 0; i < 260; i++) {
      const a = (i / 260) * Math.PI * 2 + (rnd() - 0.5) * 0.02;
      const r = fence - 6 - rnd() * 12;
      plant(PARK.x + Math.cos(a) * r, PARK.z + Math.sin(a) * r, 0.8 + rnd() * 0.6, 5.5);
    }
    // avenues: a row either side of North Avenue and of the East and West Avenues, evenly spaced
    for (let z = PARK.z - 20; z > PARK.z - PARK.r + 6; z -= 11) for (const sx of [-1, 1]) plant(PARK.x + sx * 8.5, z, 0.95, 3.2, true);
    for (let x = 22; x < 60; x += 10)
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) plant(PARK.x + sx * x, PARK.z + sz * 6.8, 0.85, 3.2, true);
    // groves in the gardens between the paths
    const groves: [number, number, number][] = [
      [26, -78, 11], [-24, -78, 11], [30, -24, 10], [-28, -24, 10], // the four gardens round the Hub
      [96, -96, 13], [106, -18, 9], [-92, 0, 12], [-104, -130, 10], [56, -168, 9], [-40, -150, 11], // out beyond the Promenade
      [40, 52, 11], [-60, 62, 9], [-6, 78, 7], [104, 48, 8],
    ];
    for (const [cx, cz, r] of groves)
      for (let i = 0; i < 14; i++) {
        const a = rnd() * Math.PI * 2;
        const d = Math.sqrt(rnd()) * r;
        plant(cx + Math.cos(a) * d, cz + Math.sin(a) * d, 0.75 + rnd() * 0.6, 3.6);
      }

    const trunkGeo = new THREE.CylinderGeometry(0.18, 0.34, 2.6, 7);
    trunkGeo.translate(0, 1.3, 0);
    const broad = broadleafGeometry();
    const pine = pineGeometry();

    const trunkMat = std('#5b4033', { roughness: 0.95 });
    const leafMat = std('#ffffff', { vertexColors: true, roughness: 0.82 });
    const pineMat = std('#ffffff', { vertexColors: true, roughness: 0.85 });
    addWind(leafMat, 0.05);
    addWind(pineMat, 0.035);

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
    const leaves = new THREE.InstancedMesh(broad, leafMat, spots.length);
    const pines = new THREE.InstancedMesh(pine, pineMat, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    let nl = 0;
    let np = 0;
    spots.forEach(([x, z, sc, avenue], i) => {
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rnd() * 6);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(sc, sc * (0.9 + rnd() * 0.25), sc));
      trunks.setMatrixAt(i, m);
      color.setHSL(0.22 + rnd() * 0.12, 0.3 + rnd() * 0.25, 0.75 + rnd() * 0.2);
      // the avenues are all broadleaves; elsewhere a mix
      if (avenue || rnd() > 0.42) {
        leaves.setMatrixAt(nl, m);
        leaves.setColorAt(nl++, color);
      } else {
        pines.setMatrixAt(np, m);
        pines.setColorAt(np++, color);
      }
      if (parkDistance(x, z) < fence) staticCylinder(this.ctx, x, z, 0.4 * sc, 3);
    });
    leaves.count = nl;
    pines.count = np;
    for (const im of [trunks, leaves, pines]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.ctx.scene.add(im);
    }
  }

  private buildFence() {
    const r = PARK.r + FENCE_GAP;
    const n = Math.round((Math.PI * 2 * r) / 2.7);
    const geo = new THREE.BoxGeometry(0.16, 1.2, 0.1);
    geo.translate(0, 0.6, 0);
    const posts = new THREE.InstancedMesh(geo, std(PALETTE.cream, { roughness: 0.7 }), n);
    const m = new THREE.Matrix4();
    // the gates: north, where the road leaves for the giant wheel (centred on angle -π/2), and west,
    // where the Valley Road leaves for Creators' Valley
    const dz = VALLEY.road.z - PARK.z;
    const gates = [
      { at: -Math.PI / 2, half: Math.asin((WHEEL_ROAD.half + 0.6) / r) },
      { at: Math.atan2(dz, -Math.sqrt(r * r - dz * dz)), half: Math.asin(((VALLEY.walk.z1 - VALLEY.walk.z0) / 2 + 0.6) / r) },
    ];
    const turn = Math.PI * 2;
    const gap = (a: number, at: number) => Math.abs((((a - at + Math.PI) % turn) + turn) % turn - Math.PI);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = PARK.x + Math.cos(a) * r;
      const z = PARK.z + Math.sin(a) * r;
      // leave a gap where a coaster runs through the fence, and at the gate
      if (nearTrack(x, z, 3, 4) || gates.some((g) => gap(a, g.at) < g.half)) m.makeScale(0, 0, 0);
      else m.makeRotationY(-a).setPosition(x, 0, z);
      posts.setMatrixAt(i, m);
    }
    posts.castShadow = true;
    this.ctx.scene.add(posts);
    // the rail runs round from gate to gate
    const railMat = std(PALETTE.candy, { roughness: 0.5 });
    const sorted = gates.map((g) => ({ ...g, at: ((g.at % turn) + turn) % turn })).sort((p, q) => p.at - q.at);
    sorted.forEach((g, i) => {
      const next = sorted[(i + 1) % sorted.length];
      const from = g.at + g.half;
      const to = next.at - next.half + (i === sorted.length - 1 ? turn : 0);
      const rail = new THREE.Mesh(new THREE.TorusGeometry(r, 0.06, 4, Math.ceil((240 * (to - from)) / turn), to - from).rotateZ(from), railMat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(PARK.x, 0.95, PARK.z);
      this.ctx.scene.add(rail);
    });
  }

  /**
   * Lamp posts along every path, evenly spaced: both sides of the avenues and the Midway, one side
   * (taking turns) of the narrower paths, a ring round the Hub and a pair at each district's plaza.
   * Also returns the lamps along the avenues and the Midway (each side in order), for the string lights.
   */
  private lampSpots() {
    const spots: [number, number][] = [];
    const strings: [number, number][][] = [];
    const ok = (x: number, z: number) =>
      parkDistance(x, z) < PARK.r - 1.5 &&
      !onPath(x, z, 0.4) &&
      !onFootprint(x, z, 1) &&
      !nearTrack(x, z, 3) &&
      !onMuseum(x, z, 1.5) &&
      spots.every(([sx, sz]) => (sx - x) ** 2 + (sz - z) ** 2 > 36);
    const add = (x: number, z: number) => {
      if (!ok(x, z)) return false;
      spots.push([x, z]);
      return true;
    };
    for (const p of PATHS) {
      const wide = p.width >= 7;
      const midway = p === MIDWAY;
      const both = wide || midway;
      const step = wide ? 13 : midway ? 10 : 16;
      const off = p.width / 2 + (wide ? 1.7 : 1.2);
      const rows: [number, number][][] = [[], []];
      let side = 1;
      for (let i = 0; i < p.points.length - 1; i++) {
        const [ax, az] = p.points[i];
        const [bx, bz] = p.points[i + 1];
        const len = Math.hypot(bx - ax, bz - az);
        const nx = -(bz - az) / len;
        const nz = (bx - ax) / len;
        for (let d = step / 2; d < len; d += step) {
          const cx = ax + ((bx - ax) * d) / len;
          const cz = az + ((bz - az) * d) / len;
          for (const s of both ? [1, -1] : [side]) if (add(cx + nx * off * s, cz + nz * off * s)) rows[s > 0 ? 0 : 1].push(spots[spots.length - 1]);
          side = -side;
        }
      }
      if (both) strings.push(...rows.filter((r) => r.length > 1));
    }
    // round the Hub, and a pair at each district's plaza
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      add(PARK.x + Math.cos(a) * 16, PARK.z + Math.sin(a) * 16);
    }
    for (const { plaza: [x, z] } of Object.values(DISTRICTS))
      for (const a of [Math.PI / 4, (5 * Math.PI) / 4]) add(x + Math.cos(a) * 9.4, z + Math.sin(a) * 9.4);
    // …and on along the road out to the giant wheel
    for (let z = PARK.z - PARK.r - 6; z > WHEEL_ROAD.end + 4; z -= 12) spots.push([LAYOUT.ferris.x - 5.2, z], [LAYOUT.ferris.x + 5.2, z]);
    return { spots, strings };
  }

  private buildLamps() {
    const { spots, strings } = this.lampSpots();
    this.stringRows = strings;

    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    const poleGeo = mergeGeometries([
      new THREE.CylinderGeometry(0.07, 0.11, 4.2, 10).translate(0, 2.1, 0),
      new THREE.CylinderGeometry(0.22, 0.28, 0.35, 10).translate(0, 0.17, 0),
      new THREE.ConeGeometry(0.42, 0.35, 10).translate(0, 4.75, 0),
    ])!;
    const poles = new THREE.InstancedMesh(poleGeo, iron, spots.length);
    this.lampMat = new THREE.MeshBasicMaterial({ color: hdr('#ffd59a', 7) });
    const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 16, 12), this.lampMat, spots.length);
    const pools = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2),
      (this.poolMat = new THREE.MeshBasicMaterial({
        map: poolTexture(),
        color: hdr('#ffb26b', 0.3),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })),
      spots.length,
    );
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      poles.setMatrixAt(i, m.makeTranslation(x, 0, z));
      lamps.setMatrixAt(i, m.makeTranslation(x, 4.38, z));
      pools.setMatrixAt(i, m.makeTranslation(x, 0.03, z));
      staticCylinder(this.ctx, x, z, 0.2, 4);
    });
    poles.castShadow = true;
    pools.renderOrder = 1;
    this.ctx.scene.add(poles, lamps, pools);
  }

  /** Strings of coloured bulbs from lamp to lamp along the avenues and the Midway, and round the entrance plaza. */
  private buildStringLights() {
    const lines: [THREE.Vector3, THREE.Vector3][] = [];
    for (const row of this.stringRows)
      for (let i = 0; i < row.length - 1; i++) {
        const [ax, az] = row[i];
        const [bx, bz] = row[i + 1];
        // only between neighbours (not across a gap where a lamp was left out); none out past the Promenade
        if (Math.hypot(bx - ax, bz - az) < 18 && parkDistance(ax, az) < 75) lines.push([new THREE.Vector3(ax, 4.1, az), new THREE.Vector3(bx, 4.1, bz)]);
      }
    // a garland round the north side of the entrance plaza, pole to pole
    const [ex, ez, er] = PLAZAS[0];
    const ring: [number, number][] = [];
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI * (0.92 + (i / 6) * 1.16);
      ring.push([ex + Math.cos(a) * (er + 1.6), ez + Math.sin(a) * (er + 1.6)]);
    }
    for (let i = 0; i < ring.length - 1; i++) lines.push([new THREE.Vector3(ring[i][0], 4.1, ring[i][1]), new THREE.Vector3(ring[i + 1][0], 4.1, ring[i + 1][1])]);
    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.09, 4.3, 8).translate(0, 2.15, 0), iron, ring.length);
    ring.forEach(([x, z], i) => {
      poles.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, z));
      staticCylinder(this.ctx, x, z, 0.15, 4);
    });
    poles.castShadow = true;
    this.ctx.scene.add(poles);

    const colors = ['#ff5d7a', '#ffd23d', '#5ce1d6', '#a98bff', '#fff3d6'];
    const perLine = 16;
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), lines.length * perLine);
    const wirePts: number[] = [];
    const m = new THREE.Matrix4();
    let i = 0;
    for (const [a, b] of lines) {
      let prev: THREE.Vector3 | null = null;
      for (let k = 0; k <= perLine; k++) {
        const t = k / perLine;
        const p = a.clone().lerp(b, t);
        p.y -= Math.sin(t * Math.PI) * 0.7;
        if (prev) wirePts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
        if (k < perLine) {
          bulbs.setMatrixAt(i, m.makeTranslation(p.x, p.y - 0.12, p.z));
          bulbs.setColorAt(i, hdr(colors[i % colors.length], 5));
          i++;
        }
      }
    }
    const wire = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3)),
      new THREE.LineBasicMaterial({ color: '#1e1628' }),
    );
    this.ctx.scene.add(bulbs, wire);
    this.bulbs.push(bulbs);
  }

  /**
   * Striped stalls in rows facing the paths: shops down both sides of Main Street, a row of treat
   * stalls along the Promenade by the Midway, and one by each district's plaza in its colour.
   */
  private buildTents() {
    // [x, z, colour, yaw]: the door (local +z) faces the path
    const spots: [number, number, string, number][] = [];
    const shops = [PALETTE.candy, PALETTE.teal, PALETTE.mustard, PALETTE.violet];
    // Main Street, between the Promenade and the Hub
    [6, -6, -18, -30].forEach((z, i) => {
      spots.push([PARK.x - 11.5, z, shops[i % 4], Math.PI / 2]);
      spots.push([PARK.x + 11.5, z, shops[(i + 2) % 4], -Math.PI / 2]);
    });
    // the treat stalls along the Promenade, east of Main Street
    [16, 27, 38].forEach((x, i) => spots.push([x, 26.5, shops[i], Math.PI]));
    // one in each district's colour, beside its plaza, its door to the plaza
    const by = (id: DistrictId, dx: number, dz: number) => {
      const { plaza, color } = DISTRICTS[id];
      spots.push([plaza[0] + dx, plaza[1] + dz, color, Math.atan2(-dx, -dz)]);
    };
    by('cosmos', -13, 6);
    by('thrill', 10, 14);
    by('motor', 12, -12);
    by('falcon', -12, 13);
    for (const [x, z, col, yaw] of spots) {
      if (onPath(x, z, 1.2) || onFootprint(x, z, 2) || nearTrack(x, z, 6)) continue;
      const g = new THREE.Group();
      const stripes = stripeTexture(col, PALETTE.cream, 12);
      const canvas = { map: stripes, roughness: 0.88, side: THREE.DoubleSide } as const;
      const wall = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 2.6, 24, 1, true), std('#ffffff', canvas));
      wall.position.y = 1.3;
      const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 2.8, 24, 1, true), std('#ffffff', canvas));
      roof.position.y = 4;
      const scallop = new THREE.Mesh(new THREE.CylinderGeometry(3.62, 3.62, 0.35, 24, 1, true), std(col, { roughness: 0.85, side: THREE.DoubleSide }));
      scallop.position.y = 2.6;
      const flagPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4), std('#3a2f4a', { metalness: 0.6, roughness: 0.4 }));
      flagPole.position.y = 6;
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 3), std(PALETTE.mustard));
      flag.rotation.z = -Math.PI / 2;
      flag.position.set(0.4, 6.4, 0);
      // a warm glow spilling out of the doorway
      const door = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 2), new THREE.MeshBasicMaterial({ color: hdr('#ffb46b', 1.6) }));
      door.position.set(0, 1, 3.02);
      g.add(wall, roof, scallop, flagPole, flag, door);
      g.position.set(x, 0, z);
      g.rotation.y = yaw;
      g.traverse((o) => {
        o.castShadow = true;
        o.receiveShadow = true;
      });
      door.castShadow = false;
      this.ctx.scene.add(g);
      staticCylinder(this.ctx, x, z, 3, 3);
    }
  }

  private buildBalloons() {
    const colors = [PALETTE.candy, PALETTE.mustard, PALETTE.teal, PALETTE.violet, PALETTE.orange];
    const e = LAYOUT.spawn;
    const c = LAYOUT.carousel;
    // either side of the entrance plaza, and on the Hub
    const clusters: [number, number][] = [[e.x - 10.5, e.z + 1], [e.x + 10.5, e.z + 1], [c.x + 11, c.z + 6], [c.x - 11, c.z - 6]];
    const rnd = mulberry(12);
    clusters.forEach(([x, z], ci) => {
      const g = new THREE.Group();
      const linePts: number[] = [];
      for (let i = 0; i < 5; i++) {
        // glossy latex: the clearcoat picks up the sunset reflections
        const mat = new THREE.MeshPhysicalMaterial({ color: colors[(i + ci) % colors.length], roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 18), mat);
        b.scale.y = 1.2;
        const bx = (rnd() - 0.5) * 1.4;
        const bz = (rnd() - 0.5) * 1.4;
        const by = 4 + rnd() * 1.2;
        b.position.set(bx, by, bz);
        b.castShadow = true;
        g.add(b);
        linePts.push(0, 1.2, 0, bx, by - 0.6, bz);
      }
      g.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3)),
          new THREE.LineBasicMaterial({ color: '#f6eadb' }),
        ),
      );
      const weight = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.2, 0.4), std('#3a2f4a', { metalness: 0.5, roughness: 0.4 }));
      weight.position.y = 0.6;
      weight.castShadow = true;
      g.add(weight);
      g.position.set(x, 0, z);
      this.ctx.scene.add(g);
      this.balloons.push(g);
      staticCylinder(this.ctx, x, z, 0.35, 1.2);
    });
  }

  /** 0 = on the ground, 1 = outer space (the rocket ride). */
  setSpace(k: number) {
    this.space = k;
  }

  /** Thins the haze (1 = normal), e.g. high up on the giant wheel where you see over it. */
  setHaze(k: number) {
    this.haze = k;
  }

  /** Keep the shadow camera centred on what matters. */
  follow(target: THREE.Vector3) {
    this.sun.position.copy(target).addScaledVector(this.lightDir, this.shadowReach);
    this.sun.target.position.copy(target);
  }

  /** Jump the clock to a given hour (0–24). */
  setHour(hour: number) {
    this.hours = ((hour % 24) + 24) % 24;
  }

  /** Clock as "HH:MM". */
  get clock() {
    const m = Math.floor(this.hours * 60) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }

  /**
   * The day cycle: the sun rises in the east at 06:00, crosses high in the sky and sets in the
   * west at 18:00; the moon takes over at night. Sky, sunlight, ambient light, fog, stars,
   * reflections and the park's lights all follow it.
   */
  private applyTime(t: number) {
    const smooth = THREE.MathUtils.smoothstep;
    const lerp = THREE.MathUtils.lerp;
    const dt = this.lastT === null ? 0 : Math.max(0, t - this.lastT);
    this.lastT = t;
    if (this.timeMode === 'cycle') this.setHour(this.hours + (dt / DAY_SECONDS) * 24);
    else if (this.timeMode === 'local') {
      const now = new Date();
      this.hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
    }
    const a = ((this.hours - 6) / 24) * Math.PI * 2;
    const sun = this.sunDir.set(Math.cos(a), Math.sin(a) * 0.9, -0.22).normalize();
    const moon = this.moonDir.copy(sun).negate();
    const day = smooth(sun.y, -0.1, 0.22);
    const glow = smooth(sun.y, -0.2, 0) * (1 - smooth(sun.y, 0.06, 0.4)); // sunrise / sunset
    this.night = 1 - smooth(sun.y, -0.24, -0.02);
    this.day = day;
    this.glow = glow;
    const space = this.space;

    // sky
    const u = this.sky.material.uniforms;
    u.sunPosition.value.copy(sun);
    // clear, deep-blue daytime sky; hazy and red only around sunrise / sunset
    u.turbidity.value = lerp(1.8, 9, glow);
    u.rayleigh.value = lerp(1.7, 3.2, glow);
    this.skyUniforms.uSkyExposure.value = lerp(0.28, 0.8, glow);
    this.skyUniforms.uNight.value = this.night;
    this.skyUniforms.uSpace.value = space;
    (this.stars.material as THREE.PointsMaterial).opacity = Math.max(this.night * 0.85, smooth(space, 0.15, 0.8));
    this.stars.rotation.y = (this.hours / 24) * Math.PI * 2 * 0.25;
    this.moon.visible = moon.y > -0.05;

    // direct light: the sun by day, the moon by night (one shadow-casting light)
    const sunW = smooth(sun.y, -0.03, 0.1);
    if (sunW > 0.001) {
      this.lightDir.copy(sun).setY(Math.max(sun.y, 0.08)).normalize();
      this.sun.color.copy(SUN_WARM).lerp(SUN_NOON, smooth(sun.y, 0.1, 0.5));
      // a low sun grazes the ground; a high one hits it square on, so it needs far less intensity
      this.sun.intensity = sunW * lerp(4.2, 1.45, smooth(sun.y, 0.08, 0.5));
    } else {
      this.lightDir.copy(moon).setY(Math.max(moon.y, 0.3)).normalize();
      this.sun.color.copy(MOON);
      // moonlight, already partly up during twilight so dusk never goes pitch black
      this.sun.intensity = 1.05 * Math.max(this.night, 0.55);
    }

    // ambient + reflections
    tri(this.hemi.color, HEMI_SKY, day, glow);
    tri(this.hemi.groundColor, HEMI_GROUND, day, glow);
    this.hemi.intensity = lerp(0.85, 0.45, day) * (1 - space * 0.7);
    this.ctx.scene.environmentIntensity = (lerp(0.42, 0.4, day) + 0.35 * glow) * (1 - space * 0.8);
    tri(this.envGround.color, ENV_GROUND, day, glow).lerp(tri(this.tmp, ENV_SEA, day, glow), this.bakedSea);

    // fog: colour, sun-side tint and density (the park's haze, or a visibility set for flying)
    const fog = this.ctx.scene.fog as THREE.FogExp2;
    tri(fog.color, FOG, day, glow);
    tri(fogSun.uFogSunColor.value, FOG_SUN, day, glow);
    fogSun.uFogSunDir.value.copy(sun.y > -0.05 ? sun : moon);
    fog.density = (this.visDensity ?? FOG_DENSITY * lerp(1, 0.3, day) * this.haze) * (1 - space);
    const aloft = this.visDensity === null ? 0 : 1;
    if (aloft) fog.color.lerp(tri(this.tmp, AIR_HAZE, day, glow), 0.85);
    // inside a cloud the world closes in to a grey-white murk
    const cloud = this.clouds.inside;
    if (cloud > 0) {
      fog.density = lerp(fog.density, 1.978 / IN_CLOUD_VIS, cloud);
      fog.color.lerp(this.tmp.copy(this.hemi.color).multiplyScalar(lerp(0.25, 0.95, day)), cloud);
    }
    // the sky's horizon melts into the same haze the sea and the land fade into
    this.skyUniforms.uHorizonFog.value = aloft * (1 - space);
    this.skyUniforms.uFogCol.value.copy(fog.color);
    this.clouds.light(sunW > 0.001 ? sun : moon, this.sun.color, this.sun.intensity, this.hemi.color, this.hemi.groundColor);
    this.terrain.setNight(this.night);

    // the park's own lights: dimmer by day, full glow at night
    const lights = 1 - 0.6 * day;
    this.lampMat.color.copy(this.tmp.set('#ffd59a')).multiplyScalar(7 * lights);
    this.poolMat.opacity = lerp(0.15, 1, this.night);
    (this.fireflies.material as THREE.PointsMaterial).opacity = this.night;
    this.fireflies.visible = this.night > 0.02 && !this.farFocus;
  }

  /**
   * Re-renders the sky into the reflection map whenever the clock has moved ~6 game minutes, or
   * the camera has gone out over the sea or back over land (what's reflected below the horizon).
   */
  private bakeEnvironment() {
    const c = this.ctx.camera.position;
    const sea = onLand(c.x, c.z, -150) ? 0 : 1;
    const d = Math.abs(this.hours - this.bakedHours) % 24; // circular: 23:59 is next to 00:00
    if (Math.min(d, 24 - d) < 0.1 && sea === this.bakedSea) return;
    this.bakedHours = this.hours;
    if (sea !== this.bakedSea) {
      this.bakedSea = sea;
      // the ground colour was set for the old view this frame: set it again for the new one
      tri(this.envGround.color, ENV_GROUND, this.day, this.glow).lerp(tri(this.tmp, ENV_SEA, this.day, this.glow), sea);
    }
    this.cubeCam.update(this.ctx.renderer, this.envScene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT);
    this.ctx.scene.environment = this.envRT.texture;
  }

  /** The camera's far (and near) plane: ~60 km to fly, then restoreViewRange for walking again. */
  setViewRange(far: number, near?: number) {
    const cam = this.ctx.camera;
    cam.far = far;
    if (near !== undefined) cam.near = near;
    cam.updateProjectionMatrix();
  }

  restoreViewRange() {
    this.setViewRange(WALK_FAR, WALK_NEAR);
  }

  /**
   * Overrides the fog: 98 % fogged at `m` metres (e.g. ~35 km on a clear day aloft). null gives
   * the park its own haze back. Keep m at or below 0.9 × the far plane so the sea meets the sky.
   */
  setVisibility(m: number | null) {
    this.visDensity = m === null ? null : 1.978 / Math.max(1, m);
  }

  /** The sun's shadow box half-size in metres (46 by default; ~60 round an airliner on the apron). */
  setShadowSpan(half: number) {
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    // the box's depth grows with it, so a long shadow from a low sun isn't cut off
    cam.far = Math.max(320, half * 7);
    this.shadowReach = Math.max(150, half * 3.3);
    cam.updateProjectionMatrix();
  }

  resetShadowSpan() {
    this.setShadowSpan(SHADOW_SPAN);
  }

  /** Flying: the park's grass stays hidden and its near-only details (fireflies, balloons) are skipped. */
  setFarFocus(on: boolean) {
    this.farFocus = on;
    this.grass.setHidden(on);
    if (on) this.fireflies.visible = false;
  }

  update(t: number, focus: THREE.Vector3) {
    this.frameDt = this.lastT === null ? 0 : Math.min(0.1, Math.max(0, t - this.lastT));
    this.sky.material.uniforms.time.value = t;
    this.applyTime(t);
    this.bakeEnvironment();
    this.grass.update(focus);

    // the sky box, the stars and the moon travel with the camera (the box is only 900 m across),
    // the stars and the moon just inside the far plane so they never draw over distant land
    const cam = this.ctx.camera;
    const R = cam.far * 0.9;
    this.sky.position.copy(cam.position);
    this.stars.position.copy(cam.position);
    this.stars.scale.setScalar(R / 820);
    this.moon.position.copy(this.moonDir).multiplyScalar(R).add(cam.position);
    this.moon.scale.setScalar(R / 780);
    this.moon.lookAt(cam.position);

    this.terrain.update(cam);
    this.sea.update(this.frameDt, t, cam);
    this.clouds.update(this.frameDt, cam);
    if (this.farFocus) return;

    for (let i = 0; i < this.balloons.length; i++) {
      const b = this.balloons[i];
      b.rotation.y = Math.sin(t * 0.3 + i) * 0.3;
      b.rotation.z = Math.sin(t * 0.7 + i * 2) * 0.03;
    }
    const lights = 1 - 0.55 * (1 - this.night);
    for (const im of this.bulbs) (im.material as THREE.MeshBasicMaterial).color.setScalar((0.85 + Math.sin(t * 3) * 0.15) * lights);

    // fireflies: lazy figure-of-eight drift + blinking (an "off" firefly hides below ground)
    const pos = this.fireflies.geometry.attributes.position as THREE.BufferAttribute;
    const s = this.fireflySeeds;
    for (let i = 0; i < pos.count; i++) {
      const x = s[i * 4];
      const z = s[i * 4 + 1];
      const y = s[i * 4 + 2];
      const ph = s[i * 4 + 3];
      const tt = t * 0.35 + ph;
      const on = Math.sin(t * 1.3 + ph * 7) > -0.2;
      pos.setXYZ(i, x + Math.sin(tt) * 2.2, on ? y + Math.sin(tt * 2.1) * 0.5 : -5, z + Math.sin(tt * 0.8) * Math.cos(tt) * 2.2);
    }
    pos.needsUpdate = true;
  }
}

/** A lumpy, softly shaded broadleaf crown made of a few merged blobs. */
export function broadleafGeometry() {
  const rnd = mulberry(21);
  const center = new THREE.Vector3(0, 3.7, 0);
  const blobs: [number, number, number, number][] = [
    [0, 3.7, 0, 1.75],
    [0.95, 3.25, 0.4, 1.2],
    [-0.85, 3.35, -0.35, 1.25],
    [0.15, 4.6, 0.2, 1.15],
    [-0.35, 3.05, 0.95, 1.0],
    [0.4, 3.1, -0.95, 1.0],
  ];
  const parts = blobs.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.attributes.position;
    const seed = rnd() * 10;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i);
      const vy = p.getY(i);
      const vz = p.getZ(i);
      const n = 1 + Math.sin(vx * 3.1 + seed) * Math.cos(vz * 2.7 + seed) * Math.sin(vy * 2.3) * 0.14;
      p.setXYZ(i, vx * n, vy * n, vz * n);
    }
    g.translate(x, y, z);
    return g;
  });
  const g = mergeGeometries(parts)!;
  const p = g.attributes.position;
  const nrm = g.attributes.normal;
  const col: number[] = [];
  const sway: number[] = [];
  const v = new THREE.Vector3();
  const out = new THREE.Vector3();
  const n = new THREE.Vector3();
  const dark = new THREE.Color('#1f4a2a');
  const light = new THREE.Color('#7fae4e');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // spherical normals = soft, volumetric foliage lighting instead of faceted blobs
    out.copy(v).sub(center).normalize();
    n.fromBufferAttribute(nrm, i).lerp(out, 0.75);
    // opposite normals can cancel to zero, which would turn into NaN in the lighting
    if (n.lengthSq() < 1e-4) n.copy(out);
    n.normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
    // self-shadowed underside, sunlit crown
    c.lerpColors(dark, light, THREE.MathUtils.smoothstep(v.y, 2.0, 5.6) * 0.85);
    col.push(c.r, c.g, c.b);
    sway.push(THREE.MathUtils.clamp((v.y - 2) / 3, 0, 1));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  return g;
}

export function pineGeometry() {
  const layers: [number, number, number][] = [
    [1.9, 2.4, 2.5],
    [1.45, 2.1, 3.8],
    [1.0, 1.9, 5.0],
    [0.55, 1.3, 6.0],
  ];
  const g = mergeGeometries(layers.map(([r, h, y]) => new THREE.ConeGeometry(r, h, 12, 2).translate(0, y, 0)))!;
  const p = g.attributes.position;
  const nrm = g.attributes.normal;
  const col: number[] = [];
  const sway: number[] = [];
  const v = new THREE.Vector3();
  const out = new THREE.Vector3();
  const n = new THREE.Vector3();
  const dark = new THREE.Color('#12331f');
  const light = new THREE.Color('#4f8a4a');
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    out.set(v.x, 0.35, v.z).normalize();
    n.fromBufferAttribute(nrm, i).lerp(out, 0.5);
    if (n.lengthSq() < 1e-4) n.copy(out);
    n.normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
    const layerT = (v.y % 1.25) / 1.25;
    c.lerpColors(dark, light, THREE.MathUtils.clamp(v.y / 7 + layerT * 0.25, 0, 1));
    col.push(c.r, c.g, c.b);
    sway.push(THREE.MathUtils.clamp((v.y - 1.5) / 5, 0, 1));
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aSway', new THREE.Float32BufferAttribute(sway, 1));
  return g;
}
