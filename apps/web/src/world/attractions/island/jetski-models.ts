// The Jet-Ski Race's models, as merged vertex-coloured geometry so each costs one draw call: the
// sit-down jet-ski (a lofted V hull with its spray rails, rub rail, hood, seat, bars and jet
// nozzle), its rider (helmet, life vest and wetsuit, sitting forward over the bars), the gate
// buoys, the floats on the course's edge ropes, the floating kickers and the inflatable start
// arch. Every model is built in its own local frame (nose to −z, y up, the hull's keel at y = 0).

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rampLift, type Ramp } from './jetski-course';

const C = new THREE.Color();

/** Paints every vertex of a geometry one colour (adds the colour attribute, drops the UVs). */
function paint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute('uv');
  C.set(color);
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = C.r;
    col[i * 3 + 1] = C.g;
    col[i * 3 + 2] = C.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (!geo.attributes.normal) geo.computeVertexNormals();
  return geo;
}

/** A capsule (radius r) from a to b. */
function limb(a: THREE.Vector3Like, b: THREE.Vector3Like, r: number, color: THREE.ColorRepresentation, seg = 7) {
  const va = new THREE.Vector3().copy(a);
  const vb = new THREE.Vector3().copy(b);
  const len = va.distanceTo(vb);
  const g = new THREE.CapsuleGeometry(r, Math.max(0.01, len), 3, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  const mid = va.add(vb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return paint(g, color);
}

function box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.rotateZ(rz);
  g.rotateX(rx);
  g.rotateY(ry);
  g.translate(x, y, z);
  return paint(g, color);
}

function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------------------------------------
// The jet-ski
// ------------------------------------------------------------------------------------------------

/** Hull length, from the transom (z +STERN) to the bow (z −BOW). */
const STERN = 1.55;
const BOW = 1.75;

/** The hull's shape along its length: u = 0 at the transom, 1 at the bow. */
function station(u: number) {
  const z = STERN - u * (STERN + BOW);
  // half-beam: nearly full width aft, the widest just behind the bars, a fine entry at the bow
  const b = u < 0.42 ? 0.55 + 0.06 * Math.sin((u / 0.42) * (Math.PI / 2)) : 0.03 + 0.58 * Math.pow(Math.max(0, Math.cos(((u - 0.42) / 0.58) * (Math.PI / 2))), 0.75);
  // the keel rocker: flat under the running surface, sweeping up into the bow
  const keel = u > 0.55 ? 0.5 * Math.pow((u - 0.55) / 0.45, 2.1) : 0;
  // the gunwale (deck edge) and the deck's crown: the hood bulges up ahead of the bars
  const gun = 0.5 + 0.08 * u + (u > 0.85 ? -0.12 * ((u - 0.85) / 0.15) : 0);
  const hood = u > 0.5 ? 0.24 * Math.sin(Math.min(1, (u - 0.5) / 0.4) * Math.PI * 0.85) : 0.04;
  const crown = gun + 0.08 + hood;
  return { z, b, keel, gun, crown };
}

/**
 * The hull: lofted cross-sections from the transom to the bow, in four bands that each take their
 * own colour (and hard edges between them, so the chines catch the light): the V bottom up to the
 * spray rail, the topsides, a dark rub rail, and the deck with its hood.
 */
function hullGeometry(hullCol: string, paintCol: string, trim: string) {
  const N = 22;
  type P = [number, number];
  const ring = (u: number): P[] => {
    const s = station(u);
    const b = Math.max(0.02, s.b);
    // the rocker sweeps the bottom up into the bow, but never past the deck edge: keep each line
    // under the next one up, so the bands can't cross over at the stem
    const rail = Math.min(s.keel + 0.17 + 0.1 * u, s.gun - 0.1);
    const chine = Math.min(s.keel + 0.12 + 0.1 * u, rail - 0.03);
    const k = Math.min(s.keel, chine - 0.05);
    return [
      [0, k], // keel
      [b * 0.8, chine], // the V's deadrise to the chine
      [b, rail], // spray rail
      [b * 1.02, s.gun - 0.08], // topsides
      [b * 0.97, s.gun], // rub rail
      [b * 0.62, s.crown - 0.04], // deck shoulder
      [0, s.crown], // deck centre
    ];
  };
  const bands: { from: number; to: number; color: string }[] = [
    { from: 0, to: 2, color: hullCol },
    { from: 2, to: 3, color: paintCol },
    { from: 3, to: 4, color: trim },
    { from: 4, to: 6, color: paintCol },
  ];
  const parts: THREE.BufferGeometry[] = [];
  const rings: P[][] = [];
  const zs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    rings.push(ring(u));
    zs.push(station(u).z);
  }
  for (const band of bands)
    for (const side of [1, -1]) {
      const pos: number[] = [];
      const idx: number[] = [];
      const per = band.to - band.from + 1;
      for (let i = 0; i <= N; i++)
        for (let k = band.from; k <= band.to; k++) {
          const [x, y] = rings[i][k];
          pos.push(x * side, y, zs[i]);
        }
      for (let i = 0; i < N; i++)
        for (let k = 0; k < per - 1; k++) {
          const a = i * per + k;
          const b = (i + 1) * per + k;
          if (side > 0) idx.push(a, b, a + 1, b, b + 1, a + 1);
          else idx.push(a, a + 1, b, b, a + 1, b + 1);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      parts.push(paint(g, band.color));
    }
  // the transom: a flat dark panel across the back
  const back = rings[0];
  const tpos: number[] = [];
  for (let k = 0; k < back.length - 1; k++) {
    const [x0, y0] = back[k];
    const [x1, y1] = back[k + 1];
    // wound to face aft (+z), the way it's seen
    tpos.push(0, back[0][1], STERN, x0, y0, STERN, x1, y1, STERN);
    tpos.push(0, back[0][1], STERN, -x1, y1, STERN, -x0, y0, STERN);
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(tpos, 3));
  tg.computeVertexNormals();
  parts.push(paint(tg, '#2a2d33'));
  // the bow's last sliver closed off (facing forward), so the stem doesn't show the hull's inside
  const nose = rings[N];
  const nz = zs[N];
  const npos: number[] = [];
  for (let k = 0; k < nose.length - 1; k++) {
    const [x0, y0] = nose[k];
    const [x1, y1] = nose[k + 1];
    npos.push(0, nose[0][1], nz, x1, y1, nz, x0, y0, nz);
    npos.push(0, nose[0][1], nz, -x0, y0, nz, -x1, y1, nz);
  }
  const ng = new THREE.BufferGeometry();
  ng.setAttribute('position', new THREE.Float32BufferAttribute(npos, 3));
  ng.computeVertexNormals();
  parts.push(paint(ng, paintCol));
  return parts;
}

/**
 * A sit-down racing jet-ski, nose to −z, the keel's middle at the origin: the hull in two colours,
 * the saddle, the handlebar pod and bars, the footwell mats, the jet nozzle and ride plate, the
 * sponsons and a tinted visor.
 */
export function skiGeometry(paintCol: string, accent: string) {
  const dark = '#23262c';
  const parts = hullGeometry('#f3f1ec', paintCol, dark);
  const seat = station(0.3);
  // the saddle: long, padded, two-tone
  const seatY = seat.crown + 0.09;
  parts.push(box(0.42, 0.16, 1.2, dark, 0, seatY, 0.42));
  parts.push(box(0.44, 0.05, 1.22, accent, 0, seatY - 0.07, 0.42));
  parts.push(box(0.36, 0.08, 0.22, dark, 0, seatY + 0.07, 0.95, -0.3));
  // the footwell mats either side of the saddle
  for (const sx of [-1, 1]) parts.push(box(0.2, 0.03, 1.15, '#3b3f46', sx * 0.42, seat.gun + 0.02, 0.32));
  // the hood's accent stripe and the visor ahead of the bars
  const hood = station(0.68);
  parts.push(box(0.16, 0.02, 0.9, accent, 0, hood.crown + 0.005, -0.55, -0.06));
  parts.push(box(0.5, 0.2, 0.05, '#1c2a33', 0, hood.crown + 0.06, -0.38, -0.7));
  // the handlebar pod, the bars and their grips
  const bar = station(0.55);
  parts.push(box(0.26, 0.2, 0.3, dark, 0, bar.crown + 0.12, -0.22, 0.25));
  const bars = new THREE.CylinderGeometry(0.022, 0.022, 0.78, 6).rotateZ(Math.PI / 2).translate(0, bar.crown + 0.27, -0.2);
  parts.push(paint(bars, '#9aa0a8'));
  for (const sx of [-1, 1]) parts.push(paint(new THREE.CylinderGeometry(0.032, 0.032, 0.14, 6).rotateZ(Math.PI / 2).translate(sx * 0.36, bar.crown + 0.27, -0.2), dark));
  // the jet nozzle and the ride plate under the transom, and a little sponson either side
  parts.push(paint(new THREE.CylinderGeometry(0.09, 0.11, 0.18, 10).rotateX(Math.PI / 2).translate(0, 0.24, STERN + 0.05), '#4a4f57'));
  parts.push(box(0.46, 0.03, 0.34, '#6a7079', 0, 0.03, STERN - 0.1));
  for (const sx of [-1, 1]) parts.push(box(0.04, 0.12, 0.42, dark, sx * 0.58, 0.2, 0.9));
  // the tow hook and grab handle at the back of the saddle
  parts.push(paint(new THREE.TorusGeometry(0.09, 0.018, 4, 10, Math.PI).rotateY(Math.PI / 2).translate(0, seatY + 0.06, 1.06), '#9aa0a8'));
  return merge(parts);
}

/** Where the rider sits: the saddle's middle (the rider model's origin). */
export const SADDLE = new THREE.Vector3(0, station(0.3).crown + 0.17, 0.3);

/**
 * A racer in a full-face helmet, a life vest over a wetsuit and gloves, sitting forward with their
 * hands on the bars and their feet in the footwells. The origin is the saddle (SADDLE), so the
 * model can lean and bob about it.
 */
export function riderGeometry(vest: string, helmet: string) {
  const suit = '#1f2329';
  const parts: THREE.BufferGeometry[] = [];
  const barY = station(0.55).crown + 0.27 - SADDLE.y;
  const barZ = -0.2 - SADDLE.z;
  const hip = { x: 0, y: 0.06, z: 0.05 };
  const chest = { x: 0, y: 0.5, z: -0.2 };
  // the torso and the vest over it (bulkier, with a darker collar)
  parts.push(limb(hip, chest, 0.16, suit, 8));
  parts.push(limb({ x: 0, y: 0.14, z: -0.02 }, { x: 0, y: 0.44, z: -0.17 }, 0.19, vest, 8));
  parts.push(box(0.3, 0.06, 0.22, '#2b2f36', 0, 0.55, -0.22, -0.5));
  // the head in its helmet, with the visor
  const head = new THREE.Vector3(0, 0.73, -0.3);
  parts.push(paint(new THREE.SphereGeometry(0.155, 12, 9).scale(1, 1.05, 1.12).translate(head.x, head.y, head.z), helmet));
  parts.push(paint(new THREE.SphereGeometry(0.13, 10, 6, -Math.PI * 0.35, Math.PI * 0.7, Math.PI * 0.32, Math.PI * 0.3).rotateY(Math.PI).translate(head.x, head.y + 0.01, head.z - 0.035), '#141a22'));
  parts.push(box(0.05, 0.03, 0.2, '#f4f1ea', 0, head.y + 0.15, head.z - 0.02, 0.2));
  // arms from the shoulders to the grips, elbows out a little
  for (const sx of [-1, 1]) {
    const sh = { x: sx * 0.2, y: 0.45, z: -0.17 };
    const el = { x: sx * 0.3, y: 0.3, z: -0.42 };
    const hand = { x: sx * 0.34, y: barY, z: barZ };
    parts.push(limb(sh, el, 0.055, suit));
    parts.push(limb(el, hand, 0.05, suit));
    parts.push(paint(new THREE.SphereGeometry(0.055, 6, 5).translate(hand.x, hand.y, hand.z), '#2e3138'));
    // legs: thighs along the saddle, shins down into the footwells
    const h = { x: sx * 0.12, y: 0.04, z: 0.05 };
    const knee = { x: sx * 0.24, y: 0.08, z: -0.38 };
    const foot = { x: sx * 0.42, y: -0.28, z: -0.1 };
    parts.push(limb(h, knee, 0.075, suit));
    parts.push(limb(knee, foot, 0.06, suit));
    parts.push(box(0.11, 0.08, 0.26, '#30343b', foot.x, foot.y - 0.02, foot.z - 0.06));
  }
  return merge(parts);
}

// ------------------------------------------------------------------------------------------------
// The course's furniture
// ------------------------------------------------------------------------------------------------

/** A gate buoy's height above the water, and how deep its base floats. */
export const BUOY_H = 2.1;

/** The inflatable gate buoy's body (tinted per instance: red to the left of the course, yellow to the right). */
export function buoyBody() {
  const prof = [
    [0, -0.35],
    [0.5, -0.35],
    [0.6, -0.1],
    [0.62, 0.35],
    [0.6, 1.05],
    [0.5, 1.6],
    [0.3, 1.95],
    [0.12, BUOY_H],
    [0, BUOY_H + 0.02],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  return paint(new THREE.LatheGeometry(prof, 16), '#ffffff');
}

/** The buoy's untinted trim: a white band, the dark anchor skirt and the lamp's cage on top. */
export function buoyTrim() {
  const parts = [
    paint(new THREE.CylinderGeometry(0.605, 0.615, 0.26, 16, 1, true).translate(0, 0.86, 0), '#f6f3ec'),
    paint(new THREE.CylinderGeometry(0.635, 0.6, 0.18, 16, 1, true).translate(0, 0.02, 0), '#24272d'),
    paint(new THREE.CylinderGeometry(0.06, 0.06, 0.12, 6).translate(0, BUOY_H + 0.07, 0), '#3a3e45'),
  ];
  return merge(parts);
}

/**
 * One floating kicker: a curved deck (the profile `rampLift` gives), skirts down its sides into
 * the water, a padded lip, pontoon floats underneath and a flag on each corner of the lip; laid
 * out in world space at the ramp's foot (y 0 = the water line), in the ramp's own frame
 * (`along` up the slope to −z when placed with the ramp's yaw).
 */
export function rampGeometry(r: Ramp) {
  const n = 14;
  const hw = r.width / 2;
  const deck: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const along = (i / n) * r.len;
    const y = rampLift(r, along) + 0.04;
    deck.push(-hw, y, -along, hw, y, -along);
    uv.push(0, along / r.len, 1, along / r.len);
    if (i < n) {
      const q = i * 2;
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3));
  top.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  top.setIndex(idx);
  top.computeVertexNormals();

  const parts: THREE.BufferGeometry[] = [];
  // the side skirts: the deck's edge down to below the water line
  for (const sx of [-1, 1]) {
    const pos: number[] = [];
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * r.len;
      const a1 = ((i + 1) / n) * r.len;
      const y0 = rampLift(r, a0) + 0.04;
      const y1 = rampLift(r, a1) + 0.04;
      const x = sx * hw;
      const quad = [
        [x, -0.3, -a0],
        [x, -0.3, -a1],
        [x, y1, -a1],
        [x, y0, -a0],
      ];
      const tri = sx > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const t of tri) pos.push(...quad[t]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.push(paint(g, '#1e6f86'));
  }
  // the back wall under the lip, the padded lip itself, the floats and the corner flags
  parts.push(box(r.width, r.height + 0.35, 0.12, '#1a5a6e', 0, (r.height - 0.3) / 2, -r.len));
  parts.push(paint(new THREE.CylinderGeometry(0.11, 0.11, r.width + 0.1, 10).rotateZ(Math.PI / 2).translate(0, r.height + 0.06, -r.len + 0.06), '#ff6b3d'));
  for (const sx of [-1, 1]) parts.push(paint(new THREE.CylinderGeometry(0.32, 0.32, r.len + 0.4, 12).rotateX(Math.PI / 2).translate(sx * (hw - 0.35), -0.12, -r.len / 2), '#e9e4d8'));
  for (const sx of [-1, 1]) {
    parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 1.6, 5).translate(sx * (hw + 0.05), r.height + 0.8, -r.len), '#d9d4c8'));
    const flag = new THREE.BufferGeometry();
    flag.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, -0.42, 0, 0, -0.21, 0.62].map((v, k) => v + [sx * (hw + 0.05), r.height + 1.58, -r.len][k % 3]), 3));
    flag.computeVertexNormals();
    parts.push(paint(flag, '#ffd23f'));
  }
  return { top, sides: merge(parts) };
}

/** The ramp deck's paint: yellow and black chevrons pointing up the slope, "JUMP" in the middle. */
export function rampTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 512;
  const g = c.getContext('2d')!;
  g.fillStyle = '#1b1d22';
  g.fillRect(0, 0, 256, 512);
  g.fillStyle = '#ffd23f';
  for (let y = -128; y < 640; y += 96) {
    g.beginPath();
    g.moveTo(0, y + 64);
    g.lineTo(128, y);
    g.lineTo(256, y + 64);
    g.lineTo(256, y + 104);
    g.lineTo(128, y + 40);
    g.lineTo(0, y + 104);
    g.closePath();
    g.fill();
  }
  // grip: a fine speckle
  for (let i = 0; i < 2500; i++) {
    g.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.18)';
    g.fillRect(Math.random() * 256, Math.random() * 512, 2, 2);
  }
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#1b1d22';
  g.lineWidth = 10;
  g.font = 'bold 84px "Lilita One", "Arial Black", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(128, 256);
  g.rotate(-Math.PI / 2);
  g.strokeText('JUMP', 0, 0);
  g.fillText('JUMP', 0, 0);
  g.restore();
  return c;
}

/**
 * The inflatable start / finish arch over the course: a fat tube in a half-ellipse, striped, on two
 * floats, `span` metres between its feet and `rise` tall. Local x runs across the course, y is up
 * from the water line.
 */
export function archGeometry(span: number, rise: number, stripes: string[]) {
  const pts: THREE.Vector3[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const a = Math.PI * (1 - i / n);
    pts.push(new THREE.Vector3((Math.cos(a) * span) / 2, Math.sin(a) * rise, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const tube = new THREE.TubeGeometry(curve, n * 2, 0.72, 14, false);
  // stripes: colour each ring of the tube by its place along the arch
  const pos = tube.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const radial = 15;
  for (let i = 0; i < pos.count; i++) {
    const ring = Math.floor(i / radial);
    C.set(stripes[Math.floor(ring / 8) % stripes.length]);
    col[i * 3] = C.r;
    col[i * 3 + 1] = C.g;
    col[i * 3 + 2] = C.b;
  }
  tube.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tube.deleteAttribute('uv');
  const tubeGeo = tube.toNonIndexed();
  const parts: THREE.BufferGeometry[] = [tubeGeo];
  for (const sx of [-1, 1]) {
    parts.push(paint(new THREE.CylinderGeometry(1.25, 1.25, 0.7, 16).translate((sx * span) / 2, 0.05, 0), '#2a2d33'));
    parts.push(paint(new THREE.TorusGeometry(1.2, 0.28, 8, 18).rotateX(Math.PI / 2).translate((sx * span) / 2, 0.38, 0), '#f6f3ec'));
  }
  // the banner's frame hangs from the arch's crown
  for (const sx of [-1, 1]) parts.push(paint(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 5).translate(sx * 6.4, rise - 0.75, 0), '#3a3e45'));
  return merge(parts);
}

/** A spectator: a body and a head, for instancing (the instance colour is their shirt). */
export function spectatorBody() {
  return merge([
    limb({ x: 0, y: 0.45, z: 0 }, { x: 0, y: 1.25, z: 0 }, 0.2, '#ffffff', 8),
    limb({ x: -0.1, y: 0.05, z: 0 }, { x: -0.1, y: 0.6, z: 0 }, 0.09, '#3a4150'),
    limb({ x: 0.1, y: 0.05, z: 0 }, { x: 0.1, y: 0.6, z: 0 }, 0.09, '#3a4150'),
  ]);
}

export function spectatorHead() {
  return merge([paint(new THREE.SphereGeometry(0.15, 10, 8).translate(0, 1.6, 0), '#ffffff'), paint(new THREE.SphereGeometry(0.155, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.42).translate(0, 1.63, 0.01), '#3b2a20')]);
}
