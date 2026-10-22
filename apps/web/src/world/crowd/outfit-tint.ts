// Dyes a Rocketbox (or MakeHuman) avatar's clothes: the body material samples the GLB's
// `outfitMask` (R top, G bottom, B shoes, A trim, in the body's UV space; scripts/people/masks.mjs
// makes it) and, where a region is dyed, swaps the fabric's colour for the tint while keeping its
// own shading and weave. Skin, hair, faces, prints, logos, belts and soles are outside the mask, so
// they keep their colours.
//
// The dye is the tint times the texel's luminance over the region's mean luminance (from
// AvatarSpec.outfit), all in linear light. A fold that is half as bright as the fabric's average
// comes out half as bright as the tint, so a black suit dyed red reads as red cloth with its folds,
// not as a flat red decal; detail brighter than the mean rolls off towards 2.5× so a dark fabric's
// baked highlights don't blow out once it's light. A near-black fabric's texture is only a few
// code values deep, so its ratios exaggerate (one code is 13% at the bottom of the range) and its
// painted-in creases would turn into stains on a light dye: the darker the fabric, the more its
// shadows are lifted towards the mean (see detailShape).
//
// The mask is bilinear and its edges are ramps (it's averaged down from a finer analysis), shaped by
// a smoothstep, so a dyed sleeve meets the skin with a soft line rather than a stair-step.
//
//   const mask = takeOutfitMask(bodyMaterial);           // once per loaded avatar
//   const tint = tintOutfit(myClone, mask, spec.outfit.regions);
//   tint.setTint('top', '#c0202a');                      // null puts the region's own colour back
//   tint.setNight(1);                                    // hi-vis trim shines back in headlights
//
// Material.clone() doesn't copy onBeforeCompile, so call tintOutfit on every clone that should be
// dyed (they share one compiled program; only the uniforms are per material).

import * as THREE from 'three';
import type { AvatarSpec, OutfitRegion } from './people-manifest';

export type OutfitRegions = NonNullable<AvatarSpec['outfit']>['regions'];

export interface OutfitTint {
  /** Dyes a region ('#rrggbb' or any three.js colour), or gives it back its own colour (null). */
  setTint(region: OutfitRegion, colour: THREE.ColorRepresentation | null): void;
  /** How brightly the reflective trim (if the outfit has one) shines back: 0 by day, about 1 at night. */
  setNight(k: number): void;
  /** Whether the outfit has that region at all (a customiser greys out pickers for the ones it lacks). */
  has(region: OutfitRegion): boolean;
  /** The region's own colour, '#rrggbb', as masks.mjs measured it (for a picker's "original" swatch). */
  own(region: OutfitRegion): string | null;
}

const ORDER: OutfitRegion[] = ['top', 'bottom', 'shoes', 'trim'];

/**
 * How much of a fabric's own contrast the dye keeps, by the fabric's mean luminance: the ratio to
 * the mean is raised to `power`, then below 1 lifted to `floor` + (1 − floor) × ratio. Full
 * contrast from a mean of 0.03 (a mid grey-blue denim) up; a near-black suit (0.003 and under)
 * keeps a power of 0.6 and a floor of 0.4, so its folds still show in red without its painted-in
 * creases turning into stains in beige. (masks.mjs's CPU preview uses the same numbers.)
 */
export function detailShape(mean: number): { power: number; floor: number } {
  const t = THREE.MathUtils.clamp(Math.log10(mean / 0.003), 0, 1);
  return { power: 0.6 + 0.4 * t, floor: 0.4 * (1 - t) };
}

/**
 * The outfit mask GLTFLoader put in a body material's occlusion slot (masks.mjs parks it there,
 * at strength 0, so asset tools keep it). Takes it off, so three doesn't sample it as ambient
 * occlusion, and returns it; later calls on the same material return it again. Null when the
 * material has none.
 */
export function takeOutfitMask(material: THREE.MeshStandardMaterial): THREE.Texture | null {
  const kept = taken.get(material);
  if (kept) return kept;
  const ao = material.aoMap;
  if (!ao || ao.name !== 'outfitMask') return null;
  // (glTF textures load unflipped and the mask is data, not colour: GLTFLoader already has it so)
  material.aoMap = null;
  material.aoMapIntensity = 1;
  material.needsUpdate = true;
  taken.set(material, ao);
  return ao;
}
const taken = new WeakMap<THREE.Material, THREE.Texture>();

/** The regions a people GLB carries in its body material's extras (the same as AvatarSpec.outfit). */
export function outfitRegionsOf(material: THREE.Material): OutfitRegions | null {
  const outfit = (material.userData as { outfit?: { regions?: OutfitRegions } }).outfit;
  return outfit?.regions && Object.keys(outfit.regions).length ? outfit.regions : null;
}

const handles = new WeakMap<THREE.Material, OutfitTint>();

/**
 * Patches a body material to dye its outfit. The material needs its colour map (the mask is read
 * with the map's UVs). Calling it again on the same material returns the same handle. Works with
 * skinning, instancing and any onBeforeCompile already on the material (it runs first).
 */
export function tintOutfit(material: THREE.MeshStandardMaterial, mask: THREE.Texture, regions: OutfitRegions): OutfitTint {
  const existing = handles.get(material);
  if (existing) return existing;

  const colours = ORDER.map(() => new THREE.Color(1, 1, 1));
  const on = new THREE.Vector4(0, 0, 0, 0);
  // (a region the outfit lacks gets a mean of 1, never 0: its weight is 0, but 0 × ∞ is still NaN)
  const mean = new THREE.Vector4(...(ORDER.map((r) => Math.max(1e-4, regions[r]?.mean ?? 1)) as [number, number, number, number]));
  const power = new THREE.Vector4();
  const floor = new THREE.Vector4();
  for (let i = 0; i < 4; i++) {
    const shape = detailShape(mean.getComponent(i));
    power.setComponent(i, shape.power);
    floor.setComponent(i, shape.floor);
  }
  const uniforms = {
    uOutfitMask: { value: mask },
    uOutfitColour: { value: colours },
    uOutfitOn: { value: on },
    uOutfitMean: { value: mean },
    uOutfitPower: { value: power },
    uOutfitFloor: { value: floor },
    uOutfitNight: { value: 0 },
  };

  const previous = material.onBeforeCompile;
  const previousKey = material.customProgramCacheKey;
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        uniform sampler2D uOutfitMask;
        uniform vec3 uOutfitColour[ 4 ];
        uniform vec4 uOutfitOn;
        uniform vec4 uOutfitMean;
        uniform vec4 uOutfitPower;
        uniform vec4 uOutfitFloor;
        uniform float uOutfitNight;`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        vec4 outfitW = vec4( 0.0 );
        #ifdef USE_MAP
          outfitW = smoothstep( 0.1, 0.9, texture2D( uOutfitMask, vMapUv ) );
          vec4 outfitDye = outfitW * uOutfitOn;
          if ( outfitDye.x + outfitDye.y + outfitDye.z + outfitDye.w > 0.0 ) {
            // the fabric's own light and shade, as a ratio to its region's mean
            vec4 outfitD = pow( dot( sampledDiffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) / uOutfitMean, uOutfitPower );
            outfitD = mix( uOutfitFloor + ( 1.0 - uOutfitFloor ) * outfitD, 1.0 + 1.5 * ( 1.0 - exp( ( 1.0 - outfitD ) / 1.5 ) ), step( 1.0, outfitD ) );
            vec3 outfitC = diffuseColor.rgb;
            outfitC = mix( outfitC, diffuse * min( uOutfitColour[ 0 ] * outfitD.x, 1.0 ), outfitDye.x );
            outfitC = mix( outfitC, diffuse * min( uOutfitColour[ 1 ] * outfitD.y, 1.0 ), outfitDye.y );
            outfitC = mix( outfitC, diffuse * min( uOutfitColour[ 2 ] * outfitD.z, 1.0 ), outfitDye.z );
            outfitC = mix( outfitC, diffuse * min( uOutfitColour[ 3 ] * outfitD.w, 1.0 ), outfitDye.w );
            diffuseColor.rgb = outfitC;
          }
        #endif`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
        // retroreflective tape sends headlights and torches straight back: at night it glows its own colour
        totalEmissiveRadiance += diffuseColor.rgb * outfitW.w * uOutfitNight;`,
      );
  };
  material.customProgramCacheKey = function () {
    return `${previousKey.call(this)}|outfit-tint`;
  };
  material.needsUpdate = true;

  const handle: OutfitTint = {
    setTint(region, colour) {
      const i = ORDER.indexOf(region);
      if (i < 0) return;
      const live = colour !== null && regions[region] !== undefined;
      if (live) colours[i].set(colour);
      on.setComponent(i, live ? 1 : 0);
    },
    setNight(k) {
      uniforms.uOutfitNight.value = regions.trim ? Math.max(0, k) : 0;
    },
    has: (region) => regions[region] !== undefined,
    own: (region) => regions[region]?.colour ?? null,
  };
  handles.set(material, handle);
  return handle;
}

/**
 * For a body material straight from a people GLB: its mask and regions from the file, patched.
 * Null when the avatar has no outfit mask (nothing to dye).
 */
export function tintLoadedOutfit(material: THREE.MeshStandardMaterial, regions = outfitRegionsOf(material)): OutfitTint | null {
  const mask = takeOutfitMask(material);
  if (!mask || !regions) return null;
  return tintOutfit(material, mask, regions);
}
