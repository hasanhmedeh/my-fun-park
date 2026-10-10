import * as THREE from 'three';
import type { Ctx } from './context';
import { boreAxis, TUNNEL_BORE } from './attractions/track';
import { FALCON_TRACK, nearTrack } from './rides';
import { withFogSun } from './fog';
import { LAYOUT, onParkGround, WHEEL_LAWN } from './layout';
import { mulberry } from './random';
import { hdr, PALETTE, signMaterial, signTexture } from './textures';

// Terrain window (outside the park, north-east): x, z bounds and grid spacing in metres. Its east
// edge follows the Sky Falcon, wherever the layout puts its station (its design had it at x = 70).
const X0 = -110;
const X1 = 340 + Math.max(0, LAYOUT.falcon.x - 70);
const Z0 = -950;
const Z1 = -96;
const STEP = 2.5;
const NX = Math.round((X1 - X0) / STEP);
const NZ = Math.round((Z1 - Z0) / STEP);

/** The lawn around the road to the giant wheel (with a margin): kept exactly level with the park. */
const lawnZone = (x: number, z: number) => Math.abs(x) < WHEEL_LAWN.half + 3 && z > WHEEL_LAWN.z0 - 3;

/**
 * A tunnel portal, in metres relative to the riders' heartline: an opening (an arch of radius R
 * centred at cy over a slot reaching down to `bottom`, or lower if the track needs it) in a
 * facade `half` wide either side, from `base` up to `top`, running `depth` back into the hill,
 * then (optionally) a block with a plain hole for the bore, running on to `block`.
 */
interface PortalSpec {
  R: number;
  cy: number;
  slot: number;
  bottom: number;
  half: number;
  base: number;
  top: number;
  depth: number;
  block?: number;
  sunburst: boolean;
}
/** Where the steeply diving track crosses the facade, the bore needs a tall keyhole; it only stays
 *  a keyhole through a shallow facade, so a block behind takes the rest of the depth. */
const ENTRY: PortalSpec = { R: 3.1, cy: 2.2, slot: 1.9, bottom: -3.6, half: 13, base: -18, top: 15, depth: 2.4, block: 7.5, sunburst: true };
/** The level exit only needs an arch over the bore, in a headwall a little higher than the hill. */
const EXIT: PortalSpec = { R: 3.3, cy: 0.1, slot: 3.3, bottom: -3.6, half: 11, base: -16, top: 7, depth: 7.5, sunburst: false };
/** Rock is cut away this far outside the bore's shell (so none can show inside it). */
const BORE_MARGIN = 0.12;
/**
 * Behind each portal the hill only starts MOUTH_DEPTH back from the facade, across a mouth either
 * side of the track. A heightfield climbs over a whole grid cell (up to 3.54 m on the diagonal),
 * so this keeps the climb from standing in front of the opening; the facades, deeper than
 * MOUTH_DEPTH plus a cell, hide where it happens instead. At the entry the mouth just clears the
 * keyhole (the hill either side holds the tall facade up); at the exit it spans the whole
 * headwall, which then stands at the end of the ridge rather than behind rock wedges.
 */
const MOUTH_DEPTH = 3.6;
/** …and the hill rises back to full height over this far (still within the facades). */
const MOUTH_FADE = 3.8;
const ENTRY_MOUTH = 7;
const EXIT_MOUTH = EXIT.half + 3.6;

/** Smooth value noise (deterministic). */
function makeNoise(seed: number) {
  const rnd = mulberry(seed);
  const N = 256;
  const g = Float32Array.from({ length: N * N }, rnd);
  const at = (i: number, j: number) => g[(((j % N) + N) % N) * N + (((i % N) + N) % N)];
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * sx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/**
 * The escarpment the Sky Falcon climbs and dives off: a table mountain (mesa) with a sheer
 * sandstone wall right behind the drop, and a ramp-like spur carrying the launch up the cliff. The
 * heightfield is derived from the track, so the climb and plateau rest on the rock, the drop
 * plunges out in front of the cliff face, and all other track is guaranteed to clear it.
 */
export class Mountain {
  private heights: Float32Array;
  /** Where the track enters the tunnel, and the direction of the drop (for the portal facade). */
  portal!: { index: number; along: THREE.Vector2 };
  /** Where the track leaves the tunnel, and the direction it is heading. */
  exit!: { index: number; along: THREE.Vector2 };
  /** The portal facades' planes, each facing into the tunnel: the bore runs between them. */
  tunnelPlanes!: THREE.Plane[];
  /** The bore's axis, every few metres from portal to portal. */
  private bore: THREE.Vector3[] = [];

  constructor(ctx: Ctx) {
    const d = FALCON_TRACK;
    const n = d.pos.length;
    const firstLift = d.zone.indexOf('launch'); // the cliff launch: where the rock begins
    const edgeIdx = d.zone.lastIndexOf('brake', d.zone.indexOf('boost')); // end of the plateau trim brakes
    const lastMountain = d.zone.indexOf('boost');
    const rail = (i: number) => d.pos[i].y - d.up[i].y;

    // the cliff edge: a plane through the edge point, facing the direction of the drop
    const edgeP = d.pos[edgeIdx].clone();
    const dropDir = new THREE.Vector2(d.tan[edgeIdx].x, d.tan[edgeIdx].z).normalize();
    const top = rail(edgeIdx);

    // plateau samples define the mesa's centre; climb samples form the spur
    const plateau: THREE.Vector2[] = [];
    const climb: { x: number; z: number; h: number }[] = [];
    for (let i = firstLift; i <= edgeIdx; i += 6) {
      const r = rail(i);
      if (r > top - 3) plateau.push(new THREE.Vector2(d.pos[i].x, d.pos[i].z));
      climb.push({ x: d.pos[i].x, z: d.pos[i].z, h: r - 1.3 });
    }
    const mesaC = plateau.reduce((a, b) => a.add(b), new THREE.Vector2()).divideScalar(plateau.length);
    // the drop pulls out ~35 m up, inside a tunnel: bury the tunnel in a rocky buttress at the
    // foot of the cliff, then carry the track down to the desert floor on an earth embankment
    const tunnelStart = d.zone.indexOf('tunnel');
    const tunnelEnd = d.zone.lastIndexOf('tunnel');
    let fillEnd = tunnelEnd;
    // …down to the bottom of the run-out (the track climbs away on its own supports after that)
    while (fillEnd < n - 1 && rail(fillEnd + 1) > 1.2 && rail(fillEnd + 1) <= rail(fillEnd) + 0.02) fillEnd++;
    const mound: { x: number; z: number; h: number }[] = [];
    for (let i = tunnelStart; i <= tunnelEnd; i += 4) mound.push({ x: d.pos[i].x, z: d.pos[i].z, h: rail(i) + 6.5 });
    const fill: { x: number; z: number; h: number }[] = [];
    for (let i = tunnelEnd + 1; i <= fillEnd; i += 4) fill.push({ x: d.pos[i].x, z: d.pos[i].z, h: rail(i) - 1.3 });
    const ridges = climb.concat(fill);
    // the drop: the train tips over the lip and falls clear of a sheer wall (nothing but air in
    // front of the riders), then pulls out along the crest of a rock buttress standing at the
    // foot of the cliff, straight into the portal
    const along = (x: number, z: number) => (x - edgeP.x) * dropDir.x + (z - edgeP.z) * dropDir.y;
    const across = (x: number, z: number) => (x - edgeP.x) * -dropDir.y + (z - edgeP.z) * dropDir.x;
    const portal = d.pos[tunnelStart];
    const portalA = along(portal.x, portal.z);
    const railAt = (i: number) => ({ x: d.pos[i].x - d.up[i].x, z: d.pos[i].z - d.up[i].z, h: rail(i) });
    // the lip: where the rails have dipped a little below the plateau
    let lip = edgeIdx;
    while (lip < tunnelStart && rail(lip) > top - 2.5) lip++;
    const lipA = along(railAt(lip).x, railAt(lip).z);
    // the foot of the vertical, where the pull-out (and the buttress under it) begins
    let foot = tunnelStart;
    while (foot > edgeIdx && d.tan[foot].y > -0.999) foot--;
    // (along the steep pull-out only a hair's width is cut, or the lower rails ahead would
    // trench the rock out from under the higher ones)
    const channel: { x: number; z: number; h: number; r: number }[] = [];
    for (let i = edgeIdx + 1; i <= tunnelStart; i += 2) {
      const r = railAt(i);
      channel.push({ x: r.x, z: r.z, h: r.h - 2.2, r: i < foot ? 3.4 : 0.5 });
    }
    // (it runs on through the entry facade, so the rock under the track doesn't fall away into
    // the mouth behind it: inside the bore the shader cuts it away, and the facade hides the rest)
    const spine: { x: number; z: number; h: number; a: number }[] = [];
    for (let i = foot; i < n; i += 2) {
      const r = railAt(i);
      const ra = along(r.x, r.z);
      if (ra > portalA + (ENTRY.block ?? ENTRY.depth)) break;
      spine.push({ x: r.x, z: r.z, h: r.h - 1.5, a: ra });
    }
    // the exit: a plane across the track where it leaves the hill (the hill ends in a rock face
    // there, behind a second portal, rather than slumping down over the end of the tunnel)
    const exitP = d.pos[tunnelEnd];
    const exitDir = new THREE.Vector2(d.tan[tunnelEnd].x, d.tan[tunnelEnd].z).normalize();
    const pastExit = (x: number, z: number) => (x - exitP.x) * exitDir.x + (z - exitP.z) * exitDir.y;
    this.portal = { index: tunnelStart, along: dropDir.clone() };
    this.exit = { index: tunnelEnd, along: exitDir.clone() };
    // The bore runs from facade to facade, and no rock may stand inside it. The terrain is a
    // heightfield, so where the hill closes over the bore (just behind each facade) its surface
    // has to pass through it: the shader cuts that part away, and the facades hide the rest.
    this.tunnelPlanes = [
      new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(dropDir.x, 0, dropDir.y), portal),
      new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(-exitDir.x, 0, -exitDir.y), exitP),
    ];
    for (let i = tunnelStart; i < tunnelEnd; i += 12) this.bore.push(boreAxis(d, i));
    this.bore.push(boreAxis(d, tunnelEnd));
    // everything after the edge (and before the climb) must clear the rock
    const clear: { x: number; z: number; h: number }[] = [];
    for (let i = 0; i < n; i += 3) {
      if (i >= firstLift && i <= edgeIdx) continue;
      if (i >= edgeIdx && i <= fillEnd) continue; // the drop, tunnel and embankment shape their own rock
      const p = d.pos[i];
      if (p.x < X0 - 10 || p.x > X1 + 10 || p.z < Z0 - 10 || p.z > Z1 + 10) continue;
      clear.push({ x: p.x, z: p.z, h: rail(i) - (i < lastMountain && i > edgeIdx ? 2.5 : 3) });
    }

    const noise = makeNoise(17);
    const noise2 = makeNoise(29);
    this.heights = new Float32Array((NX + 1) * (NZ + 1));
    for (let j = 0; j <= NZ; j++)
      for (let i = 0; i <= NX; i++) {
        const x = X0 + i * STEP;
        const z = Z0 + j * STEP;
        // under the park's ground / under the lawn by the road to the giant wheel / desert floor
        const base = onParkGround(x, z, 1) ? -2 : lawnZone(x, z) ? 0 : 0.08;
        // ---- mesa: flat top, steep flanks, a sheer wall along the edge plane ----
        const wob = (noise(x * 0.012, z * 0.012) - 0.5) * 70;
        const dc = Math.hypot(x - mesaC.x, z - mesaC.y) + wob;
        // around the drop the wall is sheer and starts right at the lip, so the vertical hangs
        // clear of it
        const sheer = 1 - THREE.MathUtils.smoothstep(Math.abs(across(x, z)), 45, 80);
        const jut = lipA * sheer;
        const planeDist = along(x, z) - jut + (noise2(x * 0.03, z * 0.03) - 0.5) * (10 - 9 * sheer);
        let mesa = top - 1.3 - 2.4 * Math.max(0, dc - jut - 150);
        mesa = Math.min(mesa, top - 1.3 - (4.5 + 17.5 * sheer) * Math.max(0, planeDist));
        // talus apron at the foot of the walls
        const apron = top * 0.22 * (1 - THREE.MathUtils.smoothstep(Math.max(dc - 150, planeDist), 0, 90));
        let h = Math.max(base, mesa, apron);
        // ---- the spur under the launch climb, and the embankment after the tunnel ----
        // (the spur and plateau stop dead at the wall above the drop, rather than bulging past it)
        const pastWall = 17.5 * sheer * Math.max(0, planeDist);
        for (let k = 0; k < ridges.length; k++) {
          const c = ridges[k];
          const dd = Math.hypot(x - c.x, z - c.z);
          // a knife-edge ridge whose flanks wobble, so it reads as rock rather than a ramp
          const flank = 1.7 + (noise(c.x * 0.05 + x * 0.02, c.z * 0.05 + z * 0.02) - 0.5) * 1.2;
          if (dd < 120) h = Math.max(h, c.h - flank * Math.max(0, dd - 5) - (k < climb.length ? pastWall : 0));
        }
        // ---- erosion: gullies and ledges, strongest on high ground ----
        if (h > 3) {
          const ridge = Math.abs(noise2(x * 0.04, z * 0.04) * 2 - 1);
          h -= ridge * Math.min(14, h * 0.1);
          h += (noise(x * 0.15, z * 0.15) - 0.5) * 1.6;
        }
        // ---- the buttress around the tunnel (after erosion, so its roof stays whole) ----
        const a = along(x, z);
        // (none at all in the mouths behind the portals, rising back to full height a few metres
        // further out: a square-cut notch would leave spikes of rock at its corners)
        const off = Math.abs(across(x, z));
        const inEntry = (1 - THREE.MathUtils.smoothstep(off, ENTRY_MOUTH, ENTRY_MOUTH + MOUTH_FADE)) * (1 - THREE.MathUtils.smoothstep(a - portalA, MOUTH_DEPTH, MOUTH_DEPTH + MOUTH_FADE));
        const inExit = (1 - THREE.MathUtils.smoothstep(off, EXIT_MOUTH, EXIT_MOUTH + MOUTH_FADE)) * (1 - THREE.MathUtils.smoothstep(-pastExit(x, z), MOUTH_DEPTH, MOUTH_DEPTH + MOUTH_FADE));
        const mouthCut = 60 * Math.max(inEntry, inExit);
        if (a > portalA - 0.5 && mouthCut < 59.9)
          for (const c of mound) {
            const dd = Math.hypot(x - c.x, z - c.z);
            if (dd < 60) h = Math.max(h, c.h - Math.max(0, dd - 7) * 1.3 - Math.max(0, pastExit(x, z)) * 4 - mouthCut);
          }
        // ---- the buttress under the pull-out, running back to the foot of the wall ----
        // (it falls away gently to the sides and behind, but steeply ahead, where the rails dive)
        const ac = across(x, z);
        const spineFlank = 1.4 + (noise(x * 0.08, z * 0.08) - 0.5) * 0.8;
        for (const c of spine) {
          const ahead = a - c.a;
          const side = Math.hypot(ac, Math.min(0, ahead));
          if (side < 70) h = Math.max(h, c.h - Math.max(0, side - 3) * spineFlank - Math.max(0, ahead) * 20);
        }
        // ---- a notch through the lip and a clear path down to the portal ----
        if (a < portalA + 0.5)
          for (const c of channel) {
            const dd = Math.hypot(x - c.x, z - c.z);
            if (dd < 20) h = Math.min(h, c.h + Math.max(0, dd - c.r) * 14);
          }
        // ---- a solid track bed along the embankment ----
        for (const c of fill) {
          const dd = Math.hypot(x - c.x, z - c.z);
          if (dd < 8) h = Math.max(h, c.h - Math.max(0, dd - 3) * 1.1);
        }
        // ---- the ride always wins: climb/plateau sit in a shallow cutting, the rest clears ----
        // (the embankment's cutting stops at the exit face, so it never eats into the hill over
        // the end of the tunnel)
        const behindExit = pastExit(x, z) < 0;
        for (let k = 0; k < ridges.length; k++) {
          const c = ridges[k];
          if (behindExit && k >= climb.length) continue;
          const dd = Math.hypot(x - c.x, z - c.z);
          if (dd < 30) h = Math.min(h, c.h + Math.max(0, dd - 2.6) * 1.6);
        }
        for (const c of clear) {
          const dd = Math.hypot(x - c.x, z - c.z);
          if (dd < 26) h = Math.min(h, c.h + Math.max(0, dd - 3.5) * 1.5);
        }
        // fade into the desert floor at the window's edges
        const edge = Math.min(x - X0, X1 - x, z - Z0, Z1 - z);
        h = base + (h - base) * THREE.MathUtils.smoothstep(edge, 0, 30);
        // (under the park's ground it stays out of sight: the talus apron alone would lift it level with the lawn)
        this.heights[j * (NX + 1) + i] = base < 0 ? base : Math.max(-2, h);
      }
    this.carveClearance();

    // ---- mesh: strata are painted in the shader from world height (crisp on sheer walls) ----
    const geo = new THREE.PlaneGeometry(X1 - X0, Z1 - Z0, NX, NZ);
    geo.rotateX(-Math.PI / 2);
    geo.translate((X0 + X1) / 2, 0, (Z0 + Z1) / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    // after rotateX(-90°) the plane's rows run from z = Z0 to Z1, matching the heightfield layout
    for (let v = 0; v < pos.count; v++) pos.setY(v, this.heights[v]);
    geo.computeVertexNormals();
    // per-vertex blend weights: r = desert sand, g = green (park side), b = speckle
    const w: number[] = [];
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const dcM = Math.hypot(x - mesaC.x, z - mesaC.y);
      const edge = Math.min(x - X0, X1 - x, z - Z0, Z1 - z);
      // desert around the mesa, fading back to grassland toward the park and the window edges
      const green = Math.max(THREE.MathUtils.smoothstep(dcM, 200, 290), 1 - THREE.MathUtils.smoothstep(edge, 0, 40));
      w.push(1, green, noise2(x * 0.35, z * 0.35));
    }
    geo.setAttribute('aW', new THREE.Float32BufferAttribute(w, 3));
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, color: '#ffffff' });
    mat.onBeforeCompile = (shader) => {
      withFogSun(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aW;\nvarying vec3 vW;\nvarying vec3 vWorld;\nvarying vec3 vWN;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvW = aW;\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);',
        );
      const r = TUNNEL_BORE.radius + BORE_MARGIN;
      const box = new THREE.Box3().setFromPoints(this.bore).expandByScalar(r);
      const [pIn, pOut] = this.tunnelPlanes;
      Object.assign(shader.uniforms, {
        uBore: { value: this.bore },
        uBoreR: { value: r },
        uBoreIn: { value: new THREE.Vector4(pIn.normal.x, pIn.normal.y, pIn.normal.z, pIn.constant) },
        uBoreOut: { value: new THREE.Vector4(pOut.normal.x, pOut.normal.y, pOut.normal.z, pOut.constant) },
        uBoreMin: { value: box.min },
        uBoreMax: { value: box.max },
      });
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vW;
          varying vec3 vWorld;
          varying vec3 vWN;
          #define BORE_N ${this.bore.length}
          uniform vec3 uBore[BORE_N];
          uniform float uBoreR;
          uniform vec4 uBoreIn;
          uniform vec4 uBoreOut;
          uniform vec3 uBoreMin;
          uniform vec3 uBoreMax;`,
        )
        .replace(
          '#include <clipping_planes_fragment>',
          /* glsl */ `#include <clipping_planes_fragment>
          // the tunnel bore, between the two portal facades: no rock inside it
          if (all(greaterThan(vWorld, uBoreMin)) && all(lessThan(vWorld, uBoreMax)) &&
              dot(uBoreIn.xyz, vWorld) + uBoreIn.w > 0.0 && dot(uBoreOut.xyz, vWorld) + uBoreOut.w > 0.0) {
            float d2 = 1e9;
            for (int k = 0; k < BORE_N - 1; k++) {
              vec3 ab = uBore[k + 1] - uBore[k];
              vec3 ap = vWorld - uBore[k];
              vec3 q = ap - ab * clamp(dot(ap, ab) / dot(ab, ab), 0.0, 1.0);
              d2 = min(d2, dot(q, q));
            }
            if (d2 < uBoreR * uBoreR) discard;
          }`,
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
          {
            vec3 bands[6];
            bands[0] = vec3(0.79, 0.53, 0.31);
            bands[1] = vec3(0.85, 0.64, 0.42);
            bands[2] = vec3(0.72, 0.44, 0.25);
            bands[3] = vec3(0.89, 0.71, 0.49);
            bands[4] = vec3(0.66, 0.38, 0.23);
            bands[5] = vec3(0.82, 0.58, 0.35);
            float y = vWorld.y + sin(vWorld.x * 0.045) * 2.2 + sin(vWorld.z * 0.038 + 1.3) * 2.2;
            float layer = y / 6.5;
            float f = fract(layer);
            int i0 = int(mod(floor(layer), 6.0));
            int i1 = int(mod(floor(layer) + 1.0, 6.0));
            vec3 strata = mix(bands[i0], bands[i1], smoothstep(0.82, 1.0, f));
            strata *= 1.0 - 0.18 * smoothstep(0.93, 1.0, f); // thin dark bedding lines
            float flat_ = smoothstep(0.82, 0.96, vWN.y);
            vec3 sand = vec3(0.89, 0.75, 0.55);
            vec3 col = mix(strata, sand, flat_ * 0.8);
            col = mix(col, vec3(0.36, 0.48, 0.27), vW.g * 0.85);
            col *= 0.9 + vW.b * 0.2;
            diffuseColor.rgb = col;
          }`,
        );
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    ctx.scene.add(mesh);
    this.buildPortal(ctx, this.portal.index, new THREE.Vector2(-this.portal.along.x, -this.portal.along.y), ENTRY);
    this.buildPortal(ctx, this.exit.index, this.exit.along, EXIT);

    // giant sign on the plateau, beside the edge, facing the park
    // on the plateau, set back from the rim, somewhere no track passes within 55 m
    let sx = edgeP.x - dropDir.x * 70;
    let sz = edgeP.z - dropDir.y * 70;
    search: for (let r = 55; r <= 200; r += 10)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const cx = edgeP.x + Math.cos(a) * r;
        const cz = edgeP.z + Math.sin(a) * r;
        if (!nearTrack(cx, cz, 55, Infinity, 'falcon') && this.sample(cx, cz) > top - 12) {
          sx = cx;
          sz = cz;
          break search;
        }
      }
    const sign = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(64, 16),
      signMaterial(signTexture('SKY FALCON', { sub: '4.25 km · 158 m drop at 90° · 250 km/h · ride it from Falcon Gate', border: PALETTE.mustard, width: 1536, height: 384 }), {
        emissiveIntensity: 2.4,
      }),
    );
    const back = new THREE.Mesh(new THREE.BoxGeometry(65, 17, 0.8), new THREE.MeshStandardMaterial({ color: '#3a2f4a', roughness: 0.6 }));
    back.position.z = -0.45;
    sign.add(board, back);
    for (const lx of [-24, 0, 24]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 22, 1.2), new THREE.MeshStandardMaterial({ color: '#3a2f4a', metalness: 0.5, roughness: 0.5 }));
      leg.position.set(lx, -14, -1);
      sign.add(leg);
    }
    sign.position.set(sx, this.sample(sx, sz) + 22, sz);
    sign.lookAt(sx + dropDir.x * 100, sign.position.y, sz + dropDir.y * 100);
    ctx.scene.add(sign);
    // aircraft warning beacon on the rim
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 10), new THREE.MeshBasicMaterial({ color: hdr('#ff3b3b', 10) }));
    beacon.position.set(edgeP.x + 18, top + 16, edgeP.z - 12);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 16), new THREE.MeshStandardMaterial({ color: '#3a2f4a' }));
    mast.position.set(edgeP.x + 18, top + 8, edgeP.z - 12);
    ctx.scene.add(beacon, mast);
  }

  /**
   * Lowers any terrain vertex the train could touch: every corner of the grid cell under each
   * point of the train's envelope (track beam to riders' heads, car shell wide) is capped just
   * below it, so the mesh triangle there lies below too. Inside the tunnel bore the shader cuts
   * the rock away instead; everywhere else this guarantees clearance, whatever the shaping above.
   */
  private carveClearance() {
    const d = FALCON_TRACK;
    const W = NX + 1;
    const p = new THREE.Vector3();
    for (let i = 0; i < d.pos.length; i++) {
      if (d.zone[i] === 'tunnel') continue;
      for (const s of [-0.8, -0.4, 0, 0.4, 0.8])
        for (const u of [-1.55, -0.8, 0, 0.7]) {
          p.copy(d.pos[i]).addScaledVector(d.right[i], s).addScaledVector(d.up[i], u);
          if (this.inBore(p)) continue; // (the shader cuts the rock away there)
          const ci = Math.floor((p.x - X0) / STEP);
          const cj = Math.floor((p.z - Z0) / STEP);
          if (ci < 0 || cj < 0 || ci >= NX || cj >= NZ) continue;
          const cap = p.y - 0.35;
          for (const k of [cj * W + ci, cj * W + ci + 1, (cj + 1) * W + ci, (cj + 1) * W + ci + 1])
            if (this.heights[k] > cap) this.heights[k] = cap;
        }
    }
  }

  /**
   * A tunnel portal, after the real ride's: a sandstone facade standing across the track, its
   * opening framed in bronze. The entry (in the buttress at the foot of the drop) has a keyhole
   * opening sized to the bore where the steeply diving track crosses the vertical facade, and a
   * sunburst of rods; the exit is a plain arch over the level track. The facade faces `facing`
   * and runs `depth` metres back into the hill; behind a shallow facade, a block runs on to
   * `block` with a plain hole wherever the bore passes. Together they hide where the rock closes
   * over the bore. Everything is in metres relative to the riders' heartline.
   */
  private buildPortal(ctx: Ctx, index: number, facing: THREE.Vector2, o: PortalSpec) {
    const d = FALCON_TRACK;
    const P = d.pos[index];
    const zAxis = new THREE.Vector3(facing.x, 0, facing.y).normalize();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const xAxis = new THREE.Vector3().crossVectors(yAxis, zAxis);
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    g.matrix.makeBasis(xAxis, yAxis, zAxis).setPosition(P);
    const toLocal = g.matrix.clone().invert();
    const BEVEL = 0.25;

    // the track (and the tube around it) in the facade's frame, for every sample within `from`…`to`
    // metres behind its face (searching both ways from the portal: the exit's track runs out of it)
    const inside = (from: number, to: number, visit: (i: number, q: THREE.Vector3) => void) => {
      const q = new THREE.Vector3();
      for (const step of [1, -1])
        for (let i = index; i >= 0 && i < d.pos.length; i += step) {
          const z = -q.copy(d.pos[i]).applyMatrix4(toLocal).z;
          if (z < from - 6 || z > to + 6) break;
          if (z >= from && z <= to) visit(i, q);
        }
    };

    // the bore's outline in the facade's frame, over the part of it `from`…`to` metres behind the
    // face (where the track dives, each ring of the tube leans, so look a radius either side)
    const boreOutline = (from: number, to: number, box: THREE.Box2) => {
      const ring = new THREE.Vector3();
      const Rb = TUNNEL_BORE.radius;
      inside(from - Rb, to + Rb, (i) => {
        const c = boreAxis(d, i);
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          ring.copy(c).addScaledVector(d.right[i], Math.cos(a) * Rb).addScaledVector(d.up[i], Math.sin(a) * Rb);
          ring.applyMatrix4(toLocal);
          if (-ring.z >= from && -ring.z <= to) box.expandByPoint(new THREE.Vector2(ring.x, ring.y));
        }
      });
      return box;
    };

    // an arch of radius R over a slot (narrower for a keyhole) reaching below the rails: where the
    // track dives through, the slot reaches down below the bore's floor at the facade's back (or
    // the slot's floor would stand in the tube as a ledge)
    const { R, cy, slot, depth } = o;
    const bottom = Math.min(o.bottom, boreOutline(-BEVEL, depth + BEVEL, new THREE.Box2()).min.y - 0.3);
    const joinY = cy - Math.sqrt(R * R - slot * slot);
    const a0 = Math.atan2(joinY - cy, slot);
    const hole = new THREE.Path();
    hole.moveTo(-slot, bottom);
    hole.lineTo(slot, bottom);
    hole.lineTo(slot, joinY);
    hole.absarc(0, cy, R, a0, Math.PI - a0, false);
    hole.lineTo(-slot, bottom);
    const face = new THREE.Shape();
    face.moveTo(-o.half, o.base);
    face.lineTo(o.half, o.base);
    face.lineTo(o.half, o.top);
    face.lineTo(-o.half, o.top);
    face.closePath();
    face.holes.push(hole);
    const facadeGeo = new THREE.ExtrudeGeometry(face, { depth, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 2, curveSegments: 40 });
    facadeGeo.translate(0, 0, -depth);
    const sandstone = new THREE.MeshStandardMaterial({ color: '#c9a37a', roughness: 0.92 });
    g.add(new THREE.Mesh(facadeGeo, sandstone));

    // the block behind it: its hole takes in the opening and the whole bore as it passes through
    if (o.block) {
      // (only the bore: where the opening is wider, the tube hides the block's face anyway, and a
      // taller hole would break out of the hill behind)
      const box = boreOutline(depth - 0.5, o.block + 0.5, new THREE.Box2()).expandByScalar(0.25);
      // (the facade's sides stand a bevel proud of its outline: the block lines up with them)
      const blockFace = new THREE.Shape();
      blockFace.moveTo(-o.half - BEVEL, o.base - BEVEL);
      blockFace.lineTo(o.half + BEVEL, o.base - BEVEL);
      blockFace.lineTo(o.half + BEVEL, o.top + BEVEL);
      blockFace.lineTo(-o.half - BEVEL, o.top + BEVEL);
      blockFace.closePath();
      const bore = new THREE.Path();
      bore.moveTo(box.min.x, box.min.y);
      bore.lineTo(box.max.x, box.min.y);
      bore.lineTo(box.max.x, box.max.y);
      bore.lineTo(box.min.x, box.max.y);
      bore.closePath();
      blockFace.holes.push(bore);
      // (it starts inside the facade, so the two read as one solid)
      const blockGeo = new THREE.ExtrudeGeometry(blockFace, { depth: o.block - depth, bevelEnabled: false });
      blockGeo.translate(0, 0, -o.block);
      g.add(new THREE.Mesh(blockGeo, sandstone));
    }

    // bronze frame: the arch and the slot's edges
    const bronze = new THREE.MeshStandardMaterial({ color: '#7a5f42', metalness: 0.65, roughness: 0.45 });
    const arch = new THREE.Mesh(new THREE.TorusGeometry(R + 0.2, 0.2, 8, 48, Math.PI - 2 * a0), bronze);
    arch.rotation.z = a0;
    arch.position.set(0, cy, 0.3);
    g.add(arch);
    for (const sx of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.4, joinY - bottom, 0.4), bronze);
      edge.position.set(sx * (slot + 0.2), (joinY + bottom) / 2, 0.3);
      g.add(edge);
    }
    // sunburst: rods radiating from the arch, alternating long and short, with an outer ring
    if (o.sunburst) {
      const rodGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 6);
      const rods = new THREE.InstancedMesh(rodGeo, bronze, 32);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      let k = 0;
      for (let ang = a0 - 0.05; ang <= Math.PI - a0 + 0.06 && k < 32; ang += (Math.PI - 2 * a0 + 0.1) / 21) {
        const len = k % 2 ? 1.8 : 2.9;
        const r0 = R + 0.5;
        const mid = r0 + len / 2;
        q.setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang - Math.PI / 2);
        m.compose(new THREE.Vector3(Math.cos(ang) * mid, cy + Math.sin(ang) * mid, 0.35), q, new THREE.Vector3(1, len, 1));
        rods.setMatrixAt(k++, m);
      }
      rods.count = k;
      g.add(rods);
      const outer = new THREE.Mesh(new THREE.TorusGeometry(R + 3.5, 0.09, 6, 64, Math.PI - 2 * a0 + 0.1), bronze);
      outer.rotation.z = a0 - 0.05;
      outer.position.set(0, cy, 0.35);
      g.add(outer);
    }

    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    g.updateMatrixWorld(true);
    ctx.scene.add(g);
  }

  /** True inside the tunnel bore (the rock the shader cuts away), between the portal facades. */
  private inBore(p: THREE.Vector3) {
    if (this.tunnelPlanes.some((pl) => pl.distanceToPoint(p) <= 0)) return false;
    const r = TUNNEL_BORE.radius + BORE_MARGIN;
    const seg = new THREE.Line3();
    const q = new THREE.Vector3();
    for (let k = 0; k + 1 < this.bore.length; k++)
      if (seg.set(this.bore[k], this.bore[k + 1]).closestPointToPoint(p, true, q).distanceToSquared(p) < r * r) return true;
    return false;
  }

  /** Terrain height at (x, z); 0 outside the mountain window. */
  sample(x: number, z: number) {
    const fx = (x - X0) / STEP;
    const fz = (z - Z0) / STEP;
    if (fx < 0 || fz < 0 || fx > NX || fz > NZ) return 0;
    const i = Math.min(NX - 1, Math.floor(fx));
    const j = Math.min(NZ - 1, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const W = NX + 1;
    const h = this.heights;
    const a = h[j * W + i] + (h[j * W + i + 1] - h[j * W + i]) * u;
    const b = h[(j + 1) * W + i] + (h[(j + 1) * W + i + 1] - h[(j + 1) * W + i]) * u;
    return Math.max(0, a + (b - a) * v);
  }
}
