// Tints a person's hair and hides it under a hat. The hair material (AvatarSpec.parts.hair: alpha-
// tested cards, double-sided) is patched once per person, like outfit-tint.ts patches the clothes:
//
// - The tint is the colour times the texel's luminance over the hair's mean luminance (from
//   AvatarSpec.hairTone), in linear light, with outfit-tint's detail shaping: strands keep their
//   light and shade, so dark brown dyed blonde reads as blonde hair rather than a yellow decal.
//   Brows and lashes are cards in the same material and take the tint too (blonde hair, blonde
//   brows); MakeHuman's eyeballs share it as well, and are left alone: they're the vertices skinned
//   to the eye bones.
// - The hat clip is an ellipsoid in the Head bone's space (metres): hair fragments inside it are
//   discarded, so a hat can sit on the head without hair poking through its crown, while long hair
//   below the brim and down the back stays. The test runs on each vertex's bind-pose position taken
//   into the head bone's rest frame, so it costs no per-frame work and follows the head as it moves
//   (hair cards are skinned to the head; long hair also to the neck and back, where the ellipsoid
//   doesn't reach).
//
//   const hair = tintHair(personHairMaterial, { mean: 0.03 }, { eyes: [6, 7], head: 5, boneInverses, bindMatrix });
//   hair.setTint('#cfae74');                          // null puts the hair's own colour back
//   hair.setHatClip({ centre: [0.13, 0.02, 0], radii: [0.11, 0.13, 0.12] });
//
// Most avatars also have hair painted into the head texture (the scalp under the cards, all of a
// crew cut, beards and moustaches). That part tints only where the head material carries a
// 'hairMask' (takeHairMask; scripts/people/hair-mask.mjs makes it): R the scalp's hair, G facial
// hair. Pass it as `mask`, with the paint's own tones (`paint`: each one's mean luminance, as
// hairTone's is for the cards), and the same colour tints the head: the scalp and the beard each
// keep their light and shade relative to their own mean, so a beard a shade darker than the hair
// stays a shade darker in any colour.
//
// Material.clone() doesn't copy onBeforeCompile: call tintHair on every clone (they share one
// compiled program; only the uniforms are per material).

import * as THREE from 'three';
import { detailShape } from './outfit-tint';

/** An ellipsoid in the Head bone's local space (metres): what a hat covers. */
export interface HatClip {
  centre: [number, number, number];
  radii: [number, number, number];
}

export interface HairTint {
  /** Tints the hair ('#rrggbb' or any three.js colour), or gives it back its own colour (null). */
  setTint(colour: THREE.ColorRepresentation | null): void;
  /** Hides the hair inside `hat` (Head-bone space), or shows it all again (null). */
  setHatClip(hat: HatClip | null): void;
}

export interface HairSkin {
  /** Skeleton indices of the eye bones (their vertices are never tinted); -1 when the rig has none. */
  eyes: [number, number];
  /** Skeleton index of the head bone. */
  head: number;
  boneInverses: readonly THREE.Matrix4[];
  /** The skinned mesh's bind matrix (identity for glTF people). */
  bindMatrix: THREE.Matrix4;
}

/** Used when the manifest has no hairTone yet for hair that can be tinted: a mid brown's mean luminance. */
export const FALLBACK_HAIR_MEAN = 0.045;

const handles = new WeakMap<THREE.Material, HairTint>();

/**
 * The hair mask a people GLB may park in a head material's occlusion slot (named 'hairMask', as the
 * outfit mask is on the body): taken off, so three doesn't read it as ambient occlusion, and
 * returned; null when the material has none.
 */
export function takeHairMask(material: THREE.MeshStandardMaterial): THREE.Texture | null {
  const kept = taken.get(material);
  if (kept) return kept;
  const ao = material.aoMap;
  if (!ao || ao.name !== 'hairMask') return null;
  material.aoMap = null;
  material.needsUpdate = true;
  taken.set(material, ao);
  return ao;
}
const taken = new WeakMap<THREE.Material, THREE.Texture>();

/** The mean luminances of the hair painted into a head texture, by the mask's channel (null: that channel is empty). */
export interface HairPaint {
  scalp?: number | null;
  beard?: number | null;
}

/**
 * Patches a hair material (the cards) or, with `mask`, a head material (the painted hair) to take a
 * tint. `tone` is the cards' (AvatarSpec.hairTone); with a mask, `paint` gives the scalp's and the
 * beard's own means, each falling back to the cards' (then to FALLBACK_HAIR_MEAN).
 */
export function tintHair(material: THREE.MeshStandardMaterial, tone: { mean: number } | null | undefined, skin: HairSkin, mask: THREE.Texture | null = null, paint: HairPaint = {}): HairTint {
  const existing = handles.get(material);
  if (existing) return existing;

  const mean = Math.max(1e-4, tone?.mean ?? FALLBACK_HAIR_MEAN);
  const shape = detailShape(mean);
  // the painted hair's two channels, scalp (x) and beard (y), each shaped by its own mean
  const means = [paint.scalp ?? mean, paint.beard ?? paint.scalp ?? mean].map((m) => Math.max(1e-4, m));
  const shapes = means.map(detailShape);
  const uniforms = {
    uHairColour: { value: new THREE.Color(1, 1, 1) },
    uHairOn: { value: 0 },
    uHairMean: { value: mean },
    uHairPower: { value: shape.power },
    uHairFloor: { value: shape.floor },
    uPaintMean: { value: new THREE.Vector2(means[0], means[1]) },
    uPaintPower: { value: new THREE.Vector2(shapes[0].power, shapes[1].power) },
    uPaintFloor: { value: new THREE.Vector2(shapes[0].floor, shapes[1].floor) },
    uHairEyes: { value: new THREE.Vector2(skin.eyes[0], skin.eyes[1]) },
    uHatOn: { value: 0 },
    uHatMatrix: { value: new THREE.Matrix4() },
    uHairMask: { value: mask },
  };
  // the cards: the whole material is hair (but the eyes); the head: hair where the mask says, scalp and beard each to its own tone
  const tint = mask
    ? /* glsl */ `vec2 hairW = texture2D( uHairMask, vMapUv ).rg * vHairW;
          if ( uHairOn > 0.5 && hairW.x + hairW.y > 0.01 ) {
            vec2 hairD = pow( vec2( dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ) / uPaintMean, uPaintPower );
            hairD = mix( uPaintFloor + ( 1.0 - uPaintFloor ) * hairD, 1.0 + 1.5 * ( 1.0 - exp( ( 1.0 - hairD ) / 1.5 ) ), step( 1.0, hairD ) );
            vec3 hairC = mix( diffuseColor.rgb, diffuse * min( uHairColour * hairD.x, 1.0 ), hairW.x );
            diffuseColor.rgb = mix( hairC, diffuse * min( uHairColour * hairD.y, 1.0 ), hairW.y );
          }`
    : /* glsl */ `float hairW = vHairW;
          if ( uHairOn > 0.5 && hairW > 0.01 ) {
            float hairD = pow( dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / uHairMean, uHairPower );
            hairD = mix( uHairFloor + ( 1.0 - uHairFloor ) * hairD, 1.0 + 1.5 * ( 1.0 - exp( ( 1.0 - hairD ) / 1.5 ) ), step( 1.0, hairD ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, diffuse * min( uHairColour * hairD, 1.0 ), hairW );
          }`;
  // bind-space position → the head bone's rest frame (the ellipsoid is applied on top in setHatClip)
  const toHead = new THREE.Matrix4().multiplyMatrices(skin.boneInverses[skin.head] ?? new THREE.Matrix4(), skin.bindMatrix);

  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform vec2 uHairEyes;
        uniform mat4 uHatMatrix;
        varying float vHairW;
        varying vec3 vHatPos;`,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        vHatPos = ( uHatMatrix * vec4( position, 1.0 ) ).xyz;
        vHairW = 1.0;
        #ifdef USE_SKINNING
          vec4 hairEye = vec4( equal( skinIndex, vec4( uHairEyes.x ) ) ) + vec4( equal( skinIndex, vec4( uHairEyes.y ) ) );
          vHairW = 1.0 - clamp( dot( hairEye, skinWeight ), 0.0, 1.0 );
        #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform vec3 uHairColour;
        uniform float uHairOn;
        uniform float uHairMean;
        uniform float uHairPower;
        uniform float uHairFloor;
        uniform float uHatOn;
        ${mask ? 'uniform sampler2D uHairMask;\n        uniform vec2 uPaintMean;\n        uniform vec2 uPaintPower;\n        uniform vec2 uPaintFloor;' : ''}
        varying float vHairW;
        varying vec3 vHatPos;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        /* glsl */ `#include <clipping_planes_fragment>
        // under the hat
        if ( uHatOn > 0.5 && dot( vHatPos, vHatPos ) < 1.0 ) discard;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        #ifdef USE_MAP
          ${tint}
        #endif`,
      );
  };
  material.customProgramCacheKey = function () {
    return `${previousKey.call(this)}|hair-tint${mask ? '-mask' : ''}`;
  };
  material.needsUpdate = true;

  const ellipsoid = new THREE.Matrix4();
  const handle: HairTint = {
    setTint(colour) {
      if (colour !== null) uniforms.uHairColour.value.set(colour);
      uniforms.uHairOn.value = colour === null ? 0 : 1;
    },
    setHatClip(hat) {
      uniforms.uHatOn.value = hat ? 1 : 0;
      if (!hat) return;
      // head space → the unit sphere: undo the centre, then the radii
      ellipsoid.makeScale(1 / hat.radii[0], 1 / hat.radii[1], 1 / hat.radii[2]).multiply(new THREE.Matrix4().makeTranslation(-hat.centre[0], -hat.centre[1], -hat.centre[2]));
      uniforms.uHatMatrix.value.multiplyMatrices(ellipsoid, toHead);
    },
  };
  handles.set(material, handle);
  return handle;
}
