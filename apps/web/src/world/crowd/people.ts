import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildShoes, shoeMaterial } from './shoes';

// People are Quaternius' "Universal Base Characters" (CC0): semi-realistic male and female
// bodies with textured skin, eyes and rigged hairstyles, animated with his "Universal Animation
// Library" (CC0, same skeleton). The free bodies come undressed, so clothes are painted on in
// the shader: every vertex knows how high up the body it sits, how far down the arm, and
// whether it belongs to a foot or the head, and each person's outfit picks colours and cuts
// (sleeve length, trousers or shorts) from that. Clothed areas are puffed out a little and
// skip the skin's muscle normal map, so they read as fabric rather than body paint.

export const GUESTS_URL = `${import.meta.env.BASE_URL}models/guests.glb`;
export const GUEST_ANIMS_URL = `${import.meta.env.BASE_URL}models/guest-anims.glb`;

export type Gender = 'm' | 'f';

export interface Look {
  gender: Gender;
  /** Standing height in metres. */
  height: number;
  child: boolean;
  /** Multiplies the (light) skin texture: white = as painted, browner = darker skin. */
  skin: THREE.Color;
  hair: THREE.Color;
  hairStyle: string | null;
  beard: boolean;
  top: THREE.Color;
  pants: THREE.Color;
  shoe: THREE.Color;
  /** Where sleeves end, 0 at the shoulder … 1 at the wrist (below 0 = sleeveless). */
  sleeve: number;
  /** Where trouser legs end, as a fraction of height (0.05 = ankles, 0.32 = shorts). */
  legEnd: number;
  /** Width multiplier: slimmer or broader builds. */
  build: number;
  /**
   * Where the top starts, as a fraction of height, when it doesn't reach down to the waistband: a
   * bikini top's lower edge. Above 1 there is no top at all (bare-chested, in swim shorts).
   */
  topFrom?: number;
  /** The neckline as a fraction of height (default 0.9, a crew neck; lower for a swimsuit). */
  neckline?: number;
  /** The waistband as a fraction of height (default by gender; lower for swim shorts and bikinis). */
  waist?: number;
  /** Something painted over the top: reflective hi-vis bands round the body and sleeves, or a tie. */
  trim?: { kind: 'bands' | 'tie'; colour: THREE.Color };
}

const pick = <T>(r: () => number, a: readonly T[]) => a[Math.floor(r() * a.length)];
// multipliers on the light skin albedo (as sRGB swatches): pale … deep brown
const SKINS = ['#ffffff', '#fbf0e9', '#f3e0d2', '#e8cab4', '#d6b196', '#c0967b', '#a47b64', '#8a6553', '#725446'];
const HAIRS = ['#1a1412', '#2b1d14', '#3d2817', '#5c3b22', '#7a5233', '#a77c4f', '#d9bb84', '#9a4424', '#8f8f8f', '#d6d3cf'];
const TOPS = [
  '#f3f1ec', '#1d2230', '#c21a32', '#2a5ea8', '#3d7a4c', '#f0c22a', '#e9739a', '#76509e', '#f2793a', '#4fb8b6',
  '#8796a4', '#b24a2c', '#e8dcc4', '#2e4c6a', '#d85272', '#6b8a3a', '#262626', '#9fcde8', '#ffffff', '#5a3f7a',
];
const PANTS = ['#1c2a48', '#2b3d63', '#3d5c8e', '#4f6f9e', '#18181c', '#46464c', '#b5a07c', '#786852', '#e6e0d2', '#56402e', '#2f4a3a'];
const SHOES = ['#f4f4f2', '#f4f4f2', '#1a1a1a', '#3a2a20', '#c0392b', '#2e5eaa', '#8a9099', '#30333b'];
const MALE_HAIR = ['Hair_SimpleParted', 'Hair_SimpleParted', 'Hair_Buzzed', 'Hair_Buzzed', null] as const;
const FEMALE_HAIR = ['Hair_Long', 'Hair_Long', 'Hair_Buns', 'Hair_BuzzedFemale'] as const;

/** The visitor's own look: red tee, jeans, white trainers. */
export const VISITOR_LOOK: Look = {
  gender: 'm',
  height: 1.78,
  child: false,
  skin: new THREE.Color('#f3e0d2'),
  hair: new THREE.Color('#3d2817'),
  hairStyle: 'Hair_SimpleParted',
  beard: false,
  top: new THREE.Color('#d23c34'),
  pants: new THREE.Color('#2b3d63'),
  shoe: new THREE.Color('#f4f4f2'),
  sleeve: 0.3,
  legEnd: 0.045,
  build: 1,
};

export function randomLook(r: () => number, opts: { child?: boolean; gender?: Gender; age?: 'young' | 'old' } = {}): Look {
  const gender = opts.gender ?? (r() < 0.5 ? 'm' : 'f');
  const child = !!opts.child;
  const old = opts.age === 'old' || (!child && opts.age !== 'young' && r() < 0.15);
  const height = child ? 1.05 + r() * 0.42 : gender === 'm' ? 1.68 + r() * 0.22 : 1.56 + r() * 0.2;
  let hair = pick(r, HAIRS.slice(0, 8));
  if (old) hair = pick(r, HAIRS.slice(8));
  const warm = r() < 0.55; // summer clothes: short sleeves and shorts are common
  return {
    gender,
    height,
    child,
    skin: new THREE.Color(pick(r, SKINS)),
    hair: new THREE.Color(hair),
    hairStyle: gender === 'm' ? (old && r() < 0.5 ? null : pick(r, MALE_HAIR)) : pick(r, FEMALE_HAIR),
    beard: gender === 'm' && !child && r() < 0.28,
    top: new THREE.Color(pick(r, TOPS)),
    pants: new THREE.Color(pick(r, PANTS)),
    shoe: new THREE.Color(pick(r, SHOES)),
    sleeve: warm ? (r() < 0.15 ? -0.1 : 0.22 + r() * 0.12) : 0.96,
    legEnd: warm && r() < (child ? 0.7 : 0.45) ? 0.3 + r() * 0.05 : 0.045,
    build: child ? 0.86 + r() * 0.08 : 0.92 + r() * 0.16,
  };
}

// ------------------------------------------------------------------------------------ uniforms and holiday clothes

const col = (hex: string) => new THREE.Color(hex);
/** Funfair Air's colours: the fair's ink navy, its red and its gold. */
const AIRLINE = { ink: '#1d1238', red: '#c8233f', gold: '#ffc23d' };

/** A Funfair Air pilot: white short-sleeved shirt with a navy tie, navy trousers, black shoes. */
export function pilotLook(r: () => number): Look {
  const base = randomLook(r, { gender: r() < 0.3 ? 'f' : 'm', age: r() < 0.25 ? 'old' : 'young' });
  return {
    ...base,
    hairStyle: base.gender === 'm' ? pick(r, ['Hair_SimpleParted', 'Hair_Buzzed']) : 'Hair_Buns',
    beard: false,
    top: col('#f4f6f8'),
    pants: col('#1b2033'),
    shoe: col('#141414'),
    sleeve: 0.3,
    legEnd: 0.045,
    build: 0.96 + r() * 0.1,
    trim: { kind: 'tie', colour: col('#1b2033') },
  };
}

/** Funfair Air cabin crew: the airline's red jacket with a gold neckerchief, navy trousers. */
export function cabinCrewLook(r: () => number): Look {
  const base = randomLook(r, { gender: r() < 0.7 ? 'f' : 'm', age: 'young' });
  return {
    ...base,
    hairStyle: base.gender === 'm' ? 'Hair_SimpleParted' : pick(r, ['Hair_Buns', 'Hair_Buns', 'Hair_Long']),
    beard: false,
    top: col(AIRLINE.red),
    pants: col(AIRLINE.ink),
    shoe: col('#141414'),
    sleeve: 0.96,
    legEnd: 0.045,
    build: 0.94 + r() * 0.08,
    trim: { kind: 'tie', colour: col(AIRLINE.gold) },
  };
}

/** Ramp and ground crew: a fluorescent orange or yellow top with silver reflective bands, work trousers, boots. */
export function groundCrewLook(r: () => number): Look {
  const base = randomLook(r, { gender: r() < 0.25 ? 'f' : 'm' });
  return {
    ...base,
    top: col(r() < 0.5 ? '#ff6a13' : '#d4ef1f'),
    pants: col(pick(r, ['#22262d', '#2b3447', '#3a3a36'])),
    shoe: col('#1a1612'),
    sleeve: r() < 0.6 ? 0.96 : 0.3,
    legEnd: 0.045,
    build: 1 + r() * 0.12,
    trim: { kind: 'bands', colour: col('#d9dde0') },
  };
}

const HOLIDAY_TOPS = ['#ffffff', '#f6e7c8', '#ff8a65', '#4fc3f7', '#ffd54f', '#f48fb1', '#81c784', '#ba68c8', '#4db6ac', '#ff7043', '#90caf9', '#e1f5fe'];
const HOLIDAY_SHORTS = ['#e8dcc4', '#c9b48a', '#3d5c8e', '#4f6f9e', '#f4f1ea', '#7aa6c2', '#556b2f', '#d97a5b'];
const SANDALS = ['#8a5a3c', '#2e5eaa', '#ff6f91', '#f4f4f2', '#ffcf3d', '#1a1a1a', '#2ec4b6'];
const SWIM = ['#e53950', '#1e88e5', '#ffb300', '#00acc1', '#8e24aa', '#43a047', '#f06292', '#ff7043', '#263238', '#fdd835'];

/** A traveller dressed for the flight out to the island (or back): comfortable, often summery. */
export function travellerLook(r: () => number, opts: { child?: boolean; gender?: Gender } = {}): Look {
  const look = randomLook(r, opts);
  if (r() < 0.35) look.top = col(pick(r, HOLIDAY_TOPS));
  return look;
}

/** A holidaymaker on Palm Cay's promenade: shorts, a tee or a vest, bright colours, sandals. */
export function beachLook(r: () => number, opts: { child?: boolean; gender?: Gender } = {}): Look {
  const look = randomLook(r, opts);
  return {
    ...look,
    top: col(pick(r, HOLIDAY_TOPS)),
    pants: col(pick(r, HOLIDAY_SHORTS)),
    shoe: col(pick(r, SANDALS)),
    sleeve: r() < 0.35 ? -0.1 : 0.2 + r() * 0.1,
    legEnd: look.gender === 'f' && r() < 0.4 ? 0.36 + r() * 0.04 : 0.3 + r() * 0.05,
  };
}

/**
 * Swimwear on the sand: swim shorts (bare-chested), a bikini, or a one-piece. Children wear swim
 * shorts with a rash vest.
 */
export function swimLook(r: () => number, opts: { child?: boolean; gender?: Gender } = {}): Look {
  const look = randomLook(r, opts);
  const c = col(pick(r, SWIM));
  const swim = { ...look, pants: c, shoe: col(pick(r, SANDALS)) };
  if (look.child) return { ...swim, top: col(pick(r, SWIM)), sleeve: 0.25, legEnd: 0.33 };
  if (look.gender === 'm') return { ...swim, topFrom: 2, legEnd: 0.36 + r() * 0.05, waist: 0.535 };
  if (r() < 0.6) return { ...swim, top: c, topFrom: 0.685, neckline: 0.755, sleeve: -0.1, waist: 0.53, legEnd: 0.47 };
  return { ...swim, top: c, sleeve: -0.1, neckline: 0.86, waist: 0.56, legEnd: 0.475 };
}

// ------------------------------------------------------------------------------------ shader

const bodyUniforms = () => ({
  uTop: { value: new THREE.Color() },
  uPants: { value: new THREE.Color() },
  uShoe: { value: new THREE.Color() },
  uSkin: { value: new THREE.Color() },
  uCut: { value: new THREE.Vector4() }, // sleeve end, leg end, waist, neckline
  uInflate: { value: 0.012 },
  // (both off by default, so every everyday outfit is drawn exactly as before)
  uTopFrom: { value: 0 },
  uTrim: { value: new THREE.Vector4() }, // colour, kind (0 none, 1 hi-vis bands, 2 tie)
});
type BodyUniforms = ReturnType<typeof bodyUniforms>;

/** Garment mask shared by the vertex and fragment stages: x = top, y = pants, z = shoe. */
const GARMENT = /* glsl */ `
  vec3 garment(vec4 r) {
    float y = r.x;
    float arm = r.y;
    bool isArm = arm > -0.5;
    float shoe = (r.z > 0.5 || y < 0.045) ? 1.0 : 0.0;
    float top = isArm ? step(arm, uCut.x) * step(uTopFrom, 1.0) : step(max(uCut.z, uTopFrom), y) * step(y, uCut.w) * step(r.w, 0.5);
    float pants = isArm ? 0.0 : step(y, uCut.z + 0.004) * step(uCut.y, y);
    pants *= 1.0 - shoe;
    top *= (1.0 - shoe) * (1.0 - pants);
    return vec3(top, pants, shoe);
  }
`;

/**
 * Fabric, drawn on the skin: a cotton tee and denim (or chinos) with real details. In the vertex
 * stage the cloth stands off the body with room where clothes hang (a shirt from the chest over the
 * stomach and past the waistband, sleeves opening out, trousers straight down from the thigh); in
 * the fragment stage it gets folds, seams, hems, a ribbed collar, a belt and worn denim. The folds
 * fade out with distance so they never shimmer.
 */
const FABRIC = /* glsl */ `
  float fHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float fNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(fHash(i), fHash(i + vec3(1, 0, 0)), f.x), mix(fHash(i + vec3(0, 1, 0)), fHash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(fHash(i + vec3(0, 0, 1)), fHash(i + vec3(1, 0, 1)), f.x), mix(fHash(i + vec3(0, 1, 1)), fHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  vec3 fabricBump(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
    vec3 sx = normalize(dFdx(surf_pos));
    vec3 sy = normalize(dFdy(surf_pos));
    vec3 r1 = cross(sy, surf_norm);
    vec3 r2 = cross(surf_norm, sx);
    float det = dot(sx, r1) * faceDir;
    vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
    return normalize(abs(det) * surf_norm - grad);
  }
`;

function dressBody(mat: THREE.MeshStandardMaterial, u: BodyUniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    const decl = /* glsl */ `
      uniform vec3 uTop; uniform vec3 uPants; uniform vec3 uShoe; uniform vec3 uSkin;
      uniform vec4 uCut; uniform float uInflate;
      uniform float uTopFrom; uniform vec4 uTrim;
      varying vec4 vRegion;
      varying vec3 vObj;
      varying vec3 vObjN;
      ${GARMENT}
    `;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 aRegion;\n${decl}`)
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vRegion = aRegion;
        vObj = position;
        vObjN = objectNormal;
        vec3 gm = garment(aRegion);
        float y = aRegion.x;
        float onArm = step(-0.5, aRegion.y);
        // a tee hangs from the chest: more room over the stomach and at its hem (it sits untucked over
        // the waistband), and the sleeves open out towards their ends
        // (the extra room builds up just above the hem, so the triangles crossing it aren't stretched
        // into a ragged edge: the hem itself is drawn as a clean line in the fragment stage)
        float hang = smoothstep(0.74, 0.62, y) * smoothstep(uCut.z + 0.004, uCut.z + 0.04, y);
        float shirt = gm.x * (1.3 + (1.0 - onArm) * 1.1 * hang + onArm * 1.4 * smoothstep(uCut.x - 0.3, uCut.x - 0.03, aRegion.y));
        // trousers drop straight from the thigh: more room down the shin to the ankle
        float legs = gm.y * 1.5 * (1.0 + 1.3 * smoothstep(0.42, 0.1, y));
        // the bare foot tucks in under the trainers (shoes.ts), so it never shows through them
        transformed += objectNormal * uInflate * (shirt + legs - gm.z * 0.8);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${decl}\n${FABRIC}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        vec3 gm = garment(vRegion);
        float cloth = gm.x + gm.y + gm.z;
        diffuseColor.rgb *= uSkin;
        float y = vRegion.x;
        float side = sign(vObj.x);
        float frontness = vObjN.z; // the body faces +z in its own space
        // ---- the tee: cotton, a ribbed crew collar, hemmed sleeves and a hem
        vec3 top = uTop;
        float collar = 1.0 - smoothstep(0.0, 0.022, uCut.w - y);
        top *= 1.0 - 0.14 * collar * (0.6 + 0.4 * sin(atan(vObj.x, vObj.z) * 90.0));
        float sleeveHem = vRegion.y > -0.5 ? 1.0 - smoothstep(0.0, 0.05, uCut.x - vRegion.y) : 0.0;
        top *= 1.0 - 0.1 * sleeveHem;
        float shirtHem = vRegion.y < -0.5 ? 1.0 - smoothstep(0.0, 0.016, y - uCut.z) : 0.0;
        top *= 1.0 - 0.12 * shirtHem;
        // a uniform's trim: hi-vis bands (two round the body, one round each upper arm), or a tie
        // down the shirt front from under the collar, narrow at the knot and wider at the blade
        if (uTrim.w > 0.5) {
          float trim;
          if (uTrim.w < 1.5) trim = vRegion.y > -0.5 ? step(abs(vRegion.y - 0.42), 0.045) : step(abs(y - 0.665), 0.012) + step(abs(y - 0.615), 0.012);
          else {
            float tw = mix(0.03, 0.011, smoothstep(0.66, 0.86, y));
            trim = step(vRegion.y, -0.5) * step(0.25, frontness) * step(abs(vObj.x), tw) * step(0.64, y) * step(y, uCut.w - 0.02);
          }
          top = mix(top, uTrim.rgb, clamp(trim, 0.0, 1.0));
        }
        // ---- the trousers: denim fades on the thighs and knees, darker side seams and turn-ups
        vec3 legs = uPants;
        float fade = smoothstep(0.25, 0.95, frontness) * (smoothstep(0.24, 0.32, y) * (1.0 - smoothstep(0.44, 0.52, y)) + 0.7 * smoothstep(0.2, 0.25, y) * (1.0 - smoothstep(0.27, 0.31, y)));
        legs *= 1.0 + 0.22 * fade;
        float seam = (1.0 - smoothstep(0.03, 0.09, abs(frontness))) * step(0.5, vObjN.x * side);
        legs *= 1.0 - 0.28 * seam;
        float cuff = 1.0 - smoothstep(0.0, 0.014, y - uCut.y);
        legs *= 1.0 - 0.18 * cuff;
        // a dark leather belt on the waistband (long trousers only): crisp stitched edges, denim belt
        // loops over it, and a brass frame buckle at the front. (Colours here are linear: dark.)
        float longLegs = step(uCut.y, 0.1);
        float bBot = uCut.z - 0.017;
        float bTop = uCut.z + 0.001;
        float belt = longLegs * gm.y * smoothstep(bBot - 0.0012, bBot, y) * (1.0 - smoothstep(bTop, bTop + 0.0012, y));
        float edge = belt * (1.0 - smoothstep(0.0012, 0.0026, min(y - bBot, bTop - y)));
        float ang = atan(vObj.x, vObj.z);
        float loops = belt * step(abs(fract(ang / 6.2831853 * 7.0) - 0.5), 0.022);
        float bx = abs(vObj.x);
        float front = step(0.35, frontness);
        float buckle = belt * front * step(bx, 0.026);
        float hole = buckle * step(bx, 0.016) * step(bBot + 0.004, y) * step(y, bTop - 0.004);
        vec3 leather = mix(vec3(0.032, 0.017, 0.009), vec3(0.014, 0.008, 0.004), edge);
        legs = mix(legs, leather, belt * (1.0 - loops));
        legs = mix(legs, vec3(0.5, 0.36, 0.12), buckle - hole);
        legs = mix(legs, leather, hole);
        // trainers with a pale sole
        vec3 shoe = vRegion.x < 0.012 ? vec3(0.85, 0.83, 0.8) : uShoe;
        vec3 clothCol = gm.x * top + gm.y * legs + gm.z * shoe;
        diffuseColor.rgb = mix(diffuseColor.rgb, clothCol, cloth);
        float beltShine = belt * (1.0 - loops);
        float buckleShine = buckle - hole;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.9 - gm.z * 0.3, cloth);
        roughnessFactor = mix(roughnessFactor, 0.62, beltShine);
        roughnessFactor = mix(roughnessFactor, 0.3, buckleShine);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, 0.85, buckleShine);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `vec3 geoNormal = normal;
        #include <normal_fragment_maps>
        // no muscle detail through the clothes...
        normal = normalize(mix(normal, geoNormal, cloth));
        // ...but the folds of the fabric: soft creases on the tee, bunching at the knees and ankles
        float near = 1.0 - smoothstep(6.0, 22.0, length(vViewPosition));
        if (cloth > 0.5 && gm.z < 0.5 && near > 0.0) {
          vec3 q = vObj * 9.0;
          float folds = gm.x * (fNoise(q * vec3(1.0, 2.2, 1.0)) * 0.6 + fNoise(q * 2.3) * 0.25);
          float knee = 1.0 - smoothstep(0.0, 0.05, abs(y - 0.29));
          float ankle = 1.0 - smoothstep(0.0, 0.07, y - uCut.y);
          folds += gm.y * (0.35 * fNoise(q * vec3(1.6, 0.8, 1.6)) + (knee * 0.9 + ankle) * (0.5 + 0.5 * sin(y * 260.0 + fNoise(q * 3.0) * 6.0)));
          // the waist gathers where the tee meets the waistband
          folds += gm.x * shirtHem * 0.6 * sin(atan(vObj.x, vObj.z) * 24.0);
          vec2 dh = vec2(dFdx(folds), dFdy(folds)) * 1.6 * near;
          normal = fabricBump(-vViewPosition, normal, dh, faceDirection);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'guest-body';
}

function tintHair(mat: THREE.MeshStandardMaterial, color: { value: THREE.Color }) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHair = color;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uHair;')
      // the strands are painted grey: tint them (×2 keeps the texture's mid-grey at the colour)
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= uHair * 2.2;');
  };
  mat.customProgramCacheKey = () => 'guest-hair';
}

// ------------------------------------------------------------------------------------ factory

/**
 * The base bodies are sculpted like superheroes. Relax the trunk and limbs a few rounds
 * (Taubin smoothing: shrink then re-inflate, so volume holds) and soften their normals, which
 * turns six-packs and bulging arms into ordinary builds. Head, hands and feet stay as sculpted.
 */
function relax(g: THREE.BufferGeometry, height: number) {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const idx = g.getIndex()!;
  const n = pos.count;
  // weld UV-seam duplicates so smoothing doesn't tear the seams open
  const canon = new Int32Array(n);
  const keyed = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    const c = keyed.get(k);
    canon[i] = c ?? i;
    if (c === undefined) keyed.set(k, i);
  }
  const nbr = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    let s = nbr.get(a);
    if (!s) nbr.set(a, (s = new Set()));
    s.add(b);
  };
  for (let t = 0; t < idx.count; t += 3) {
    const a = canon[idx.getX(t)];
    const b = canon[idx.getX(t + 1)];
    const c = canon[idx.getX(t + 2)];
    link(a, b), link(b, a), link(b, c), link(c, b), link(a, c), link(c, a);
  }
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    P.set([pos.getX(i), pos.getY(i), pos.getZ(i)], i * 3);
    N.set([nor.getX(i), nor.getY(i), nor.getZ(i)], i * 3);
  }
  // how much each vertex may move: the trunk and limbs, fading out toward neck, wrists, ankles
  const shoulder = 0.18 * height;
  const w = new Float32Array(n);
  for (const [i] of nbr) {
    const y = P[i * 3 + 1] / height;
    const x = Math.abs(P[i * 3]);
    const trunk = THREE.MathUtils.smoothstep(y, 0.07, 0.12) * (1 - THREE.MathUtils.smoothstep(y, 0.78, 0.82));
    const arm = y > 0.7 && x > shoulder ? 1 - THREE.MathUtils.smoothstep(x, 0.68 * height * 0.5, 0.78 * height * 0.5) : 1;
    w[i] = trunk * arm;
  }
  const tmp = new Float32Array(n * 3);
  const pass = (src: Float32Array, k: number) => {
    tmp.set(src);
    for (const [i, s] of nbr) {
      if (!w[i]) continue;
      let ax = 0;
      let ay = 0;
      let az = 0;
      for (const j of s) {
        ax += src[j * 3];
        ay += src[j * 3 + 1];
        az += src[j * 3 + 2];
      }
      const m = 1 / s.size;
      for (let c = 0; c < 3; c++) tmp[i * 3 + c] = src[i * 3 + c] + k * w[i] * ([ax, ay, az][c] * m - src[i * 3 + c]);
    }
    src.set(tmp);
  };
  for (let it = 0; it < 18; it++) {
    pass(P, 0.5);
    pass(P, -0.53);
  }
  for (let it = 0; it < 6; it++) pass(N, 0.6);
  const outP = new Float32Array(n * 3);
  const outN = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = canon[i];
    outP.set(P.subarray(c * 3, c * 3 + 3), i * 3);
    // seam duplicates keep their own normals where nothing moved (e.g. hard edges on the face)
    const src = w[c] ? N.subarray(c * 3, c * 3 + 3) : [nor.getX(i), nor.getY(i), nor.getZ(i)];
    const v = new THREE.Vector3(src[0], src[1], src[2]).normalize();
    outN.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('position', new THREE.BufferAttribute(outP, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(outN, 3));
}

/**
 * Gym arms to everyday arms. The sculpts have bulging biceps, triceps, forearms and deltoids:
 * every arm vertex is pulled in towards the line from the shoulder to the wrist (in the bind pose),
 * most round the upper arm, and each cross-section is evened out towards its average radius so no
 * single muscle stands out. Hands are left alone, and the shoulder blends into the body by the
 * vertex's arm weight, so nothing tears where the arm meets the chest.
 */
function slimArms(mesh: THREE.SkinnedMesh) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const bind = (name: string) => {
    const i = bones.findIndex((b) => b.name === name);
    return new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert());
  };
  const UPPER = /^(upperarm|lowerarm|clavicle)_/;
  const HAND = /^(hand|index|middle|ring|pinky|thumb)_/;
  for (const side of ['l', 'r'] as const) {
    const shoulder = bind(`upperarm_${side}`);
    const wrist = bind(`hand_${side}`);
    const axis = wrist.clone().sub(shoulder);
    const len = axis.length();
    axis.normalize();
    // the arm's vertices, with how far along it they are and how much they belong to it
    const verts: { i: number; t: number; w: number; foot: THREE.Vector3; r: THREE.Vector3 }[] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      let arm = 0;
      let hand = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const n = bones[si.getComponent(i, k)].name;
        if (!n.endsWith(`_${side}`)) continue;
        if (UPPER.test(n)) arm += w;
        else if (HAND.test(n)) hand += w;
      }
      if (arm < 0.05 || hand > 0.5) continue;
      p.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      const t = p.clone().sub(shoulder).dot(axis) / len;
      if (t < -0.15 || t > 1.02) continue;
      const foot = shoulder.clone().addScaledVector(axis, t * len);
      verts.push({ i, t, w: Math.min(1, arm) * (1 - hand), foot, r: p.clone().sub(foot) });
    }
    // the average radius along the arm, in short sections
    const BINS = 24;
    const sum = new Float32Array(BINS);
    const cnt = new Float32Array(BINS);
    const bin = (t: number) => Math.min(BINS - 1, Math.max(0, Math.floor(((t + 0.15) / 1.17) * BINS)));
    for (const v of verts) {
      sum[bin(v.t)] += v.r.length();
      cnt[bin(v.t)]++;
    }
    for (const v of verts) {
      const b = bin(v.t);
      const mean = cnt[b] ? sum[b] / cnt[b] : v.r.length();
      // how much slimmer: most round the biceps and the deltoid, less at the elbow, none at the wrist
      const t = v.t;
      const slim =
        t < 0.12
          ? 0.87
          : t < 0.5
            ? 0.83
            : t < 0.58
              ? THREE.MathUtils.lerp(0.83, 0.9, (t - 0.5) / 0.08)
              : THREE.MathUtils.lerp(0.86, 0.97, THREE.MathUtils.smoothstep(t, 0.62, 1.0));
      const r = v.r.length();
      if (r < 1e-5) continue;
      // even the section out (no single muscle bulging), then pull it in
      const target = THREE.MathUtils.lerp(r, mean, 0.55) * slim;
      const k = THREE.MathUtils.lerp(1, target / r, v.w);
      const q = v.foot.clone().addScaledVector(v.r, k);
      pos.setXYZ(v.i, q.x, q.y, q.z);
    }
  }
  pos.needsUpdate = true;
  g.computeBoundingSphere();
}

/**
 * A bodybuilder's neck and trapezius to an ordinary one: the neck is drawn in round its own axis,
 * and the slope from the neck down to the shoulders (the traps) is lowered, blending out towards the
 * head, the chest and the arms so nothing creases.
 */
function easeNeck(mesh: THREE.SkinnedMesh, height: number) {
  const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
  const bones = mesh.skeleton.bones;
  const bind = (name: string) => {
    const i = bones.findIndex((b) => b.name === name);
    return i < 0 ? null : new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert());
  };
  const neck = bind('neck_01');
  const head = bind('Head');
  const shoulder = bind('upperarm_l');
  if (!neck || !head || !shoulder) return;
  const shoulderX = Math.abs(shoulder.x);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const ax = Math.abs(x);
    // the neck itself, from the base to under the jaw: about 8% slimmer round its axis
    const neckBand = THREE.MathUtils.smoothstep(y, neck.y - 0.05, neck.y - 0.01) * (1 - THREE.MathUtils.smoothstep(y, head.y - 0.02, head.y + 0.03));
    const nearAxis = 1 - THREE.MathUtils.smoothstep(ax, 0.06, 0.1);
    const k = 1 - 0.08 * neckBand * nearAxis;
    const nx = x * k;
    z = neck.z + (z - neck.z) * k;
    // the traps: between the neck and the shoulder, a hump a few centimetres too high
    const across = THREE.MathUtils.smoothstep(ax, 0.045, 0.08) * (1 - THREE.MathUtils.smoothstep(ax, shoulderX * 0.75, shoulderX * 1.05));
    const up = THREE.MathUtils.smoothstep(y, neck.y - 0.12, neck.y - 0.06) * (1 - THREE.MathUtils.smoothstep(y, neck.y + 0.0, neck.y + 0.04));
    y -= 0.022 * across * up * (height / 1.8);
    pos.setXYZ(i, nx, y, z);
  }
  pos.needsUpdate = true;
}

/**
 * No more V-taper: the lats that flare out under the arms are brought in, so the back and sides
 * drop fairly straight from the armpits to the waist. Only the trunk moves (not the arms), easing
 * out towards the armpit, the waist and the spine so the outline stays smooth.
 */
function narrowBack(mesh: THREE.SkinnedMesh, height: number) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  const bones = mesh.skeleton.bones;
  const shoulderI = bones.findIndex((b) => b.name === 'upperarm_l');
  const shoulderX = Math.abs(new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[shoulderI].clone().invert()).x);
  const ARM = /^(upperarm|lowerarm|hand|clavicle)_/;
  for (let i = 0; i < pos.count; i++) {
    let arm = 0;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w && ARM.test(bones[si.getComponent(i, k)].name)) arm += w;
    }
    const y = pos.getY(i) / height;
    const x = pos.getX(i);
    const ax = Math.abs(x);
    // under the armpits, down to the waist, most at the widest part of the lats
    const band = THREE.MathUtils.smoothstep(y, 0.57, 0.63) * (1 - THREE.MathUtils.smoothstep(y, 0.7, 0.76));
    // the sides, not the spine or the middle of the chest; fading out before the armpit
    const sideways = THREE.MathUtils.smoothstep(ax, 0.05, 0.13) * (1 - THREE.MathUtils.smoothstep(ax, shoulderX * 0.95, shoulderX * 1.15));
    const k = 1 - 0.11 * band * sideways * (1 - Math.min(1, arm * 2));
    pos.setX(i, x * k);
  }
  pos.needsUpdate = true;
}

interface BodyTemplate {
  root: THREE.Object3D;
  height: number;
  clips: Map<string, THREE.AnimationClip>;
  /** Trainers fitted to this body's feet (see shoes.ts), shared by everyone with it. */
  shoes: THREE.BufferGeometry;
}

/** Bone categories used to tell feet, arms and the head apart. */
const FOOT = /^(foot|ball)_/;
const ARM = /^(upperarm|lowerarm|hand|index|middle|ring|pinky|thumb)_/;
const HEAD = /^(Head|neck_01)$/;

/** Builds guests: parses the shared rig once, then clones it with a look per person. */
export class PeopleFactory {
  private bodies: Record<Gender, BodyTemplate>;
  private hair = new Map<string, THREE.SkinnedMesh>();
  /** Ground speed each locomotion clip was animated for, at 1.8 m tall. */
  speeds: Record<string, number> = {};

  constructor(guests: GLTF, anims: GLTF) {
    const scene = guests.scene;
    // the loader made node names unique across the file (pelvis_1, pelvis_2…): every part has
    // its own copy of the skeleton, so put the plain bone names back for the clips to bind
    for (const part of scene.children) {
      let suffix = '';
      part.traverse((o) => {
        const m = /^root(_\d+)$/.exec(o.name);
        if (m) suffix = m[1];
      });
      if (suffix) part.traverse((o) => o !== part && o.name.endsWith(suffix) && (o.name = o.name.slice(0, -suffix.length)));
    }
    const rawClips = new Map(anims.animations.map((c) => [c.name, c]));
    const animPelvis = anims.scene.getObjectByName('pelvis')!.position.length();
    const body = (name: string): BodyTemplate => {
      const root = scene.getObjectByName(name)!;
      let main!: THREE.SkinnedMesh;
      root.traverse((o) => {
        const m = o as THREE.SkinnedMesh;
        if (!m.isSkinnedMesh) return;
        m.castShadow = true;
        m.frustumCulled = false;
        if ((m.material as THREE.Material).name.includes('Superhero')) main = m;
      });
      const box = new THREE.Box3().setFromBufferAttribute(main.geometry.getAttribute('position') as THREE.BufferAttribute);
      const height = box.max.y - box.min.y;
      relax(main.geometry, height);
      slimArms(main);
      easeNeck(main, height);
      narrowBack(main, height);
      this.addRegions(main, height);
      const region = main.geometry.getAttribute('aRegion') as THREE.BufferAttribute;
      // the same feet the garment shader paints as shoes: foot bones, or right at the ground
      const shoes = buildShoes(main, (i) => region.getZ(i) > 0.5 || region.getX(i) < 0.045);
      // pelvis bob was animated on the library's mannequin: rescale it to this body's hips
      const k = root.getObjectByName('pelvis')!.position.length() / animPelvis;
      const clips = new Map<string, THREE.AnimationClip>();
      for (const [n, c] of rawClips) {
        const cc = c.clone();
        for (const t of cc.tracks) if (t.name.endsWith('.position')) for (let i = 0; i < t.values.length; i++) t.values[i] *= k;
        clips.set(n, cc);
      }
      return { root, height, clips, shoes };
    };
    this.bodies = { m: body('Male'), f: body('Female') };
    for (const n of ['Hair_Long', 'Hair_Buns', 'Hair_SimpleParted', 'Hair_Buzzed', 'Hair_BuzzedFemale', 'Hair_Beard']) {
      const g = scene.getObjectByName(n);
      let mesh: THREE.SkinnedMesh | null = null;
      g?.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && (mesh = o as THREE.SkinnedMesh));
      if (mesh) this.hair.set(n, mesh);
    }
    this.measureSpeeds();
  }

  /** Per-vertex body coordinates for the garment shader (from the bind pose). */
  private addRegions(mesh: THREE.SkinnedMesh, height: number) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position');
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const bones = mesh.skeleton.bones;
    const bindPos = (name: string) => {
      const i = bones.findIndex((b) => b.name === name);
      return new THREE.Vector3().setFromMatrixPosition(mesh.skeleton.boneInverses[i].clone().invert());
    };
    const shoulder = Math.abs(bindPos('upperarm_l').x);
    const wrist = Math.abs(bindPos('hand_l').x);
    const out = new Float32Array(pos.count * 4);
    for (let i = 0; i < pos.count; i++) {
      let arm = 0;
      let foot = 0;
      let head = 0;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (!w) continue;
        const n = bones[si.getComponent(i, k)].name;
        if (ARM.test(n)) arm += w;
        else if (FOOT.test(n)) foot += w;
        else if (HEAD.test(n)) head += w;
      }
      const x = Math.abs(pos.getX(i));
      const y = pos.getY(i) / height;
      // arm vertices: 0 at the shoulder, 1 at the wrist; others -1
      const along = arm > 0.5 ? (x - shoulder) / (wrist - shoulder) : -1;
      out.set([y, along, foot, head], i * 4);
    }
    g.setAttribute('aRegion', new THREE.BufferAttribute(out, 4));
  }

  /** How fast each in-place loop would really travel, from how far its feet sweep. */
  private measureSpeeds() {
    const t = this.bodies.m;
    const model = cloneSkinned(t.root);
    const mixer = new THREE.AnimationMixer(model);
    const foot = model.getObjectByName('foot_l')!;
    const p = new THREE.Vector3();
    for (const name of ['Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop']) {
      const clip = t.clips.get(name);
      if (!clip) continue;
      const a = mixer.clipAction(clip).play();
      // the foot sweeps back and forth once per cycle (two steps); running strides reach
      // further than the sweep shows, hence the larger factor
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 64; i++) {
        a.time = (i / 64) * clip.duration;
        mixer.update(0);
        model.updateMatrixWorld(true);
        const z = foot.getWorldPosition(p).z;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      const factor = name === 'Walk_Loop' ? 2 : name === 'Jog_Fwd_Loop' ? 2.6 : 3;
      this.speeds[name] = ((factor * (hi - lo)) / clip.duration) * (1.8 / t.height);
      a.stop();
    }
    const sit = t.clips.get('Sitting_Idle_Loop');
    if (sit) {
      mixer.clipAction(sit).play();
      mixer.update(0);
      model.updateMatrixWorld(true);
      const pelvis = model.getObjectByName('pelvis')!.getWorldPosition(new THREE.Vector3()).y;
      this.sitPelvis = pelvis / t.height;
    }
  }

  /** Pelvis height above the rig's origin in the seated clip (fraction of height). */
  sitPelvis = 0.3;

  create(look: Look): PersonRig {
    const t = this.bodies[look.gender];
    const model = cloneSkinned(t.root);
    let body!: THREE.SkinnedMesh;
    const skinned: THREE.SkinnedMesh[] = [];
    model.traverse((o) => (o as THREE.SkinnedMesh).isSkinnedMesh && skinned.push(o as THREE.SkinnedMesh));
    for (const m of skinned) if ((m.material as THREE.Material).name.includes('Superhero')) body = m;

    // per-person body material: outfit, skin tone
    const u = bodyUniforms();
    u.uTop.value.copy(look.top);
    u.uPants.value.copy(look.pants);
    u.uShoe.value.copy(look.shoe);
    u.uSkin.value.copy(look.skin);
    const waist = look.waist ?? (look.gender === 'm' ? 0.56 : 0.575);
    // crew neck: up to the neck (whose vertices are excluded by their head/neck weights)
    const neck = look.neckline ?? 0.9;
    u.uCut.value.set(look.sleeve, look.legEnd, waist, neck);
    u.uInflate.value = 0.016 * look.build;
    u.uTopFrom.value = look.topFrom ?? 0;
    if (look.trim) u.uTrim.value.set(look.trim.colour.r, look.trim.colour.g, look.trim.colour.b, look.trim.kind === 'bands' ? 1 : 2);
    const bodyMat = (body.material as THREE.MeshStandardMaterial).clone();
    dressBody(bodyMat, u);
    body.material = bodyMat;

    // hair and brows share a per-person tinted material
    const hairColor = { value: look.hair.clone().convertSRGBToLinear() };
    const hairMats = new Map<THREE.Material, THREE.MeshStandardMaterial>();
    const hairMat = (src: THREE.Material) => {
      let m = hairMats.get(src);
      if (!m) {
        m = (src as THREE.MeshStandardMaterial).clone();
        tintHair(m, hairColor);
        hairMats.set(src, m);
      }
      return m;
    };
    for (const m of skinned) if ((m.material as THREE.Material).name.startsWith('MI_Hair')) m.material = hairMat(m.material as THREE.Material);
    const extras: THREE.SkinnedMesh[] = [];
    for (const name of [look.hairStyle, look.beard ? 'Hair_Beard' : null]) {
      const src = name && this.hair.get(name);
      if (!src) continue;
      const hm = src.clone() as THREE.SkinnedMesh;
      // re-bind onto this person's skeleton, bone for bone by name
      const bones = src.skeleton.bones.map((b) => model.getObjectByName(b.name) as THREE.Bone);
      hm.bind(new THREE.Skeleton(bones, src.skeleton.boneInverses), src.bindMatrix);
      hm.material = hairMat(src.material as THREE.Material);
      hm.castShadow = true;
      hm.frustumCulled = false;
      body.parent!.add(hm);
      extras.push(hm);
    }
    // trainers over the painted feet: bound to this person's skeleton, placed exactly like the body
    const shoes = new THREE.SkinnedMesh(t.shoes, shoeMaterial(look.shoe));
    shoes.name = 'shoes';
    shoes.position.copy(body.position);
    shoes.quaternion.copy(body.quaternion);
    shoes.scale.copy(body.scale);
    shoes.bind(body.skeleton, body.bindMatrix);
    shoes.castShadow = true;
    shoes.frustumCulled = false;
    body.parent!.add(shoes);
    extras.push(shoes);
    return new PersonRig(this, t, model, look, [...skinned, ...extras]);
  }
}

// ------------------------------------------------------------------------------------ rig

const v1 = new THREE.Vector3();
const v2 = new THREE.Vector3();
const q1 = new THREE.Quaternion();
const q2 = new THREE.Quaternion();

/** Turn a bone (in world space) so the direction to its child bone becomes `dir`, by amount k. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3, k = 1) {
  bone.updateWorldMatrix(true, false);
  child.updateWorldMatrix(false, false);
  const from = v1.setFromMatrixPosition(child.matrixWorld).sub(v2.setFromMatrixPosition(bone.matrixWorld)).normalize();
  q1.setFromUnitVectors(from, dir);
  if (k < 1) q1.slerp(q2.identity(), 1 - k);
  bone.getWorldQuaternion(q2);
  q2.premultiply(q1);
  bone.parent!.getWorldQuaternion(q1).invert();
  bone.quaternion.copy(q1.multiply(q2));
}

export type Gait = 'walk' | 'jog' | 'sprint';
export type Base = 'stand' | 'sit' | 'talk' | 'crouch' | 'dance';
const BASE_CLIP: Record<Base, string> = {
  stand: 'Idle_Loop',
  sit: 'Sitting_Idle_Loop',
  talk: 'Idle_Talking_Loop',
  crouch: 'Crouch_Idle_Loop',
  dance: 'Dance_Loop',
};

/** One person's model and animation: locomotion blend, idle variants, gestures and poses. */
export class PersonRig {
  root = new THREE.Group();
  readonly look: Look;
  private mixer: THREE.AnimationMixer;
  private bases = new Map<Base, THREE.AnimationAction>();
  private baseW = new Map<Base, number>();
  private base: Base = 'stand';
  private loco: Record<Gait, THREE.AnimationAction>;
  private gesture: THREE.AnimationAction | null = null;
  private gestureT = 0;
  private phase = Math.random();
  private moveW = 0;
  private gaitW: Record<Gait, number> = { walk: 1, jog: 0, sprint: 0 };
  private bones: Record<string, THREE.Object3D> = {};
  private meshes: THREE.SkinnedMesh[];
  /** 0…1: both hands in the air (coaster airtime). */
  armsUp = 0;
  private waveT = 0;
  private waveDur = 1;
  private kickT = 0;
  private holder = new THREE.Group();

  constructor(
    private f: PeopleFactory,
    private t: BodyTemplate,
    model: THREE.Object3D,
    look: Look,
    meshes: THREE.SkinnedMesh[],
  ) {
    this.look = look;
    this.meshes = meshes;
    const k = look.height / t.height;
    this.holder.add(model);
    this.holder.scale.set(k * look.build, k, k * (0.5 + look.build / 2));
    this.holder.rotation.y = Math.PI; // the rig faces +z; the park's convention is -z forward
    this.root.add(this.holder);
    for (const n of ['pelvis', 'Head', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r', 'upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'spine_03'])
      this.bones[n] = model.getObjectByName(n)!;
    // children: a bigger head on the same body reads as young
    if (look.child) this.bones.Head.scale.setScalar(1.1 + (1.5 - look.height) * 0.45);

    this.mixer = new THREE.AnimationMixer(model);
    const loop = (name: string, w = 0) => {
      const a = this.mixer.clipAction(this.clip(name));
      a.play();
      a.setEffectiveWeight(w);
      return a;
    };
    for (const b of Object.keys(BASE_CLIP) as Base[]) {
      this.bases.set(b, loop(BASE_CLIP[b], b === 'stand' ? 1 : 0));
      this.baseW.set(b, b === 'stand' ? 1 : 0);
    }
    const idle = this.bases.get('stand')!;
    idle.time = Math.random() * idle.getClip().duration; // nobody breathes in sync
    this.loco = { walk: loop('Walk_Loop'), jog: loop('Jog_Fwd_Loop'), sprint: loop('Sprint_Loop') };
    for (const a of Object.values(this.loco)) a.timeScale = 0; // phase follows distance walked
  }

  private clip(name: string) {
    const c = this.t.clips.get(name);
    if (!c) throw new Error(`guest animations have no "${name}" clip`);
    return c;
  }

  get height() {
    return this.look.height;
  }

  /** One of the named bones (Head, hand_l, hand_r…), for what's worn or held to follow it. */
  bone(name: 'Head' | 'hand_l' | 'hand_r' | 'lowerarm_l' | 'lowerarm_r' | 'spine_03' | 'pelvis') {
    return this.bones[name];
  }

  /** The skinned meshes (body, eyes, hair, shoes), e.g. to measure where the face is. */
  get skinnedMeshes(): readonly THREE.SkinnedMesh[] {
    return this.meshes;
  }

  /** Where the stride is, 0…1 (two footfalls per cycle). */
  get stride() {
    return this.phase;
  }

  /** 0 walking … 1 running. */
  get runBlend() {
    return this.gaitW.jog + this.gaitW.sprint;
  }

  /** After dark: a faint glow so the person stays readable under the park lights. */
  setGlow(k: number) {
    for (const m of this.meshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      if (mat.name !== 'MI_Eyes') mat.emissive.setScalar(0.09 * k);
    }
  }

  /** Where the rig's origin goes below a seat surface for the seated clip to sit on it. */
  get seatDrop() {
    return this.f.sitPelvis * this.look.height - 0.07 * (this.look.height / 1.8);
  }

  /** What the person does while standing still. */
  setBase(b: Base) {
    this.base = b;
  }

  get pose() {
    return this.base;
  }

  /** One-shot full-body clip: 'Interact', 'Roll', 'Punch_Cross', 'Jump_Start'… */
  play(name: string, speed = 1) {
    if (this.gesture) this.gesture.fadeOut(0.15);
    const a = this.mixer.clipAction(this.clip(name));
    a.reset().setLoop(THREE.LoopOnce, 1).setEffectiveTimeScale(speed).setEffectiveWeight(1).fadeIn(0.15).play();
    a.clampWhenFinished = true;
    this.gesture = a;
    this.gestureT = a.getClip().duration / speed;
    return this.gestureT;
  }

  get busy() {
    return this.gestureT > 0;
  }

  /** Wave with the right hand for a couple of seconds (upper body only). */
  wave(seconds = 2.2) {
    this.waveT = this.waveDur = seconds;
  }

  /** A quick right-footed kick (procedural: the library has no kick). */
  kick() {
    this.kickT = 0.55;
  }

  /** Show or hide the small face meshes (eyes, brows) — they cost a draw each, far away. */
  setDetail(near: boolean) {
    for (const m of this.meshes) {
      const n = (m.material as THREE.Material).name;
      if (n === 'MI_Eyes' || (n.startsWith('MI_Hair') && m.geometry.getAttribute('position').count < 1000)) m.visible = near;
    }
  }

  setShadows(on: boolean) {
    for (const m of this.meshes) m.castShadow = on;
  }

  /** Advance the animation. `speed` is ground speed (m/s). */
  update(dt: number, speed: number) {
    const kk = 1 - Math.exp(-dt * 8);
    const scale = this.look.height / 1.8;
    const sp = this.f.speeds;
    const walkV = (sp.Walk_Loop ?? 1.4) * scale;
    const jogV = (sp.Jog_Fwd_Loop ?? 3.4) * scale;
    const sprintV = (sp.Sprint_Loop ?? 6) * scale;
    // which loop suits this speed (blended across the boundaries)
    const toJog = THREE.MathUtils.smoothstep(speed, walkV * 1.25, walkV * 1.25 + 0.6);
    const toSprint = THREE.MathUtils.smoothstep(speed, jogV * 1.2, jogV * 1.2 + 1);
    const want = { walk: 1 - toJog, jog: toJog * (1 - toSprint), sprint: toJog * toSprint };
    for (const g of ['walk', 'jog', 'sprint'] as Gait[]) this.gaitW[g] += (want[g] - this.gaitW[g]) * kk;
    this.moveW += (Math.min(1, speed / (walkV * 0.35)) - this.moveW) * kk;
    // one shared stride phase, advanced by distance, so feet stay planted
    const cyc = (g: Gait, v: number) => (speed / v) / this.loco[g].getClip().duration;
    const rate = this.gaitW.walk * cyc('walk', walkV) + this.gaitW.jog * cyc('jog', jogV) + this.gaitW.sprint * cyc('sprint', sprintV);
    this.phase = (this.phase + rate * dt) % 1;

    let gw = 0;
    if (this.gesture) {
      this.gestureT -= dt;
      if (this.gestureT < 0.18 && this.gesture.getEffectiveWeight() > 0.99) this.gesture.fadeOut(0.18);
      gw = this.gesture.getEffectiveWeight();
      if (this.gestureT <= 0) {
        this.gesture.stop();
        this.gesture = null;
        gw = 0;
      }
    }
    const still = (1 - this.moveW) * (1 - gw);
    for (const [b, a] of this.bases) {
      const w = this.baseW.get(b)! + ((b === this.base ? 1 : 0) - this.baseW.get(b)!) * kk;
      this.baseW.set(b, w);
      a.setEffectiveWeight(w * still);
    }
    for (const g of ['walk', 'jog', 'sprint'] as Gait[]) {
      const a = this.loco[g];
      a.time = this.phase * a.getClip().duration;
      a.setEffectiveWeight(this.gaitW[g] * this.moveW * (1 - gw));
    }
    this.mixer.update(dt);
    this.procedural(dt);
  }

  /** Poses the clips don't have, layered on top: hands up, waving, kicking. */
  private procedural(dt: number) {
    const b = this.bones;
    const needed = this.armsUp > 0.01 || this.waveT > 0 || this.kickT > 0;
    if (!needed) return;
    this.root.updateWorldMatrix(true, false);
    const rq = this.root.getWorldQuaternion(new THREE.Quaternion());
    const dir = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize().applyQuaternion(rq);
    // the person's left is -x in their own frame
    if (this.armsUp > 0.01)
      for (const [side, sx] of [['l', -1], ['r', 1]] as const) {
        aim(b[`upperarm_${side}`], b[`lowerarm_${side}`], dir(sx * 0.35, 1, -0.1), this.armsUp);
        aim(b[`lowerarm_${side}`], b[`hand_${side}`], dir(sx * 0.2, 1, -0.05), this.armsUp);
      }
    if (this.waveT > 0) {
      this.waveT -= dt;
      // raise the arm over a quarter second, lower it again at the end
      const k = THREE.MathUtils.clamp(Math.min(this.waveT, this.waveDur - this.waveT) * 4, 0, 1);
      const sway = Math.sin(this.waveT * 14) * 0.45;
      aim(b.upperarm_r, b.lowerarm_r, dir(0.8, 0.55, -0.1), k);
      aim(b.lowerarm_r, b.hand_r, dir(0.25 + sway, 1, 0), k);
    }
    if (this.kickT > 0) {
      this.kickT -= dt;
      const p = 1 - this.kickT / 0.55; // 0 → 1
      const swing = Math.sin(Math.min(1, p) * Math.PI); // wind-up and follow-through
      const fwd = p < 0.3 ? -0.6 : 1;
      aim(b.thigh_r, b.calf_r, dir(0.05, -1 + swing * 0.9, -fwd * swing), Math.min(1, swing * 1.4));
      aim(b.calf_r, b.foot_r, dir(0, -1 + swing * 1.1, -swing * 1.3), Math.min(1, swing * 1.4));
    }
  }

  dispose() {
    this.mixer.stopAllAction();
    this.root.removeFromParent();
  }
}
