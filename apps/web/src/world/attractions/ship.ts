import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { shadowed, staticBox, staticCylinder, std, type Attraction, type Ctx } from '../context';
import type { Input } from '../input';
import { LAYOUT } from '../layout';
import { hdr, PALETTE, signMaterial, signTexture } from '../textures';

// A looping pendulum ship, after the 360° "space ship" rides at travelling fairs: a curved gondola
// of outward-facing seats on a single truss arm with a counterweight, swung from an axle carried
// by two A-frames. The motor pumps it up swing by swing until it goes right over the top, loops,
// stops dead with everyone hanging upside down, then loops backwards and swings down to rest.
// Built in a local frame: the boat swings in the x–y plane, the axle runs along z and +z is the
// front (queue, sign, your seat). The ride stands at the east end of Cosmos's Cosmic Way, turned to
// face the path.
const PIVOT_Y = 16;
const R_OUT = 14.9; // the boat's outer (bottom) arc…
const R_IN = 13; // …and its inner arc, where the arm meets it
const SPAN = THREE.MathUtils.degToRad(32); // half the arc the boat covers
const HALF_W = 1.2; // half the boat's width along the axle, before the bevel
const BEVEL = 0.2;
const FACE = HALF_W + BEVEL; // the two side faces, where the seats hang
const SEATS = 10; // per side
const SEAT_STEP = THREE.MathUtils.degToRad(5.4);
const SEAT_R = 13.95; // seat pans, from the pivot
const MY_SEAT = 4; // on the south face, near the middle
const AXLE_HALF = 4.2; // A-frame apexes
const FOOT = { x: 10.5, z: 6.8 };
const FENCE = { x: 18, z: 10 };
const YAW = Math.PI; // front faces north, towards the fair

// The swing is a driven pendulum, θ'' = −ω0² sin θ + u, with θ = 0 hanging straight down.
const W0 = 9.8 / 17; // ω0²: an 8.5 s swing
const TOP_SPEED = 0.45; // rad/s over the top while looping
const E_REST = -W0;
const E_LOOP = W0 + 0.5 * TOP_SPEED ** 2;
const PUMP = 0.24 * W0; // the motor's push…
const BRAKE = 0.32 * W0; // …and its braking
const KP = 2.5; // position hold (upside down, and the final stop)
const KD = 3.2;
const LOOPS = 3;
const BACK_LOOPS = 2;
const HANG = 4.5;
const BOARD_RIDE = 3.6; // countdown before your ride starts
const BOARD_GHOST = 12; // guests getting off and on between ghost rides
const HEAD_R = SEAT_R - 0.88; // riders' heads, for the g readout

type Phase = 'board' | 'build' | 'loop' | 'hang' | 'back' | 'settle';
type Cam = 'seat' | 'onboard' | 'ground';
const CAM_LABEL: Record<Cam, string> = { seat: 'Seat', onboard: 'Onboard', ground: 'Ground' };

const UP = new THREE.Vector3(0, 1, 0);

/** Matrix for a unit cylinder (height 1 along y) stretched between a and b. */
function strut(a: THREE.Vector3, b: THREE.Vector3, r: number, out = new THREE.Matrix4()) {
  const d = b.clone().sub(a);
  const len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.normalize());
  return out.compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r));
}

/** A point on the boat's arc: φ = 0 is straight down from the pivot. */
const arc = (r: number, phi: number, z = 0) => new THREE.Vector3(Math.sin(phi) * r, -Math.cos(phi) * r, z);

/**
 * The boat's side panels: yellow, a dark band under the seats and neon trim. The extruded caps
 * take their UVs straight from the shape (metres in the swing plane), so this is drawn to scale.
 */
function panelTextures() {
  const x0 = -(R_OUT * Math.sin(SPAN) + 1.4);
  const x1 = -x0;
  const y0 = -R_OUT - BEVEL - 0.1;
  const y1 = -((R_OUT + R_IN) / 2) * Math.cos(SPAN) + (R_OUT - R_IN) / 2 + BEVEL + 0.3;
  const k = 112; // px per metre
  const W = Math.ceil((x1 - x0) * k);
  const H = Math.ceil((y1 - y0) * k);
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    // the pivot, in canvas pixels (canvas y runs down, so world angles flip)
    g.translate(-x0 * k, y1 * k);
    return { c, g };
  };
  const base = mk();
  const glow = mk();
  const down = Math.PI / 2; // straight down in canvas angles
  const band = (g: CanvasRenderingContext2D, r: number, w: number, style: string, span = SPAN - 0.03) => {
    g.strokeStyle = style;
    g.lineWidth = w * k;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, 0, r * k, down - span, down + span);
    g.stroke();
  };
  base.g.fillStyle = '#f2b62e';
  base.g.fillRect(x0 * k, -y1 * k, W, H);
  base.g.fillStyle = 'black';
  glow.g.fillStyle = 'black';
  glow.g.fillRect(x0 * k, -y1 * k, W, H);
  band(base.g, 13.95, 1.5, '#23202f');
  for (const { g } of [base, glow]) {
    band(g, 14.62, 0.07, '#5ce1d6');
    band(g, 13.28, 0.07, '#a98bff');
    band(g, 14.82, 0.05, '#ffffff', SPAN - 0.12);
    // circuit traces between the seats
    for (let i = 0; i <= SEATS; i++) {
      const a = down + (i - SEATS / 2) * SEAT_STEP;
      const p = (r: number) => [Math.cos(a) * r * k, Math.sin(a) * r * k] as const;
      g.strokeStyle = i % 2 ? '#5ce1d6' : '#ff5dd2';
      g.lineWidth = 0.05 * k;
      g.beginPath();
      g.moveTo(...p(13.32));
      g.lineTo(...p(13.75));
      g.stroke();
      g.fillStyle = g.strokeStyle;
      g.beginPath();
      g.arc(...p(13.8), 0.07 * k, 0, Math.PI * 2);
      g.fill();
    }
    // chevrons out at the tips
    for (const s of [-1, 1])
      for (let j = 0; j < 3; j++) {
        const a = down + s * (SPAN - 0.02 - j * 0.035);
        g.strokeStyle = '#ff8a3d';
        g.lineWidth = 0.06 * k;
        g.beginPath();
        g.arc(0, 0, 14.0 * k, a - 0.008, a + 0.008);
        g.lineTo(Math.cos(a - s * 0.02) * 14.4 * k, Math.sin(a - s * 0.02) * 14.4 * k);
        g.stroke();
      }
  }
  const tex = [base.c, glow.c].map((c) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    // shape coords (metres) → 0..1
    t.repeat.set(1 / (x1 - x0), 1 / (y1 - y0));
    t.offset.set(-x0 / (x1 - x0), -y0 / (y1 - y0));
    return t;
  });
  return { map: tex[0], emissiveMap: tex[1] };
}

interface Rider {
  arms: THREE.Object3D[];
  /** How easily this guest throws their hands up (0 = first, 1 = last). */
  nerve: number;
  lift: number;
}

export class Ship implements Attraction {
  /** The pivot, in world space. */
  readonly pivot = new THREE.Vector3(LAYOUT.ship.x, PIVOT_Y, LAYOUT.ship.z);
  private root = new THREE.Group();
  private swing = new THREE.Group();
  private leds: THREE.InstancedMesh;
  private ledCount = 0;
  private riders: Rider[] = [];
  private seats: THREE.Group[] = [];
  private myPuppet!: THREE.Object3D;
  private theta = 0;
  private omega = 0;
  private phase: Phase = 'board';
  private phaseT = 0;
  private board = BOARD_GHOST;
  private dir = 1;
  /** θ where the current run of loops began (at the top), and where to stop when hanging. */
  private rev0 = 0;
  private target = 0;
  private riding = false;
  private lastCount = -1;
  private gSmooth = 1;
  private maxG = 1;
  private cam: Cam = 'seat';
  private yaw = 0;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The boat has swung home and stopped: the round is done. */
  onComplete: (() => void) | null = null;
  /** True from the end of your cycle until you're off (the ghost cycle starts without you). */
  private done = false;
  private minG = 1;
  private top = 0;
  private topSpeed = 0;
  private roundStart = 0;

  constructor(private ctx: Ctx) {
    const c = new THREE.Vector3(LAYOUT.ship.x, 0, LAYOUT.ship.z);
    const yellow = std('#f0b12c', { metalness: 0.45, roughness: 0.38 });
    const dark = std('#2b2836', { metalness: 0.5, roughness: 0.45 });
    const unit = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
    const m = new THREE.Matrix4();

    // ---------------- the swinging part: boat, arm, counterweight ----------------
    const shape = new THREE.Shape();
    const rm = (R_OUT + R_IN) / 2;
    const hw = (R_OUT - R_IN) / 2;
    const a0 = -Math.PI / 2 - SPAN;
    const a1 = -Math.PI / 2 + SPAN;
    shape.absarc(0, 0, R_OUT, a0, a1, false);
    shape.absarc(Math.cos(a1) * rm, Math.sin(a1) * rm, hw, a1, a1 + Math.PI, false);
    shape.absarc(0, 0, R_IN, a1, a0, true);
    shape.absarc(Math.cos(a0) * rm, Math.sin(a0) * rm, hw, a0 + Math.PI, a0 + Math.PI * 2, false);
    const hull = new THREE.ExtrudeGeometry(shape, {
      depth: HALF_W * 2,
      curveSegments: 64,
      bevelEnabled: true,
      bevelThickness: BEVEL,
      bevelSize: 0.15,
      bevelSegments: 3,
    });
    hull.translate(0, 0, -HALF_W);
    const { map, emissiveMap } = panelTextures();
    const boat = new THREE.Mesh(hull, [
      new THREE.MeshStandardMaterial({ map, emissiveMap, emissive: '#ffffff', emissiveIntensity: 2.4, metalness: 0.35, roughness: 0.4 }),
      new THREE.MeshPhysicalMaterial({ color: '#f0b12c', metalness: 0.3, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 }),
    ]);
    this.swing.add(boat);

    // the arm: a square lattice truss from the counterweight, past the hub, down to the boat,
    // with a fork of struts out to each end of the boat
    const struts: [THREE.Vector3, THREE.Vector3, number][] = [];
    const cx = 0.55;
    const cz = 0.5;
    const top = 3.4;
    const bottom = -R_IN + 0.2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) struts.push([new THREE.Vector3(sx * cx, top, sz * cz), new THREE.Vector3(sx * cx * 1.5, bottom, sz * cz), 0.13]);
    const chord = (sx: number, sz: number, y: number) => new THREE.Vector3(sx * cx * (1 + (0.5 * (top - y)) / (top - bottom)), y, sz * cz);
    for (let y = top; y > bottom + 0.5; y -= 1.3) {
      const y2 = Math.max(bottom, y - 1.3);
      for (const s of [-1, 1]) {
        struts.push([chord(-1, s, y), chord(1, s, y2), 0.06]); // across the faces
        struts.push([chord(s, -1, y), chord(s, 1, y2), 0.06]); // across the sides
        struts.push([chord(-1, s, y2), chord(1, s, y2), 0.05]);
      }
    }
    for (const [ya, phi] of [
      [-5.5, SPAN * 0.85],
      [-8.8, SPAN * 0.5],
    ] as const)
      for (const s of [-1, 1])
        for (const sz of [-1, 1]) struts.push([chord(s, sz, ya), arc(R_IN - 0.05, s * phi, sz * cz * 1.6), 0.11]);
    const truss = new THREE.InstancedMesh(unit, yellow, struts.length);
    struts.forEach(([a, b, r], i) => truss.setMatrixAt(i, strut(a, b, r, m)));
    this.swing.add(truss);

    // a little speaker / spotlight pod on every other lattice bay, like the real ride's
    const pods = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.28, 0.36, 0.5, 12).rotateX(Math.PI / 2), dark, 8);
    for (let i = 0; i < 4; i++)
      for (const sz of [-1, 1]) {
        m.makeTranslation(0, -2.4 - i * 2.4, sz * (cz + 0.3));
        pods.setMatrixAt(i * 2 + (sz > 0 ? 1 : 0), m);
      }
    this.swing.add(pods);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 2.6, 28).rotateX(Math.PI / 2), dark);
    this.swing.add(hub);
    // the counterweight: a geared disc with a glowing ring
    const weight = new THREE.Group();
    weight.add(new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 1.5, 32).rotateX(Math.PI / 2), dark));
    const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(0.5, 0.45, 1.2), yellow, 18);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      m.makeRotationZ(a).setPosition(Math.cos(a) * 2.35, Math.sin(a) * 2.35, 0);
      teeth.setMatrixAt(i, m);
    }
    weight.add(teeth);
    const glowRing = new THREE.MeshBasicMaterial({ color: hdr(PALETTE.teal, 5) });
    for (const z of [-0.78, 0.78]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.09, 6, 40), glowRing);
      ring.position.z = z;
      weight.add(ring);
    }
    weight.position.y = 4.6;
    this.swing.add(weight);

    // LED strings along the bottom of the boat, chasing during the ride
    const per = 44;
    this.leds = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 4), new THREE.MeshBasicMaterial({ color: '#ffffff' }), per * 2);
    for (let i = 0; i < per; i++)
      for (const z of [-1, 1]) {
        const phi = -SPAN + ((i + 0.5) / per) * SPAN * 2;
        m.makeTranslation(arc(R_OUT + 0.17, phi, z * (HALF_W - 0.25)));
        this.leds.setMatrixAt(this.ledCount, m);
        this.leds.setColorAt(this.ledCount++, hdr('#ffffff', 2));
      }
    this.swing.add(this.leds);

    this.buildSeats();
    this.swing.position.y = PIVOT_Y;
    shadowed(this.swing);
    this.leds.castShadow = false;
    this.root.add(this.swing);

    // ---------------- the fixed part: A-frames, axle, base, fence, sign ----------------
    const frame = new THREE.Group();
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, AXLE_HALF * 2 + 1, 20).rotateX(Math.PI / 2), dark);
    axle.position.y = PIVOT_Y;
    frame.add(axle);
    const legGeo = new THREE.CylinderGeometry(0.34, 0.5, 1, 14, 1);
    for (const side of [-1, 1]) {
      const apex = new THREE.Vector3(0, PIVOT_Y, side * AXLE_HALF);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.8, 1), yellow);
      housing.position.copy(apex);
      frame.add(housing);
      const feet = [-1, 1].map((sx) => new THREE.Vector3(sx * FOOT.x, 0, side * FOOT.z));
      for (const foot of feet) {
        const leg = new THREE.Mesh(legGeo, yellow);
        leg.applyMatrix4(strut(foot, apex, 1));
        frame.add(leg);
        const pad = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 1.6), std('#b9b2a6', { roughness: 0.9 }));
        pad.position.copy(foot).setY(0.25);
        frame.add(pad);
      }
      // a tie across each A-frame, and a white striped service ladder up one leg
      const tie = feet.map((f) => f.clone().lerp(apex, 0.3));
      const tieMesh = new THREE.Mesh(unit, yellow);
      tieMesh.applyMatrix4(strut(tie[0], tie[1], 0.22));
      frame.add(tieMesh);
    }
    // the two A-frames are tied together at the ground, outside the boat's sweep
    for (const sx of [-1, 1]) {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, FOOT.z * 2), dark);
      beam.position.set(sx * FOOT.x, 0.2, 0);
      frame.add(beam);
    }
    // boarding deck under the boat, with steps up on the park side
    const deck = new THREE.Mesh(new THREE.BoxGeometry(17, 0.5, 9), std('#4a4458', { roughness: 0.8 }));
    deck.position.y = 0.25;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(17.2, 0.12, 9.2), std(PALETTE.mustard, { roughness: 0.5 }));
    trim.position.y = 0.5;
    const steps = new THREE.Mesh(new THREE.BoxGeometry(4, 0.25, 1.2), std('#4a4458', { roughness: 0.8 }));
    steps.position.set(0, 0.12, 5.1);
    frame.add(deck, trim, steps);
    // operator's cabin
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.6, 2.2), std(PALETTE.cream, { roughness: 0.7 }));
    cabin.position.set(13.5, 1.3, 6.4);
    const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(3, 0.25, 2.6), std(PALETTE.violet, { roughness: 0.5 }));
    cabinRoof.position.set(13.5, 2.72, 6.4);
    const cabinWin = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), std('#5ce1d6', { emissive: '#2ec4b6', emissiveIntensity: 0.8, roughness: 0.1 }));
    cabinWin.position.set(13.5, 1.7, 7.51);
    frame.add(cabin, cabinRoof, cabinWin);

    // the fence around it all
    const fx = FENCE.x;
    const fz = FENCE.z;
    const postSpots: [number, number][] = [];
    for (let x = -fx; x <= fx; x += 2) postSpots.push([x, -fz], [x, fz]);
    for (let z = -fz + 2; z < fz; z += 2) postSpots.push([-fx, z], [fx, z]);
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 1.2, 0.14).translate(0, 0.6, 0), std(PALETTE.cream, { roughness: 0.7 }), postSpots.length);
    postSpots.forEach(([x, z], i) => posts.setMatrixAt(i, m.makeTranslation(x, 0, z)));
    frame.add(posts);
    const railMat = std(PALETTE.candy, { roughness: 0.5 });
    for (const [x, z, w, d] of [
      [0, -fz, fx * 2, 0.08],
      [0, fz, fx * 2, 0.08],
      [-fx, 0, 0.08, fz * 2],
      [fx, 0, 0.08, fz * 2],
    ] as const)
      for (const y of [0.55, 1.05]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, d), railMat);
        rail.position.set(x, y, z);
        frame.add(rail);
      }

    // the sign, on two posts by the queue
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 2.4),
      signMaterial(signTexture('NEBULA 360', { sub: 'Loops · hangs you upside down · loops back', border: PALETTE.teal }), { emissiveIntensity: 1.6 }),
    );
    sign.position.set(-8.5, 4.6, fz + 1.2);
    for (const x of [-11.6, -5.4]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 4.6), dark);
      post.position.set(x, 2.3, fz + 1.1);
      frame.add(post);
    }
    frame.add(sign);
    shadowed(frame, true);
    this.root.add(frame);
    this.root.position.copy(c);
    this.root.rotation.y = YAW;
    ctx.scene.add(this.root);
    this.root.updateMatrixWorld(true);

    // colliders: the fence and the sign posts
    const at = (x: number, z: number) => new THREE.Vector3(x, 0, z).applyMatrix4(this.root.matrixWorld);
    for (const [x, z, hx, hz] of [
      [0, -fz, fx, 0.1],
      [0, fz, fx, 0.1],
      [-fx, 0, 0.1, fz],
      [fx, 0, 0.1, fz],
    ] as const) {
      const p = at(x, z);
      staticBox(ctx, p.x, 0.6, p.z, hx, 0.6, hz, YAW);
    }
    for (const x of [-11.6, -5.4]) {
      const p = at(x, fz + 1.1);
      staticCylinder(ctx, p.x, p.z, 0.2, 4.6);
    }

    this.place();
  }

  /** Ten outward-facing seats down each side of the boat, with a guest in every one. */
  private buildSeats() {
    const shell = mergeGeometries([
      new THREE.BoxGeometry(0.62, 1.0, 0.12).translate(0, 0.45, 0.06), // back
      new THREE.BoxGeometry(0.42, 0.32, 0.14).translate(0, 1.05, 0.08), // headrest
      new THREE.BoxGeometry(0.62, 0.12, 0.55).translate(0, -0.02, 0.32), // pan
    ])!;
    // an over-the-shoulder restraint: a horseshoe across the chest, hinged above the headrest
    const bar = mergeGeometries([
      new THREE.TorusGeometry(0.24, 0.045, 6, 14, Math.PI).rotateZ(Math.PI).translate(0, 0.62, 0.42),
      new THREE.CylinderGeometry(0.045, 0.045, 0.62).rotateX(Math.PI / 2 - 0.5).translate(-0.24, 0.92, 0.28),
      new THREE.CylinderGeometry(0.045, 0.045, 0.62).rotateX(Math.PI / 2 - 0.5).translate(0.24, 0.92, 0.28),
    ])!;
    const seatMat = std(PALETTE.ink, { roughness: 0.7 });
    const chrome = std('#e6e2f0', { roughness: 0.15, metalness: 1 });
    const shirts = ['#5ce1d6', '#ff8a3d', '#a98bff', '#ffd23d', '#7ee2b8', '#ff5d7a', '#ffffff', '#5a8dee'];
    const pants = ['#2f3b5c', '#3d3348', '#5b4b3a', '#24303a'];
    const skins = ['#e8b48a', '#c98e62', '#8d5a3b', '#f1c9a5'].map((s) => std(s));
    const torsoGeo = new THREE.CapsuleGeometry(0.17, 0.3, 4, 8).translate(0, 0.42, 0.24);
    const headGeo = new THREE.SphereGeometry(0.14, 12, 10).translate(0, 0.86, 0.22);
    const legGeo = mergeGeometries(
      [-0.11, 0.11].flatMap((x) => [
        new THREE.CapsuleGeometry(0.075, 0.34, 3, 6).rotateX(Math.PI / 2).translate(x, 0.08, 0.5), // thigh
        new THREE.CapsuleGeometry(0.065, 0.36, 3, 6).translate(x, -0.18, 0.72), // shin, hanging free
      ]),
    )!;
    const armGeo = new THREE.CapsuleGeometry(0.05, 0.42, 3, 6).translate(0, 0.27, 0);
    const shirtMats = shirts.map((s) => std(s));
    const pantMats = pants.map((s) => std(s));
    let n = 0;
    for (const side of [1, -1])
      for (let i = 0; i < SEATS; i++) {
        const phi = (i - (SEATS - 1) / 2) * SEAT_STEP;
        const seat = new THREE.Group();
        seat.position.copy(arc(SEAT_R, phi, side * FACE));
        seat.rotation.order = 'ZYX';
        seat.rotation.set(0, side > 0 ? 0 : Math.PI, phi);
        seat.add(new THREE.Mesh(shell, seatMat), new THREE.Mesh(bar, chrome));
        const guest = new THREE.Group();
        const skin = skins[n % skins.length];
        guest.add(new THREE.Mesh(torsoGeo, shirtMats[(n * 3) % shirtMats.length]), new THREE.Mesh(headGeo, skin), new THREE.Mesh(legGeo, pantMats[n % pantMats.length]));
        const arms: THREE.Object3D[] = [];
        for (const x of [-0.21, 0.21]) {
          const arm = new THREE.Mesh(armGeo, skin);
          arm.position.set(x, 0.6, 0.24);
          arm.userData.side = Math.sign(x);
          guest.add(arm);
          arms.push(arm);
        }
        seat.add(guest);
        this.riders.push({ arms, nerve: ((n * 7) % 11) / 11, lift: 0 });
        if (side > 0 && i === MY_SEAT) this.myPuppet = guest;
        this.seats.push(seat);
        this.swing.add(seat);
        n++;
      }
  }

  // ------------------------------------------------------------------ ride

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
    if (!this.riding) return;
    if (p === 'loop') this.ctx.ui.countdown('OVER THE TOP!');
    else if (p === 'hang') this.ctx.ui.countdown('UPSIDE DOWN 🙃');
    else if (p === 'back') this.ctx.ui.countdown('BACKWARDS!');
    if (p === 'loop' || p === 'back') this.ctx.sfx.whoosh();
  }

  private get energy() {
    return 0.5 * this.omega * this.omega - W0 * Math.cos(this.theta);
  }

  /** Which way the motor pushes: with the swing, or `dir` while it's (nearly) still. */
  private push() {
    return Math.abs(this.omega) < 0.03 ? this.dir : Math.sign(this.omega);
  }

  private step(h: number) {
    const E = this.energy;
    let u = 0;
    switch (this.phase) {
      case 'board':
        this.theta = this.omega = 0;
        if (this.phaseT > this.board) {
          this.dir = Math.random() < 0.5 ? 1 : -1;
          this.setPhase('build');
        }
        break;
      case 'build':
        u = PUMP * this.push();
        if (Math.abs(this.theta) >= Math.PI) {
          this.dir = Math.sign(this.theta);
          this.rev0 = this.dir * Math.PI;
          this.setPhase('loop');
        }
        break;
      case 'loop':
      case 'back': {
        u = THREE.MathUtils.clamp(2 * (E_LOOP - E), -BRAKE, PUMP) * this.push();
        const n = this.phase === 'loop' ? LOOPS : BACK_LOOPS;
        if (Math.abs(this.theta - this.rev0) >= Math.PI * 2 * n - 0.3) {
          this.target = this.rev0 + this.dir * Math.PI * 2 * n;
          this.setPhase(this.phase === 'loop' ? 'hang' : 'settle');
        }
        break;
      }
      case 'hang':
        u = W0 * Math.sin(this.theta) + KP * (this.target - this.theta) - KD * this.omega;
        if (this.phaseT > HANG) {
          this.dir = -this.dir;
          this.rev0 = this.theta;
          this.omega = this.dir * 0.05;
          this.setPhase('back');
        }
        break;
      case 'settle':
        if (E > E_REST + 0.04) u = -BRAKE * THREE.MathUtils.clamp(this.omega / 0.4, -1, 1);
        else {
          // nearly still: ease into the station
          const home = Math.round(this.theta / (Math.PI * 2)) * Math.PI * 2;
          u = W0 * Math.sin(this.theta) + KP * (home - this.theta) - KD * this.omega;
          if (Math.abs(home - this.theta) < 0.004 && Math.abs(this.omega) < 0.01) {
            this.theta = this.omega = 0;
            const mine = this.riding && !this.done;
            if (mine) this.done = true;
            this.board = BOARD_GHOST;
            this.setPhase('board');
            if (mine) this.onComplete?.();
          }
        }
        break;
    }
    this.omega += (-W0 * Math.sin(this.theta) + u) * h;
    this.theta += this.omega * h;
    this.phaseT += h;
  }

  /** Felt g at the riders' heads, along their spines (negative = hanging in the restraints). */
  private get g() {
    return (this.omega * this.omega * HEAD_R + 9.8 * Math.cos(this.theta)) / 9.8;
  }

  /** Height of your seat above the ground. */
  get altitude() {
    return PIVOT_Y - Math.cos(this.theta) * SEAT_R;
  }

  private place() {
    this.swing.rotation.z = this.theta;
    this.swing.updateMatrixWorld(true);
  }

  start() {
    this.riding = true;
    this.theta = this.omega = 0;
    this.board = BOARD_RIDE;
    this.setPhase('board');
    this.lastCount = -1;
    this.maxG = this.minG = 1;
    this.top = this.topSpeed = 0;
    this.roundStart = this.ctx.time.t;
    this.done = false;
    this.cam = 'seat';
    this.yaw = 0;
    this.myPuppet.visible = false;
    this.place();
    // opens by itself the first time; after that it's behind the ℹ️
    this.ctx.ui.setIntro(
      'ship-intro',
      'Nebula 360',
      `<p class="eyebrow">Nebula 360 · Looping pendulum ship</p><h2>All the way round</h2><p>The motor pumps the boat higher with every swing until it goes <strong>right over the top</strong>, ${LOOPS} loops forward, stops dead with you <strong>hanging upside down</strong> 30 m up, then loops back the other way.</p><p>${
        this.ctx.mobile
          ? 'Joystick <strong>left/right</strong> looks around. Tap <kbd>E</kbd> to switch camera.'
          : '<kbd>A</kbd>/<kbd>D</kbd> look around · <kbd>C</kbd> camera · <kbd>Esc</kbd> to get off.'
      }</p>`,
      { accent: PALETTE.teal },
    );
    this.ctx.sfx.chime();
  }

  exit() {
    if (!this.riding) return;
    this.riding = false;
    this.myPuppet.visible = true;
    this.ctx.ui.score(null);
    this.ctx.ui.countdown(null);
    this.onFinish?.();
  }

  /** This round's numbers (see account/stats.ts). */
  roundStats(): Record<string, number> {
    return {
      durationS: this.ctx.time.t - this.roundStart,
      maxG: this.maxG,
      minG: this.minG,
      maxHeightM: this.top,
      topSpeedKmh: this.topSpeed,
    };
  }

  cycleCamera() {
    const order: Cam[] = ['seat', 'onboard', 'ground'];
    this.cam = order[(order.indexOf(this.cam) + 1) % order.length];
    this.ctx.sfx.pop();
  }

  /** How fast the boat is moving, 0..1 (for the wind and rumble). */
  get speed01() {
    return Math.min(1, Math.abs(this.omega) * SEAT_R / 30);
  }

  update(dt: number, t: number) {
    // fixed substeps keep the pendulum (and the hold controller) stable at any frame rate
    const n = Math.ceil(dt / (1 / 120));
    for (let i = 0; i < n; i++) this.step(dt / n);
    this.place();
    const g = this.g;
    this.gSmooth += (g - this.gSmooth) * Math.min(1, dt * 6);

    // hands go up at the top of big swings, over the loops and hanging upside down
    const big = this.phase === 'loop' || this.phase === 'back' || this.phase === 'hang' ? 1 : THREE.MathUtils.clamp((1 - Math.cos(this.theta)) * 0.7 - 0.2, 0, 1);
    for (const r of this.riders) {
      r.lift += ((big > r.nerve * 0.8 + 0.1 ? 1 : 0) - r.lift) * Math.min(1, dt * 5);
      for (const a of r.arms) {
        a.rotation.x = THREE.MathUtils.lerp(1.9, 0.15, r.lift); // forward onto the bar → straight up
        a.rotation.z = -a.userData.side * 0.35 * r.lift;
      }
    }

    // LEDs: a slow glow at rest, a chase that runs with the swing
    const col = new THREE.Color();
    const palette = [PALETTE.teal, '#ff5dd2', PALETTE.violet, PALETTE.mustard];
    const moving = this.phase !== 'board';
    for (let i = 0; i < this.ledCount; i++) {
      const j = i >> 1;
      if (moving) {
        const wave = 0.5 + 0.5 * Math.sin(j * 0.6 - this.theta * 8 - t * 2);
        col.set(palette[Math.floor(j / 6 + t * 0.5) % palette.length]).multiplyScalar(1 + wave * 6);
      } else col.set('#ffe2a0').multiplyScalar(2 + Math.sin(t * 2 + j * 0.3));
      this.leds.setColorAt(i, col);
    }
    this.leds.instanceColor!.needsUpdate = true;

    // once your cycle is over the boat is boarding the next guests: nothing more to show you
    if (!this.riding || this.done) return;
    this.yaw = THREE.MathUtils.clamp(this.yaw + (this.input?.steer ?? 0) * dt * 1.4, -1.6, 1.6);
    this.maxG = Math.max(this.maxG, g);
    this.minG = Math.min(this.minG, g);
    this.top = Math.max(this.top, this.altitude);
    this.topSpeed = Math.max(this.topSpeed, Math.abs(this.omega) * SEAT_R * 3.6);
    if (this.phase === 'board') {
      const left = 3 - Math.floor(this.phaseT * (3 / (BOARD_RIDE - 0.6)));
      if (left !== this.lastCount && left >= 0) {
        this.lastCount = left;
        this.ctx.ui.countdown(left === 0 ? 'HOLD ON!' : String(left));
        this.ctx.sfx.beep(left === 0);
      }
    } else if (this.phase === 'build' && this.phaseT > 1.2 && this.lastCount === 0) {
      this.ctx.ui.countdown(null);
      this.lastCount = -2;
    } else if (this.phaseT > 1.6 && (this.phase === 'loop' || this.phase === 'back')) this.ctx.ui.countdown(null);
    else if (this.phase === 'settle' && this.phaseT < 0.1) this.ctx.ui.countdown(null);

    const loopN = Math.min(this.phase === 'loop' ? LOOPS : BACK_LOOPS, Math.floor(Math.abs(this.theta - this.rev0) / (Math.PI * 2)) + 1);
    const status =
      this.phase === 'board'
        ? 'Boarding'
        : this.phase === 'build'
          ? `Swinging ${Math.round(THREE.MathUtils.radToDeg(Math.abs(Math.acos(THREE.MathUtils.clamp(-this.energy / W0, -1, 1)))))}°`
          : this.phase === 'loop'
            ? `Loop ${loopN}/${LOOPS}`
            : this.phase === 'hang'
              ? 'Upside down!'
              : this.phase === 'back'
                ? `Backwards ${loopN}/${BACK_LOOPS}`
                : 'Swinging home';
    this.ctx.ui.score(`🛸 ${status} · ${this.gSmooth.toFixed(1)} g · ${Math.round(this.altitude)} m · ${CAM_LABEL[this.cam]} cam`);
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const w = this.swing.matrixWorld;
    if (this.cam === 'seat' || this.cam === 'onboard') {
      let eye: THREE.Vector3;
      let look: THREE.Vector3;
      let up: THREE.Vector3;
      if (this.cam === 'seat') {
        // your own seat: facing out over the park; the horizon rolls right round
        const seat = this.seats[MY_SEAT];
        eye = new THREE.Vector3(0, 0.86, 0.26).applyMatrix4(seat.matrixWorld);
        const dir = new THREE.Vector3(0, -0.28, 1).normalize().applyAxisAngle(UP, this.yaw);
        const q = new THREE.Quaternion().setFromRotationMatrix(seat.matrixWorld);
        look = eye.clone().add(dir.applyQuaternion(q));
        up = UP.clone().applyQuaternion(q);
      } else {
        // a camera rigged off the arm, out past the A-frame, looking back at the boat
        const q = new THREE.Quaternion().setFromRotationMatrix(w);
        eye = new THREE.Vector3(Math.sin(this.yaw) * 6, -7.5, 10.5).applyMatrix4(w);
        look = new THREE.Vector3(0, -R_IN, 0).applyMatrix4(w);
        up = UP.clone().applyQuaternion(q);
      }
      camera.up.copy(up);
      camera.position.copy(eye);
      camera.lookAt(look);
      this.camPos.copy(eye);
      this.camLook.copy(look);
      return;
    }
    // from the queue: the whole ride, looking up
    camera.up.set(0, 1, 0);
    const k = 1 - Math.exp(-dt * 3);
    const pos = new THREE.Vector3(12 + Math.sin(this.yaw) * 20, 4, FENCE.z + 26).applyMatrix4(this.root.matrixWorld);
    const look = new THREE.Vector3(0, 12, 0).applyMatrix4(this.root.matrixWorld);
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
  }

  /** Ground point under the boat (for shadows and grass LOD). */
  get focus() {
    return new THREE.Vector3(this.pivot.x, 0, this.pivot.z);
  }
}
