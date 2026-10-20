import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { staticBox, std, type Ctx } from '../context';
import type { Coaster } from '../attractions/coaster';
import type { Striker } from '../attractions/striker';
import { FAIR_DISTRICTS, LAYOUT, PARK, PLAZAS, PROMENADE } from '../layout';
import { mulberry } from '../random';
import { nearTrack } from '../rides';
import { NavGraph } from './nav';
import { Obstacles } from './obstacles';
import { randomLook, type Look, type PeopleFactory, type PersonRig } from './people';
import { Dog, Leash, type DogFactory } from './pets';

// The park's guests. Everyone belongs to a party (on their own, a couple, friends, or a family
// with children, sometimes with a dog). Each party leader runs a little "day out" script —
// stroll somewhere, queue for a coaster and ride it, watch a ride, sit on a bench, try the
// High Striker, buy tickets, let the kids play — written as generators, one step per frame.
// Everyone else in the party follows the leader around, or joins in.

type P = { x: number; z: number };
type Task = Generator<void, void, void>;

const rnd = mulberry(4242);
const R = (a: number, b: number) => a + rnd() * (b - a);
const chance = (p: number) => rnd() < p;

// ------------------------------------------------------------------------------------ queues

/** A line of people along a polyline; slot 0 is the front. */
class Queue {
  people: Guest[] = [];
  private cum: number[] = [0];
  constructor(
    readonly line: P[],
    readonly spacing = 0.8,
  ) {
    for (let i = 1; i < line.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z));
  }

  get capacity() {
    return Math.floor(this.cum[this.cum.length - 1] / this.spacing);
  }

  get full() {
    return this.people.length >= this.capacity - 1;
  }

  /** Where slot i stands, and which way it faces (toward the front). */
  slot(i: number, out: P & { heading: number }) {
    const d = Math.min(i * this.spacing, this.cum[this.cum.length - 1]);
    let k = 1;
    while (k < this.cum.length - 1 && this.cum[k] < d) k++;
    const a = this.line[k - 1];
    const b = this.line[k];
    const t = (d - this.cum[k - 1]) / Math.max(1e-6, this.cum[k] - this.cum[k - 1]);
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    out.heading = Math.atan2(-(a.x - b.x), -(a.z - b.z));
    return out;
  }

  join(g: Guest) {
    if (!this.people.includes(g)) this.people.push(g);
  }

  leave(g: Guest) {
    const i = this.people.indexOf(g);
    if (i >= 0) this.people.splice(i, 1);
  }
}

/** A coaster's queue, platform and seats: unloads and loads the ghost train on each stop. */
class RideStop {
  queue: Queue;
  riders = new Map<number, Guest>();
  /** Guests on their way from the queue to a seat. */
  boarding = new Set<Guest>();
  private phase: 'running' | 'unload' | 'load' = 'running';
  private t = 0;
  private fill = 1;
  private nextCall = 0;

  constructor(
    readonly coaster: Coaster,
    line: P[],
  ) {
    this.queue = new Queue(line);
    coaster.onDwell = (d) => {
      this.phase = d ? 'unload' : 'running';
      this.t = 0;
      this.fill = R(0.55, 1);
    };
    // the ghost train rides empty: the guests are the riders now
    for (const s of coaster.seats) s.puppet.visible = false;
  }

  /** Platform spot beside seat i (where guests step in and out). */
  spot(i: number, out = new THREE.Vector3()) {
    const st = this.coaster.station;
    const s = this.coaster.seatWorld(i, out);
    const o = (s.x - st.origin.x) * st.out.x + (s.z - st.origin.z) * st.out.z;
    return s.addScaledVector(st.out, 1.75 - o).setY(st.platformY);
  }

  update(dt: number) {
    if (!this.coaster.dwelling) {
      this.phase = 'running';
      return;
    }
    this.t += dt;
    if (this.phase === 'unload') {
      // riders get off first; the gates open for the queue once the platform is clear
      for (const g of this.riders.values()) g.alight = true;
      if (this.riders.size === 0 || this.t > 6) this.phase = 'load';
      return;
    }
    if (this.phase !== 'load') return;
    this.nextCall -= dt;
    const seats = this.coaster.seats.length;
    const taken = this.riders.size + this.boarding.size;
    if (this.nextCall <= 0 && this.queue.people.length && taken < Math.round(seats * this.fill) && this.coaster.dwellRemaining > 5) {
      // next in line takes the frontmost free seat; parties fill seats next to each other
      const g = this.queue.people[0];
      const head = this.queue.line[0];
      const ready = Math.hypot(g.x - head.x, g.z - head.z) < 2.5;
      for (let i = 0; i < seats && ready; i++) {
        if (this.riders.has(i) || [...this.boarding].some((b) => b.seatIndex === i)) continue;
        g.seatIndex = i;
        this.boarding.add(g);
        this.queue.leave(g);
        break;
      }
      this.nextCall = 0.45;
    }
    // the operator waits for everyone on the platform to sit down
    if (this.boarding.size) this.coaster.holdDwell(1.5);
  }
}

// ------------------------------------------------------------------------------------ benches

interface Bench {
  x: number;
  z: number;
  heading: number; // the way a sitter faces
  seats: (Guest | null)[];
}

function benchGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) parts.push(new THREE.BoxGeometry(1.8, 0.04, 0.09).translate(0, 0.45, -0.17 + i * 0.11));
  for (let i = 0; i < 3; i++) parts.push(new THREE.BoxGeometry(1.8, 0.09, 0.03).translate(0, 0.62 + i * 0.12, 0.25).rotateX(0));
  return mergeGeometries(parts)!;
}

function benchFrame() {
  const parts: THREE.BufferGeometry[] = [];
  for (const x of [-0.78, 0.78]) {
    parts.push(new THREE.BoxGeometry(0.06, 0.45, 0.06).translate(x, 0.225, -0.18));
    parts.push(new THREE.BoxGeometry(0.06, 0.9, 0.06).translate(x, 0.45, 0.25));
    parts.push(new THREE.BoxGeometry(0.06, 0.05, 0.5).translate(x, 0.43, 0.03));
    parts.push(new THREE.BoxGeometry(0.05, 0.05, 0.42).translate(x, 0.65, -0.02)); // arm rest
  }
  return mergeGeometries(parts)!;
}

// ------------------------------------------------------------------------------------ guests

interface Party {
  members: Guest[];
  leader: Guest;
  dog: Dog | null;
}

class Guest {
  x = 0;
  z = 0;
  y = 0;
  heading = 0;
  speed = 0;
  /** Preferred walking pace (m/s). */
  pace: number;
  /** Which side of the path this person keeps to (-1…1). */
  lane = R(-0.8, 0.8);
  task: Task | null = null;
  party!: Party;
  /** What the party is up to (for debugging). */
  activity = 'start';
  // steering
  route: (P & { y?: number })[] = [];
  ri = 0;
  /** Where the current route ends (to tell when a moving target needs a new route). */
  goal: P | null = null;
  /** Unstick: closest we've been to the current waypoint, and for how long no closer. */
  private best = Infinity;
  private bestT = 0;
  arriveR = 0.4;
  run = false;
  /** Position driven directly by a script (stairs, seats): no avoidance or ground snapping. */
  scripted = false;
  face: P | (() => P) | null = null;
  faceHeading: number | null = null;
  // rides
  seatIndex = -1;
  /** The seat this guest is riding in (while `ride` is set). */
  rideSeat = -1;
  ride: RideStop | null = null;
  alight = false;
  done = false;
  private animDt = 0;
  readonly hands: [THREE.Object3D, THREE.Object3D];

  constructor(
    readonly rig: PersonRig,
    readonly look: Look,
    readonly index: number,
  ) {
    this.hands = [rig.root.getObjectByName('hand_l')!, rig.root.getObjectByName('hand_r')!];
    this.pace = look.child ? R(1.0, 1.35) : R(0.95, 1.35);
  }

  get child() {
    return this.look.child;
  }

  get arrived() {
    return this.ri >= this.route.length;
  }

  setTask(t: Task) {
    this.task = t;
  }

  goTo(points: (P & { y?: number })[], arriveR = 0.4) {
    this.route = points;
    this.ri = 0;
    this.arriveR = arriveR;
    this.goal = points[points.length - 1] ?? null;
    this.best = Infinity;
  }

  resetProgress() {
    this.best = Infinity;
    this.bestT = 0;
  }

  /** Call each frame with the distance to the current waypoint: skips it if we're stuck. */
  progress(d: number, dt: number) {
    if (d < this.best - 0.15) {
      this.best = d;
      this.bestT = 0;
      return;
    }
    this.bestT += dt;
    if (this.bestT > 1.5) {
      // something's in the way: give up on this waypoint (or call it close enough)
      this.ri++;
      this.best = Infinity;
      this.bestT = 0;
    }
  }

  stop() {
    this.route = [];
    this.ri = 0;
  }

  /** Accumulated animation time for distance-based LOD updates. */
  animate(dt: number, every: number, frame: number) {
    this.animDt += dt;
    if ((frame + this.index) % every !== 0) return;
    this.rig.update(this.animDt, this.speed);
    this.animDt = 0;
  }
}

// ------------------------------------------------------------------------------------ crowd

export interface CrowdOptions {
  count: number;
  shadows: boolean;
}

/** Simulates and draws the park's guests and their dogs. */
export class Crowd {
  private nav = new NavGraph();
  private obs: Obstacles;
  private guests: Guest[] = [];
  private parties: Party[] = [];
  private dogs: { dog: Dog; owner: Guest; leash: Leash; slot: number }[] = [];
  private stops: RideStop[];
  private booth: Queue;
  private strikerQ: Queue;
  private benches: Bench[] = [];
  private frame = 0;
  private frustum = new THREE.Frustum();
  private mat4 = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private tmpV = new THREE.Vector3();
  private watchSpots: { at: P; look: () => P & { y?: number } }[];
  private player: { position: THREE.Vector3 } | null = null;

  constructor(
    private ctx: Ctx,
    private people: PeopleFactory,
    private dogFactory: DogFactory | null,
    coasters: Coaster[],
    private striker: Striker,
    private opts: CrowdOptions,
  ) {
    this.obs = new Obstacles(ctx.world);
    this.buildBenches(); // (benches are obstacles too: place them before routing round things)
    this.nav.repair(this.obs, LAYOUT.spawn);

    this.stops = coasters.map((c) => {
      const st = c.station;
      // the line starts at the foot of the entrance stairs and backs up along the path
      const foot = { x: st.entryFoot.x, z: st.entryFoot.z };
      const out = { x: st.entryFoot.x + st.out.x * 1.6, z: st.entryFoot.z + st.out.z * 1.6 };
      const route = this.nav.route(this.nav.nearest(out.x, out.z).id, this.nav.nearest(LAYOUT.carousel.x, LAYOUT.carousel.z).id).slice(0, 5);
      return new RideStop(c, [foot, out, ...route]);
    });
    // ticket booth: the window faces south, the line runs back along the spur
    const b = LAYOUT.booth;
    this.booth = new Queue([{ x: b.x, z: b.z + 2.6 }, { x: b.x, z: b.z + 6 }, { x: b.x - 4, z: b.z + 6.2 }, { x: b.x - 9, z: b.z + 6.2 }], 0.85);
    const ss = striker.swingSpot;
    this.strikerQ = new Queue([{ x: ss.x, z: ss.z }, { x: ss.x + 0.2, z: ss.z + 1.6 }, { x: ss.x + 0.6, z: ss.z + 6 }], 0.9);

    const [stack, falcon] = coasters;
    // each spot is set from its attraction, wherever the layout puts it
    const by = (a: P, dx: number, dz: number) => ({ x: a.x + dx, z: a.z + dz });
    const { striker: sx, rocket: rk, carousel: cs, letters: lt, crates: cr, ship: sh, flip: fl, ducks: dk } = LAYOUT;
    this.watchSpots = [
      { at: by(LAYOUT.coaster, 13, 10), look: () => stack.trainPosition },
      { at: by(LAYOUT.coaster, 17, 5), look: () => stack.trainPosition },
      { at: by(LAYOUT.falcon, -18, -4), look: () => falcon.trainPosition },
      { at: by(LAYOUT.falcon, -30, -6.5), look: () => falcon.trainPosition },
      { at: by(rk, -4, 18), look: () => ({ x: rk.x, y: 8, z: rk.z }) },
      { at: by(rk, 4, 17), look: () => ({ x: rk.x, y: 8, z: rk.z }) },
      { at: by(sx, 3.5, 5.5), look: () => ({ x: sx.x, y: 3, z: sx.z }) },
      { at: by(sx, -3, 5), look: () => ({ x: sx.x, y: 3, z: sx.z }) },
      { at: by(cs, 9.5, 3), look: () => ({ x: cs.x, y: 2, z: cs.z }) },
      { at: by(cs, -9, -3), look: () => ({ x: cs.x, y: 2, z: cs.z }) },
      { at: by(lt, 4, 7), look: () => ({ x: lt.x, y: 2, z: lt.z }) },
      { at: by(lt, -5, 8), look: () => ({ x: lt.x, y: 2, z: lt.z }) },
      { at: by(cr, -4, 11), look: () => ({ x: cr.x, y: 1, z: cr.z }) },
      { at: by(sh, -7, -15.5), look: () => ({ x: sh.x, y: 9, z: sh.z }) },
      { at: by(sh, 6, -15), look: () => ({ x: sh.x, y: 9, z: sh.z }) },
      { at: by(fl, 22, 17), look: () => ({ x: fl.x, y: 40, z: fl.z }) },
      { at: by(dk, 4.5, -8.5), look: () => ({ x: dk.x, y: 2.5, z: dk.z }) },
    ].filter((w) => !this.obs.inside(w.at.x, w.at.z, 0.5));

    this.spawn(opts.count);
  }

  setPlayer(p: { position: THREE.Vector3 }) {
    this.player = p;
  }

  // ---------------------------------------------------------------- setup

  private buildBenches() {
    const spots: { x: number; z: number; heading: number }[] = [];
    // along Main Street and North Avenue, facing them
    for (const z of [-3, -27, -76, -88, -100, -126, -150, -162]) for (const sx of [-1, 1]) spots.push({ x: PARK.x + sx * 5.4, z, heading: sx > 0 ? -Math.PI / 2 : Math.PI / 2 });
    // halfway along each stretch of the Promenade, on its outer side, facing it
    for (let i = 0; i < PROMENADE.length - 1; i++) {
      const [ax, az] = PROMENADE[i];
      const [bx, bz] = PROMENADE[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 30) continue;
      let nx = -(bz - az) / len;
      let nz = (bx - ax) / len;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if (nx * (mx - PARK.x) + nz * (mz - PARK.z) < 0) (nx = -nx), (nz = -nz);
      for (const t of [-0.18, 0.18]) {
        const x = mx + (bx - ax) * t + nx * 3.6;
        const z = mz + (bz - az) * t + nz * 3.6;
        spots.push({ x, z, heading: Math.atan2(nx, nz) });
      }
    }
    // a pair at each of the fair's district plazas, facing it (the airport and Palm Cay have people of their own)
    for (const { plaza: [px, pz] } of FAIR_DISTRICTS)
      for (const a of [(3 * Math.PI) / 4, -Math.PI / 4]) {
        const x = px + Math.cos(a) * 10.6;
        const z = pz + Math.sin(a) * 10.6;
        spots.push({ x, z, heading: Math.atan2(x - px, z - pz) });
      }
    // round the carousel plaza, facing the carousel
    for (const a of [0.6, 2.5, 3.8, 5.6]) {
      // outside the ring of waypoints walkers use to get round the carousel
      const x = LAYOUT.carousel.x + Math.cos(a) * 11.8;
      const z = LAYOUT.carousel.z + Math.sin(a) * 11.8;
      spots.push({ x, z, heading: Math.atan2(x - LAYOUT.carousel.x, z - LAYOUT.carousel.z) });
    }
    // the entrance plaza (facing out from its middle, like the old ones) and the crates plaza
    const [ex, ez] = PLAZAS[0];
    spots.push({ x: ex - 9.5, z: ez + 7, heading: Math.atan2(-9.5, 7) }, { x: ex + 9.5, z: ez - 6, heading: Math.atan2(9.5, -6) });
    spots.push({ x: LAYOUT.crates.x, z: LAYOUT.crates.z + 16.5, heading: 0 });
    const ok = spots.filter((s) => !this.obs.inside(s.x, s.z, 1.1) && !nearTrack(s.x, s.z, 3));
    const wood = new THREE.InstancedMesh(benchGeometry(), std('#a4683b', { roughness: 0.8 }), ok.length);
    const iron = new THREE.InstancedMesh(benchFrame(), std('#2b2b30', { roughness: 0.45, metalness: 0.6 }), ok.length);
    const m = new THREE.Matrix4();
    ok.forEach((s, i) => {
      // the bench model faces -z; a sitter faces `heading` (the park's -z-forward convention)
      m.makeRotationY(s.heading).setPosition(s.x, 0, s.z);
      wood.setMatrixAt(i, m);
      iron.setMatrixAt(i, m);
      staticBox(this.ctx, s.x, 0.4, s.z, 0.95, 0.4, 0.3, s.heading);
      this.benches.push({ ...s, seats: [null, null, null] });
    });
    for (const im of [wood, iron]) {
      im.castShadow = im.receiveShadow = true;
      this.ctx.scene.add(im);
    }
    // the benches are solid now too
    this.obs = new Obstacles(this.ctx.world);
  }

  private makeGuest(look: Look) {
    const rig = this.people.create(look);
    rig.setShadows(this.opts.shadows);
    const g = new Guest(rig, look, this.guests.length);
    this.ctx.scene.add(rig.root);
    this.guests.push(g);
    return g;
  }

  private spawn(total: number) {
    let n = 0;
    while (n < total) {
      const roll = rnd();
      const looks: Look[] = [];
      if (roll < 0.3) looks.push(randomLook(rnd));
      else if (roll < 0.52) {
        const a = randomLook(rnd);
        looks.push(a, randomLook(rnd, { gender: chance(0.8) ? (a.gender === 'm' ? 'f' : 'm') : a.gender }));
      } else if (roll < 0.88) {
        // a family: one or two grown-ups and up to three children
        looks.push(randomLook(rnd, { age: 'young' }));
        if (chance(0.7)) looks.push(randomLook(rnd, { gender: looks[0].gender === 'm' ? 'f' : 'm', age: 'young' }));
        const kids = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < kids; k++) looks.push(randomLook(rnd, { child: true }));
      } else for (let k = 0; k < 3; k++) looks.push(randomLook(rnd, { age: 'young' }));
      const members = looks.slice(0, Math.max(1, total - n)).map((l) => this.makeGuest(l));
      n += members.length;
      const party: Party = { members, leader: members[0], dog: null };
      for (const m of members) m.party = party;
      this.parties.push(party);
      // place them together somewhere in the park
      const at = this.nav.random(rnd, PARK.r - 5);
      members.forEach((m, i) => this.place(m, at.x + R(-1.5, 1.5) + i * 0.3, at.z + R(-1.5, 1.5), R(-Math.PI, Math.PI)));
      if (this.dogFactory && members.length <= 4 && chance(members.length === 1 ? 0.22 : 0.2)) {
        const dog = this.dogFactory.create(chance(0.55) ? 'shiba' : 'husky');
        dog.place(at.x + 1, at.z, 0);
        dog.setShadows(this.opts.shadows);
        this.ctx.scene.add(dog.root);
        const leash = new Leash(chance(0.5) ? '#c0392b' : '#24324f');
        this.ctx.scene.add(leash.line);
        party.dog = dog;
        this.dogs.push({ dog, owner: party.leader, leash, slot: chance(0.5) ? 1 : -1 });
      }
      party.leader.setTask(this.life(party));
      for (const m of members) if (m !== party.leader) m.setTask(this.follow(m));
    }
  }

  private place(g: Guest, x: number, z: number, heading: number) {
    const p = { x, z };
    this.obs.push(p, 0.4);
    g.x = p.x;
    g.z = p.z;
    g.heading = heading;
  }

  // ---------------------------------------------------------------- routing

  /** A walking route along the paths from where the guest is to (x, z). */
  private routeTo(g: Guest, x: number, z: number) {
    const a = this.nav.nearest(g.x, g.z);
    const b = this.nav.nearest(x, z);
    const nodes = this.nav.route(a.id, b.id);
    const pts: P[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      // keep to your own side of the path
      const prev = nodes[Math.max(0, i - 1)];
      const next = nodes[Math.min(nodes.length - 1, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const l = Math.hypot(dx, dz) || 1;
      const off = g.lane * Math.min(2.2, n.half * 0.65);
      const p = { x: n.x + (-dz / l) * off, z: n.z + (dx / l) * off };
      this.obs.push(p, 0.5);
      pts.push(p);
    }
    // skip a first node that's behind us
    if (pts.length > 1 && Math.hypot(pts[1].x - g.x, pts[1].z - g.z) < Math.hypot(pts[1].x - pts[0].x, pts[1].z - pts[0].z)) pts.shift();
    pts.push({ x, z });
    return pts;
  }

  /** Head for a (possibly moving) spot: along the paths when far, straight there when close. */
  private seek(g: Guest, p: P, r: number) {
    const far = Math.hypot(p.x - g.x, p.z - g.z);
    if (far > 4) {
      // plan a route once; only re-plan when the spot has moved on or the route ran out
      if (g.arrived || !g.goal || Math.hypot(g.goal.x - p.x, g.goal.z - p.z) > 1.5) g.goTo(this.routeTo(g, p.x, p.z), r);
    } else if (far > r * 0.5) g.goTo([{ x: p.x, z: p.z }], r);
    else g.stop();
    return far;
  }

  // ---------------------------------------------------------------- behaviour steps

  private *walkTo(g: Guest, x: number, z: number, run = false, r = 0.4): Task {
    g.goTo(this.routeTo(g, x, z), r);
    g.run = run;
    g.face = null;
    g.faceHeading = null;
    while (!g.arrived) yield;
    g.run = false;
  }

  private *wait(seconds: number): Task {
    let t = seconds;
    while ((t -= this.dt) > 0) yield;
  }

  /** Walk straight to a point along a scripted line (stairs, platforms), height blending too. */
  private *glide(g: Guest, to: THREE.Vector3, speed: number, turn = true): Task {
    g.scripted = true;
    const from = new THREE.Vector3(g.x, g.y, g.z);
    const len = from.distanceTo(to);
    const dur = Math.max(0.15, len / speed);
    if (turn && Math.hypot(to.x - from.x, to.z - from.z) > 0.05) g.faceHeading = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    for (let t = 0; t < dur; t += this.dt) {
      const k = t / dur;
      g.x = from.x + (to.x - from.x) * k;
      g.y = from.y + (to.y - from.y) * k;
      g.z = from.z + (to.z - from.z) * k;
      g.speed = len / dur;
      yield;
    }
    g.x = to.x;
    g.y = to.y;
    g.z = to.z;
    g.speed = 0;
  }

  /** Followers: stay beside/behind the leader, look where they look. */
  private *follow(g: Guest): Task {
    const p = g.party;
    const k = p.members.indexOf(g);
    const side = k % 2 ? 1 : -1;
    const row = Math.ceil(k / 2);
    for (;;) {
      const L = p.leader;
      const c = Math.cos(L.heading);
      const s = Math.sin(L.heading);
      // in the leader's frame: right is (c, -s), behind is (s, c)
      const ox = side * 0.75 * row;
      const oz = 0.35 * row;
      const tx = L.x + ox * c + oz * s;
      const tz = L.z - ox * s + oz * c;
      const d = Math.hypot(tx - g.x, tz - g.z);
      this.seek(g, { x: tx, z: tz }, 0.35);
      g.run = d > 3 && (g.child || d > 6);
      g.face = L.speed < 0.1 ? L.face : null;
      if (L.speed < 0.1 && !g.face) g.faceHeading = L.faceHeading ?? L.heading;
      else if (L.speed >= 0.1) g.faceHeading = null;
      yield;
    }
  }

  /** The party leader's day out. */
  private *life(p: Party): Task {
    const L = p.leader;
    yield* this.wait(R(0, 3));
    for (;;) {
      const kids = p.members.filter((m) => m.child);
      const pick = rnd();
      const free = (q: Queue) => !q.full && q.people.length + p.members.length < q.capacity;
      // most people pick the ride with the shorter wait (per seat on the train)
      const waits = this.stops.map((st) => st.queue.people.length / st.coaster.seats.length);
      const shorter = waits.indexOf(Math.min(...waits));
      const stop = this.stops[chance(0.7) ? shorter : Math.floor(rnd() * this.stops.length)];
      const act = (a: string) => (L.activity = a);
      if (!p.dog && pick < 0.24 && stop && free(stop.queue)) act(`coaster:${this.stops.indexOf(stop)}`), yield* this.coasterTrip(p, stop);
      else if (kids.length && pick < 0.46) act('play'), yield* this.play(p);
      else if (pick < 0.58 && this.watchSpots.length) act('watch'), yield* this.watch(p);
      else if (pick < 0.68 && p.members.length <= 3) act('bench'), yield* this.bench(p);
      else if (pick < 0.74 && free(this.strikerQ)) act('striker'), yield* this.strike(p);
      else if (pick < 0.79 && free(this.booth)) act('tickets'), yield* this.tickets(p);
      else if (pick < 0.86 && p.members.length >= 2) act('chat'), yield* this.chat(p);
      else {
        act('stroll');
        // stroll: mostly inside the park, now and then out along the road to the wheel
        const to = this.nav.random(rnd, chance(0.9) ? PARK.r - 10 : Infinity);
        yield* this.walkTo(L, to.x + R(-1, 1), to.z + R(-1, 1));
        yield* this.wait(R(0.5, 4));
      }
    }
  }

  private *watch(p: Party): Task {
    const w = this.watchSpots[Math.floor(rnd() * this.watchSpots.length)];
    const L = p.leader;
    yield* this.walkTo(L, w.at.x + R(-1.2, 1.2), w.at.z + R(-1.2, 1.2));
    L.face = w.look;
    const end = R(10, 25);
    for (let t = 0; t < end; t += this.dt) {
      // the odd photo or a wave at the riders
      if (chance(this.dt * 0.08)) L.rig.play('Interact');
      else if (chance(this.dt * 0.05)) L.rig.wave();
      yield;
    }
    L.face = null;
  }

  private *chat(p: Party): Task {
    const L = p.leader;
    yield* this.wait(1.2); // let the others catch up
    const c = p.members.reduce((a, m) => ({ x: a.x + m.x / p.members.length, z: a.z + m.z / p.members.length }), { x: 0, z: 0 });
    for (const m of p.members) {
      if (m === L) continue;
      m.setTask(this.idleAt(m, c));
    }
    L.face = c;
    const end = R(8, 16);
    for (let t = 0; t < end; t += this.dt) {
      const talker = p.members[Math.floor((t / 3) % p.members.length)];
      for (const m of p.members) if (!m.child) m.rig.setBase(m === talker ? 'talk' : 'stand');
      yield;
    }
    for (const m of p.members) {
      m.rig.setBase('stand');
      m.face = null;
      if (m !== L) m.setTask(this.follow(m));
    }
  }

  /** Stand still (facing a point) until reassigned. */
  private *idleAt(g: Guest, look: P): Task {
    g.stop();
    g.face = look;
    for (;;) yield;
  }

  private *bench(p: Party): Task {
    const free = this.benches.filter((b) => b.seats.filter((x) => !x).length >= p.members.length);
    if (!free.length) return;
    const L = p.leader;
    let b = free[0];
    for (const c of free) if (Math.hypot(c.x - L.x, c.z - L.z) < Math.hypot(b.x - L.x, b.z - L.z)) b = c;
    const seats: number[] = [];
    for (let i = 0; i < 3 && seats.length < p.members.length; i++) if (!b.seats[i]) seats.push(i);
    const sitters = p.members.slice(0, seats.length);
    sitters.forEach((m, k) => (b.seats[seats[k]] = m));
    const crowd = this;
    sitters.forEach((m, k) => {
      if (m !== L)
        m.setTask(
          (function* () {
            yield* crowd.sitOnBench(m, b, seats[k]);
            for (;;) yield;
          })(),
        );
    });
    yield* this.sitOnBench(L, b, seats[0]);
    yield* this.wait(R(15, 35));
    // stand up together
    sitters.forEach((m, k) => {
      b.seats[seats[k]] = null;
      m.rig.setBase('stand');
      m.y = 0;
      m.scripted = false;
      if (m !== L) m.setTask(this.follow(m));
    });
    yield* this.wait(0.6);
  }

  private *sitOnBench(m: Guest, b: Bench, i: number): Task {
    const fx = -Math.sin(b.heading);
    const fz = -Math.cos(b.heading);
    const rx = Math.cos(b.heading);
    const rz = -Math.sin(b.heading);
    const off = (i - 1) * 0.6;
    yield* this.walkTo(m, b.x + fx * 0.75 + rx * off, b.z + fz * 0.75 + rz * off, false, 0.15);
    m.faceHeading = b.heading;
    yield* this.wait(0.5);
    m.rig.setBase('sit');
    // back into the seat (facing away from the backrest)
    yield* this.glide(m, new THREE.Vector3(b.x + fx * 0.06 + rx * off, 0.47 - m.rig.seatDrop, b.z + fz * 0.06 + rz * off), 0.5, false);
  }

  private *strike(p: Party): Task {
    const q = this.strikerQ;
    const L = p.leader;
    // one of the party has a go (usually a grown-up); the rest watch
    const hitter = p.members.find((m) => !m.child && chance(0.5)) ?? L;
    if (hitter === L) {
      yield* this.queueTurn(L, q, () => this.swing(L));
      L.done = false;
      return;
    }
    const crowd = this;
    hitter.setTask(
      (function* () {
        yield* crowd.queueTurn(hitter, q, () => crowd.swing(hitter));
        for (;;) yield;
      })(),
    );
    const ss = this.striker.swingSpot;
    yield* this.walkTo(L, ss.x + 3, ss.z + 2.5);
    L.face = { x: LAYOUT.striker.x, z: LAYOUT.striker.z };
    for (let t = 0; t < 90 && !hitter.done; t += this.dt) yield;
    hitter.done = false;
    hitter.setTask(this.follow(hitter));
    L.face = null;
  }

  private *swing(g: Guest): Task {
    const s = this.striker.swingSpot;
    yield* this.glide(g, new THREE.Vector3(s.x, 0, s.z), 1.2);
    g.scripted = false;
    g.faceHeading = 0;
    while (!this.striker.free) yield;
    yield* this.wait(0.5);
    g.rig.play('Punch_Cross', 0.8);
    yield* this.wait(0.35);
    const power = g.child ? R(0.2, 0.7) : R(0.45, 1);
    this.striker.guestSwing(power);
    yield* this.wait(1.6);
    if (power > 0.96) g.rig.armsUp = 1; // rang the bell!
    yield* this.wait(1.4);
    g.rig.armsUp = 0;
  }

  /** Join a queue, shuffle forward, take your turn when you reach the front, then leave. */
  private *queueTurn(g: Guest, q: Queue, turn: () => Task): Task {
    q.join(g);
    const slot = { x: 0, z: 0, heading: 0 };
    for (;;) {
      const i = q.people.indexOf(g);
      q.slot(i, slot);
      const far = this.seek(g, slot, 0.25);
      if (far < 0.4) g.faceHeading = slot.heading;
      if (i === 0 && far < 0.5) break;
      yield;
    }
    yield* turn();
    q.leave(g);
    g.done = true;
    g.scripted = false;
    g.faceHeading = null;
  }

  private *tickets(p: Party): Task {
    const L = p.leader;
    for (const m of p.members) if (m !== L) m.setTask(this.follow(m));
    yield* this.queueTurn(L, this.booth, () =>
      function* (this: Crowd) {
        L.faceHeading = 0; // facing the window, north
        yield* this.wait(0.6);
        L.rig.play('Interact');
        yield* this.wait(R(3, 6));
      }.call(this),
    );
    L.done = false;
  }

  /** Children run around a nearby plaza (tag, jumping, dancing); the grown-ups watch. */
  private *play(p: Party): Task {
    const L = p.leader;
    let best = PLAZAS[0];
    for (const pl of PLAZAS) if (Math.hypot(pl[0] - L.x, pl[1] - L.z) < Math.hypot(best[0] - L.x, best[1] - L.z)) best = pl;
    const [px, pz, pr] = best;
    yield* this.walkTo(L, px + pr * 0.7, pz + R(-1, 1));
    const kids = p.members.filter((m) => m.child);
    const adults = p.members.filter((m) => !m.child && m !== L);
    const centre = { x: px, z: pz };
    L.face = centre;
    for (const a of adults) a.setTask(this.idleAt(a, centre));
    for (const k of kids) k.setTask(this.kidPlay(k, px, pz, pr * 0.75));
    yield* this.wait(R(20, 40));
    L.face = null;
    for (const m of p.members) if (m !== L) {
      m.rig.setBase('stand');
      m.setTask(this.follow(m));
    }
  }

  private *kidPlay(g: Guest, cx: number, cz: number, r: number): Task {
    for (;;) {
      const roll = rnd();
      if (roll < 0.65) {
        // dash somewhere else in the plaza
        const a = R(0, Math.PI * 2);
        const d = Math.sqrt(rnd()) * r;
        const p = { x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d };
        this.obs.push(p, 0.5);
        g.goTo([p], 0.5);
        g.run = chance(0.75);
        let t = 0;
        while (!g.arrived && (t += this.dt) < 6) yield;
        g.run = false;
      } else if (roll < 0.82) {
        g.stop();
        yield* this.wait(g.rig.play('Jump_Start'));
        yield* this.wait(g.rig.play('Jump_Land'));
      } else if (roll < 0.9) {
        g.stop();
        g.rig.setBase('dance');
        yield* this.wait(R(3, 6));
        g.rig.setBase('stand');
      } else {
        g.stop();
        yield* this.wait(R(0.5, 2));
      }
    }
  }

  private *coasterTrip(p: Party, stop: RideStop): Task {
    const L = p.leader;
    // everyone joins the line together, in order, so they get seats side by side
    for (const m of p.members) stop.queue.join(m);
    for (const m of p.members) if (m !== L) m.setTask(this.ride(m, stop));
    yield* this.ride(L, stop);
    // wait at the exit until the whole party is off the ride
    for (let t = 0; t < 120 && p.members.some((m) => !m.done && m !== L); t += this.dt) yield;
    for (const m of p.members) {
      m.done = false;
      if (m !== L) m.setTask(this.follow(m));
    }
  }

  private meetPoint(stop: RideStop): P {
    const st = stop.coaster.station;
    return { x: st.exitFoot.x + st.out.x * 1.8, z: st.exitFoot.z + st.out.z * 1.8 };
  }

  /** One guest's coaster ride: queue, climb to the platform, sit, ride, get off, leave. */
  private *ride(g: Guest, stop: RideStop): Task {
    const q = stop.queue;
    const st = stop.coaster.station;
    const slot = { x: 0, z: 0, heading: 0 };
    g.done = false;
    // ---- queue until the operator calls you to a seat
    while (g.seatIndex < 0) {
      const i = q.people.indexOf(g);
      if (i < 0) q.join(g);
      q.slot(Math.max(0, i), slot);
      const far = this.seek(g, slot, 0.25);
      if (far < 0.4) g.faceHeading = slot.heading;
      yield;
    }
    const seat = g.seatIndex;
    // ---- up the entrance stairs, along the platform, into the seat
    g.stop();
    yield* this.glide(g, st.entryFoot, g.pace);
    yield* this.glide(g, st.entryTop, g.pace * 0.7);
    const spot = stop.spot(seat);
    yield* this.glide(g, spot, g.pace);
    let ok = stop.coaster.dwelling;
    if (ok) {
      // turn to the car and sit down into the seat
      const seatPos = stop.coaster.seatWorld(seat, new THREE.Vector3());
      g.faceHeading = Math.atan2(-(seatPos.x - spot.x), -(seatPos.z - spot.z));
      yield* this.wait(0.25);
      g.rig.setBase('sit');
      const target = seatPos.clone();
      target.y -= g.rig.seatDrop;
      yield* this.glide(g, target, 1.2, false);
      ok = stop.coaster.dwelling;
    }
    stop.boarding.delete(g);
    g.seatIndex = -1;
    if (ok) {
      // ---- ride! (positioned on the seat every frame by update())
      stop.riders.set(seat, g);
      g.ride = stop;
      g.rideSeat = seat;
      g.alight = false;
      while (!g.alight) yield;
      // one row at a time, front first, so nobody collides on the stairs
      yield* this.wait(0.15 + seat * 0.45);
      // ---- off at the next stop: stand up onto the platform, out via the exit stairs
      g.ride = null;
      stop.riders.delete(seat);
      g.rig.armsUp = 0;
      const out = stop.spot(seat);
      g.rig.setBase('stand');
      yield* this.glide(g, out, 1.2, false);
    } else g.rig.setBase('stand'); // the train left without us: give up and leave
    yield* this.glide(g, st.exitTop, g.pace);
    yield* this.glide(g, st.exitFoot, g.pace * 0.7);
    g.scripted = false;
    g.y = 0;
    const meet = this.meetPoint(stop);
    g.goTo([{ x: meet.x + R(-1.2, 1.2), z: meet.z + R(-1.2, 1.2) }], 0.4);
    while (!g.arrived) yield;
    g.done = true;
    for (;;) {
      if (g === g.party.leader) return;
      yield;
    }
  }

  // ---------------------------------------------------------------- per frame

  private dt = 0;

  update(dt: number) {
    this.dt = dt;
    this.frame++;
    for (const s of this.stops) s.update(dt);
    for (const g of this.guests) g.task?.next();
    this.move(dt);
    this.updateDogs(dt);
    this.render(dt);
  }

  private move(dt: number) {
    const pl = this.player?.position;
    for (const g of this.guests) {
      if (g.ride) {
        this.sitOnRide(g);
        g.rig.armsUp += ((g.ride.coaster.thrill ? 1 : 0) - g.rig.armsUp) * Math.min(1, dt * 5);
        continue;
      }
      if (!g.scripted) {
        let vx = 0;
        let vz = 0;
        let want = 0;
        if (!g.arrived) {
          const t = g.route[g.ri];
          const dx = t.x - g.x;
          const dz = t.z - g.z;
          const d = Math.hypot(dx, dz);
          const last = g.ri === g.route.length - 1;
          if (d < (last ? g.arriveR : 1.1)) {
            g.ri++;
            g.resetProgress();
          }
          else {
            g.progress(d, dt);
            want = g.run ? (g.child ? R(2.6, 3.2) : 3) : g.pace;
            if (last) want = Math.min(want, 0.3 + d * 1.2);
            vx = dx / d;
            vz = dz / d;
          }
        }
        // personal space: ease away from neighbours (and give the visitor room)
        let px = 0;
        let pz = 0;
        for (const o of this.guests) {
          if (o === g || o.ride || o.scripted) continue;
          const dx = g.x - o.x;
          const dz = g.z - o.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 0.5 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const push = (0.71 - d) / 0.71;
          px += (dx / d) * push;
          pz += (dz / d) * push;
        }
        if (pl) {
          const dx = g.x - pl.x;
          const dz = g.z - pl.z;
          const d = Math.hypot(dx, dz);
          if (d < 1.3 && d > 1e-4) {
            px += (dx / d) * (1.3 - d) * 3;
            pz += (dz / d) * (1.3 - d) * 3;
          }
        }
        g.speed += (want - g.speed) * Math.min(1, dt * 5);
        g.x += vx * g.speed * dt + px * dt * 1.2;
        g.z += vz * g.speed * dt + pz * dt * 1.2;
        this.obs.push(g, 0.3);
        g.y = 0;
        if (g.speed > 0.15) this.turn(g, Math.atan2(-vx, -vz), dt, 7);
      }
      if (g.speed <= 0.15 || g.scripted) {
        const f = typeof g.face === 'function' ? g.face() : g.face;
        if (f) this.turn(g, Math.atan2(-(f.x - g.x), -(f.z - g.z)), dt, 3);
        else if (g.faceHeading !== null) this.turn(g, g.faceHeading, dt, 4);
      }
      g.rig.root.position.set(g.x, g.y, g.z);
      g.rig.root.rotation.set(0, g.heading, 0);
    }
  }

  private turn(g: Guest, to: number, dt: number, rate: number) {
    let d = to - g.heading;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    g.heading += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  /** Riders sit in their seat, moving (and rolling) with the car. */
  private sitOnRide(g: Guest) {
    const stop = g.ride!;
    const seat = stop.coaster.seats[g.rideSeat];
    const m = seat.car.matrix;
    this.tmpV.set(seat.local.x, seat.local.y - g.rig.seatDrop, seat.local.z + 0.08).applyMatrix4(m);
    g.x = this.tmpV.x;
    g.y = this.tmpV.y;
    g.z = this.tmpV.z;
    g.speed = 0;
    g.rig.root.position.copy(this.tmpV);
    g.rig.root.quaternion.setFromRotationMatrix(this.mat4.extractRotation(m));
  }

  private updateDogs(dt: number) {
    const hand = new THREE.Vector3();
    const collar = new THREE.Vector3();
    for (const d of this.dogs) {
      const o = d.owner;
      const c = Math.cos(o.heading);
      const s = Math.sin(o.heading);
      // walk at heel, a little ahead and to the side
      const ox = d.slot * 0.75;
      const oz = o.speed > 0.2 ? -0.5 : 0.3;
      const tx = o.x + ox * c + oz * s;
      const tz = o.z - ox * s + oz * c;
      d.dog.steer(dt, tx, tz, o.speed);
      if (d.dog.speed < 0.1) d.dog.face(o.x, o.z, dt);
      d.dog.animate(dt);
      // leash from the owner's hand to the collar
      o.hands[d.slot > 0 ? 1 : 0].getWorldPosition(hand);
      d.dog.neck.getWorldPosition(collar);
      d.leash.update(hand, collar);
      d.leash.line.visible = d.dog.root.visible;
    }
  }

  private render(dt: number) {
    const cam = this.ctx.camera;
    this.frustum.setFromProjectionMatrix(this.mat4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const cp = cam.position;
    for (const g of this.guests) {
      const d = Math.hypot(g.x - cp.x, g.y - cp.y, g.z - cp.z);
      this.sphere.center.set(g.x, g.y + g.look.height / 2, g.z);
      this.sphere.radius = g.look.height;
      const inView = this.frustum.intersectsSphere(this.sphere);
      const visible = d < 160 && (inView || d < 10);
      g.rig.root.visible = visible;
      if (!visible) continue;
      g.rig.setDetail(d < 22);
      g.animate(dt, d < 30 ? 1 : d < 70 ? 2 : 4, this.frame);
    }
    for (const d of this.dogs) {
      const dist = Math.hypot(d.dog.x - cp.x, d.dog.z - cp.z);
      d.dog.root.visible = dist < 110;
    }
  }

  /** The visitor waved: guests nearby who can see them wave back. */
  waveBack(at: THREE.Vector3) {
    for (const g of this.guests) {
      if (g.ride || g.scripted) continue;
      const dx = at.x - g.x;
      const dz = at.z - g.z;
      const d = Math.hypot(dx, dz);
      if (d > 12 || d < 0.5) continue;
      // facing the visitor, roughly
      const fx = -Math.sin(g.heading);
      const fz = -Math.cos(g.heading);
      if ((fx * dx + fz * dz) / d < -0.2 && !chance(0.3)) continue;
      const delay = R(0.2, 0.9);
      setTimeout(() => {
        g.faceHeading = Math.atan2(-dx, -dz);
        g.rig.wave(R(1.6, 2.6));
      }, delay * 1000);
    }
  }

  /** The visitor kicked toward `dir`: anyone right in front hops back out of the way. */
  shove(at: THREE.Vector3, dir: THREE.Vector2) {
    for (const g of this.guests) {
      if (g.ride || g.scripted) continue;
      const dx = g.x - at.x;
      const dz = g.z - at.z;
      const d = Math.hypot(dx, dz);
      if (d > 1.8 || (dx * dir.x + dz * dir.y) / Math.max(d, 1e-3) < 0.3) continue;
      g.x += dir.x * 0.6;
      g.z += dir.y * 0.6;
      g.faceHeading = Math.atan2(dx, dz);
      g.rig.play('Jump_Land');
    }
  }

  private night = -1;

  /** After dark everyone gets the same faint glow as the visitor. */
  setNight(k: number) {
    if (Math.abs(k - this.night) < 0.02) return;
    this.night = k;
    for (const g of this.guests) g.rig.setGlow(k);
  }

  /** Dev: what everyone's doing, queue lengths, riders. */
  debug() {
    const acts: Record<string, number> = {};
    for (const p of this.parties) acts[p.leader.activity] = (acts[p.leader.activity] ?? 0) + 1;
    return {
      guests: this.guests.length,
      parties: this.parties.length,
      dogs: this.dogs.length,
      acts,
      stops: this.stops.map((s) => ({ q: s.queue.people.length, cap: s.queue.capacity, riders: s.riders.size, boarding: s.boarding.size, dwelling: s.coaster.dwelling })),
      striker: this.strikerQ.people.length,
      booth: this.booth.people.length,
      nav: this.nav.nodes.filter((n) => n.live).length + '/' + this.nav.nodes.length,
    };
  }

  get count() {
    return this.guests.length;
  }
}
