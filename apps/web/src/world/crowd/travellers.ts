import * as THREE from 'three';
import type { HomeTerminal } from '../airport/terminal';
import type { Ctx } from '../context';
import { SEA_Y, type Region } from '../geo';
import type { PalmCay } from '../island/island';
import type { IslandTerminal } from '../island/island-terminal';
import type { Tier } from '../quality';
import { mulberry } from '../random';
import { groundY } from '../terrain-land';
import { backpackOn, CASE, hatOnHead, Luggage, pulledCase, putDown, standingCase, toteOn, type CaseState, type PropItem, type PropKind } from './luggage';
import { Obstacles } from './obstacles';
import { beachLook, cabinCrewLook, groundCrewLook, pilotLook, swimLook, travellerLook, type Look, type PeopleFactory, type PersonRig } from './people';
import { homePlan, islandPlan, type HomePlan, type IslandPlan, type LieSpot, type Seat, type Shallows, type Site, type Spot, type V3 } from './travellers-plan';
import type { V2 } from './walk-grid';

// The airports' and the island's people: travellers at Funfair International (dropped off at
// the kerb with their cases, checking in, through security, browsing the shops, waiting at the
// gates and watching the planes, arrivals off other flights collecting their bags), the crew
// walking out to gate 3, the passengers of the visitor's own flight queueing at the desk and
// walking the jet bridge or the airstairs, and Palm Cay's holidaymakers on the promenade, at the
// bars, on towels and loungers, in hammocks, building sandcastles, paddling and swimming in the
// shallows and watching the games.
//
// Separate from the park's Crowd (and much smaller): each person is a PersonRig with a little
// script (a generator, one step a frame) moving them along routes found on the site's walk grid,
// or along a scripted line (a queue, a bridge, the stairs). The place the visitor isn't in sleeps
// entirely; when it wakes, everyone is put straight back into the middle of something.

export interface Boarding {
  /** 0..1: how many of the passengers are aboard (boarding) or off and clear of the aircraft (deplaning). */
  readonly progress: number;
  readonly done: boolean;
  /** Finish at once: everyone left aboard (boarding) or put along the walk ahead (deplaning). */
  skip(): void;
}

export interface TravellersOptions {
  home: HomeTerminal;
  island: IslandTerminal;
  palmCay: PalmCay;
  shadows: boolean;
  tier: Tier;
}

type Task = Generator<void, void, void>;
type Role = 'traveller' | 'pilot' | 'crew' | 'stroller' | 'swimmer' | 'departing' | 'attendant';

/** How many of each, per place, by quality tier (at most 24 a place, as the park's crowd scales). */
const POOL: Record<Tier, { home: { traveller: number; pilot: number; crew: number }; island: { stroller: number; swimmer: number; departing: number; attendant: number; crew: number } }> = {
  high: { home: { traveller: 18, pilot: 2, crew: 4 }, island: { stroller: 9, swimmer: 9, departing: 4, attendant: 1, crew: 1 } },
  medium: { home: { traveller: 14, pilot: 2, crew: 2 }, island: { stroller: 7, swimmer: 6, departing: 3, attendant: 1, crew: 1 } },
  low: { home: { traveller: 9, pilot: 2, crew: 1 }, island: { stroller: 4, swimmer: 4, departing: 2, attendant: 1, crew: 1 } },
  lowest: { home: { traveller: 6, pilot: 2, crew: 0 }, island: { stroller: 3, swimmer: 2, departing: 1, attendant: 1, crew: 1 } },
};

/** Beyond this nobody is drawn (the crowd's range). */
const DRAW = 160;
/** Props are hidden beyond this (a case is a couple of pixels by then). */
const PROP_RANGE = 70;
/** Route searches allowed per frame (a long one over the beach park can take a millisecond or two). */
const ROUTES_PER_FRAME = 2;
/** Queue spacing, and the gap kept to the person ahead on a bridge or the stairs. */
const QUEUE_GAP = 0.62;
const WALK_GAP = 1.0;
/** How many stand in the visitor's flight's queue at the desk before boarding is called. */
const PRE_QUEUE: Record<Region, number> = { home: 8, island: 4 };
/**
 * The boarding's rhythm: a pass scanned every this many seconds (the gate's agent is quick; 18
 * passengers take about 40 s from the call to the last aboard), and a deplaning's passengers
 * step out of the door this often (the airstairs go one at a time, more carefully).
 */
const SCAN_EVERY = 0.66;
/** The least the head of the queue stands at the desk for the scan. */
const SCAN_PAUSE = 0.2;
const OUT_EVERY: Record<Region, number> = { home: 0.5, island: 1.15 };
/** Through the gate and along the bridge or across the apron: a brisk walk (m/s), whatever their pace. */
const BRISK = { min: 1.9, max: 2.05 };
/** Walking up (or down) a bridge's escalator, on top of its own speed. */
const ESCALATOR = { speed: 0.75, walk: 0.75 };
/**
 * How far (m) a beachgoer's choice of what to do next leans towards the visitor: the park is 400 m
 * of sand and only a couple of dozen are about, so they gather where they will be seen.
 */
const BEACH_FOCUS = 50;

/** On-top body poses: pitched back or forward about the feet (lying, reclining, swimming), lifted, shifted along the facing (× height). */
interface Pose {
  pitch: number;
  lift: number;
  shift: number;
}
const UPRIGHT: Pose = { pitch: 0, lift: 0, shift: 0 };
const ON_BACK: Pose = { pitch: Math.PI / 2, lift: 0.12, shift: 0.5 };
const ON_FRONT: Pose = { pitch: -Math.PI / 2, lift: 0.11, shift: -0.5 };
const SWIMMING: Pose = { pitch: -Math.PI / 2 + 0.28, lift: 0, shift: -0.45 };
const RECLINED: Pose = { pitch: 0.62, lift: 0.08, shift: 0.18 };

const forward = (yaw: number): V2 => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });
const yawTo = (from: V2, to: V2) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** A polyline with distances along it: a queue and its walk, a bridge, the stairs. */
class Line {
  readonly pts: V3[];
  readonly cum: number[] = [0];
  readonly length: number;
  /** The last `at`'s segment: its horizontal heading (NaN if vertical) and its slope (rise over length). */
  heading = NaN;
  slope = 0;

  constructor(pts: V3[]) {
    this.pts = pts;
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
    this.length = this.cum[this.cum.length - 1];
  }

  private seg(s: number) {
    let i = 1;
    while (i < this.pts.length - 1 && this.cum[i] < s) i++;
    return i;
  }

  /** Where the walk is s metres along (and the segment's heading and slope, kept on the line, not allocated). */
  at(s: number, out: V3) {
    s = THREE.MathUtils.clamp(s, 0, this.length);
    const i = this.seg(s);
    const a = this.pts[i - 1];
    const b = this.pts[i];
    const len = this.cum[i] - this.cum[i - 1];
    const t = len > 1e-6 ? (s - this.cum[i - 1]) / len : 1;
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
    const h = Math.hypot(b.x - a.x, b.z - a.z);
    this.heading = h > 1e-4 ? Math.atan2(-(b.x - a.x), -(b.z - a.z)) : NaN;
    this.slope = len > 1e-6 ? (b.y - a.y) / len : 0;
  }

  /** How far along the walk its first steep part (an escalator, stairs) starts. */
  steepFrom() {
    for (let i = 1; i < this.pts.length; i++) {
      const len = this.cum[i] - this.cum[i - 1];
      if (len > 1e-6 && Math.abs(this.pts[i].y - this.pts[i - 1].y) / len > 0.3) return this.cum[i - 1];
    }
    return 0;
  }

  /** How far along the walk first comes down to the ground after leaving it (the foot of the bridge or the stairs). */
  groundAfterClimb() {
    let up = false;
    for (let i = 0; i < this.pts.length; i++) {
      if (this.pts[i].y > 0.3) up = true;
      else if (up) return this.cum[i];
    }
    return 0;
  }
}

class Walker {
  x = 0;
  y = 0;
  z = 0;
  heading = 0;
  speed = 0;
  pace: number;
  /** The ground under them (where a case's wheels run). */
  floor = 0;
  route: V2[] = [];
  ri = 0;
  arriveR = 0.4;
  private best = Infinity;
  private bestT = 0;
  /** Stuck on the way (held up by someone, or squeezed off the line round a corner): wants a fresh route. */
  replan = false;
  /** Fresh routes allowed before a stuck walker just gives up on the waypoint and heads for the next. */
  replans = 0;
  /** A brisker walk than their own (called to board: off to the back of the queue). */
  hurry = 1;
  /** Position set directly by the script (seats, lines, stairs, the sea): no steering or pushing. */
  scripted = false;
  /** Out of the world: not drawn, not simulated (aboard, gone home, waiting to come back). */
  away = true;
  task: Task | null = null;
  faceHeading: number | null = null;
  face: V2 | null = null;
  pose: Pose = UPRIGHT;
  private poseFrom: Pose = UPRIGHT;
  poseK = 1;
  private poseRate = 1;
  private readonly blend: Pose = { pitch: 0, lift: 0, shift: 0 };
  /** What they're up to (for the debug readout, and the gate's head count). */
  doing = '';
  /** The spot they've claimed (a seat, a towel…), released when they move on. */
  claim: object | null = null;
  // what they carry
  case: PropItem | null = null;
  /** Pulling it; or where it stands, put down (null and not held: checked in, or not yet collected). */
  holding = false;
  caseAt: { x: number; y: number; z: number; yaw: number; flat: boolean } | null = null;
  caseState: CaseState = { pull: 0 };
  /** How far the case's telescopic handle is out (pushed home on a belt or the scale). */
  handle = 1;
  bag: PropItem | null = null;
  bagDown: { x: number; y: number; z: number; yaw: number } | null = null;
  hat: PropItem | null = null;
  hatDown: { x: number; y: number; z: number; yaw: number } | null = null;
  /** Checked luggage (dropped at check-in, collected at reclaim) rather than a cabin roll-aboard. */
  bigCase = false;
  // a scripted line (queue → bridge → door, or door → stairs → plaza)
  line: Run | null = null;
  lineS = 0;
  lineOrder = 0;
  /** Walking the line now (rather than still on their way to their place in the queue). */
  onLine = false;
  /** Speed along the line (apart from `speed`, which is what the legs show and is nil on an escalator). */
  lineV = 0;
  /** Deplaning: already counted as clear of the aircraft. */
  counted = false;
  // drawing
  visible = false;
  private animDt = 0;
  /** The skeleton was posed this frame (so a held case can be fitted to the hand). */
  posed = false;

  constructor(
    readonly rig: PersonRig,
    readonly look: Look,
    readonly role: Role,
    readonly region: Region,
    readonly index: number,
    rnd: () => number,
  ) {
    this.pace = role === 'stroller' || role === 'swimmer' ? 0.8 + rnd() * 0.35 : look.child ? 1.0 + rnd() * 0.3 : 1.05 + rnd() * 0.35;
    rig.root.rotation.order = 'YXZ';
    rig.root.visible = false;
  }

  get arrived() {
    return this.ri >= this.route.length;
  }

  goTo(points: V2[], arriveR = 0.4) {
    this.route = points;
    this.ri = 0;
    this.arriveR = arriveR;
    this.best = Infinity;
    this.bestT = 0;
  }

  /** Each frame, with the distance to the current waypoint: asks for a fresh route if they're stuck (or, out of those, skips the waypoint). */
  progress(d: number, dt: number) {
    if (d < this.best - 0.12) {
      this.best = d;
      this.bestT = 0;
      return;
    }
    this.bestT += dt;
    if (this.bestT > 2) {
      if (this.replans > 0) {
        this.replans--;
        this.replan = true;
      } else this.ri++;
      this.best = Infinity;
      this.bestT = 0;
    }
  }

  resetProgress() {
    this.best = Infinity;
    this.bestT = 0;
  }

  /** Ease into a pose over `seconds`. */
  setPose(p: Pose, seconds = 1) {
    if (p === this.pose && this.poseK >= 1) return;
    const from = this.current();
    this.poseFrom = from === this.blend ? { ...from } : from;
    this.pose = p;
    this.poseK = seconds > 0 ? 0 : 1;
    this.poseRate = seconds > 0 ? 1 / seconds : 1;
  }

  /** The pose right now (blended), written into a pose of the walker's own (it's asked for every frame). */
  current(): Pose {
    if (this.poseK >= 1) return this.pose;
    const k = THREE.MathUtils.smoothstep(this.poseK, 0, 1);
    const a = this.poseFrom;
    const b = this.pose;
    const o = this.blend;
    o.pitch = a.pitch + (b.pitch - a.pitch) * k;
    o.lift = a.lift + (b.lift - a.lift) * k;
    o.shift = a.shift + (b.shift - a.shift) * k;
    return o;
  }

  stepPose(dt: number) {
    if (this.poseK < 1) this.poseK = Math.min(1, this.poseK + dt * this.poseRate);
  }

  /** Put the rig where the walker is, posed. */
  place() {
    const p = this.current();
    const s = p.shift * this.look.height;
    this.rig.root.position.set(this.x - Math.sin(this.heading) * s, this.y + p.lift, this.z - Math.cos(this.heading) * s);
    this.rig.root.rotation.set(p.pitch, this.heading, 0);
  }

  /** Advance the animation, every `every` frames (staggered by index) with the time saved up. */
  animate(dt: number, every: number, frame: number) {
    this.animDt += dt;
    this.posed = false;
    if ((frame + this.index) % every !== 0) return;
    this.rig.update(this.animDt, this.speed);
    this.animDt = 0;
    this.posed = true;
  }
}

/** A boarding or a deplaning in progress: its line, and who's on it in order. */
class Run implements Boarding {
  readonly line: Line;
  /** Where on the line the gate's agent scans each boarding pass (boarding only). */
  readonly scanS: number;
  /** How far down the walk counts as off the aircraft and clear (deplaning). */
  readonly clearS: number;
  readonly members: Walker[] = [];
  /** Boarding: those in the queue (or past it, on the walk), in the order they joined it; deplaning: everyone, in order. */
  readonly queue: Walker[] = [];
  /** How many of the queue have been scanned and let through. */
  released = 0;
  /** Boarding: how many are on their way from their seats to the back of the queue. */
  joining = 0;
  /** When the queue's head reached the desk, and when the last passenger was let through. */
  headAt = -1;
  lastRelease = -10;
  lastAppear = -10;
  count = 0;
  finished = false;
  dumped = false;
  greeter: Walker | null = null;
  attendant: Walker | null = null;
  /** Escalators (home) carry people standing; stairs (the island) are walked, slowly. */
  readonly escalators: boolean;

  constructor(
    readonly kind: 'board' | 'deplane',
    readonly region: Region,
    pts: V3[],
    scanS: number,
    /** What the queue's head turns to while their pass is scanned (the gate's desk), if anything. */
    readonly desk: V2 | null,
    private readonly host: Travellers,
  ) {
    this.line = new Line(pts);
    this.scanS = scanS;
    this.escalators = region === 'home';
    // clear of the aircraft: off the bridge, onto its escalator down into the terminal; or a pace or
    // two past the foot of the airstairs
    this.clearS = Math.min(this.line.length, Math.max(this.escalators ? this.line.steepFrom() : this.line.groundAfterClimb() + 1.5, 12));
  }

  get progress() {
    return this.members.length ? Math.min(1, this.count / this.members.length) : 1;
  }

  get done() {
    return this.finished || this.count >= this.members.length;
  }

  skip() {
    this.host.finishRun(this);
  }
}

export class Travellers {
  private readonly walkers: Walker[] = [];
  private readonly byRegion: Record<Region, Walker[]> = { home: [], island: [] };
  private readonly luggage: Luggage;
  private readonly obs: Obstacles;
  private readonly home: HomePlan;
  private readonly isle: IslandPlan;
  private readonly rnd = mulberry(7311);
  private readonly claims = new Set<object>();
  private awake: Region | null = null;
  private dt = 1 / 60;
  private t = 0;
  private frame = 0;
  private routesLeft = ROUTES_PER_FRAME;
  private visitor: THREE.Vector3Like | null = null;
  private run: Run | null = null;
  /** The visitor's flight's queue before boarding is called (front first), and the line it stands along (its tail to the desk). */
  private readonly preQ: Record<Region, Walker[]> = { home: [], island: [] };
  private readonly preLine: Record<Region, Line>;
  private night = -1;
  /** The crew's walk out to gate 3: when they next set off. */
  private crewDue = 20;
  private crewOut = false;
  /** North of this the visitor is airside (past security) at Funfair International. */
  private readonly airsideZ: number;
  // scratch
  private readonly frustum = new THREE.Frustum();
  private readonly m4 = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camPos = new THREE.Vector3();
  private readonly tmp: V3 = { x: 0, y: 0, z: 0 };
  private readonly route: V2[] = [];

  constructor(ctx: Ctx, factory: PeopleFactory, opts: TravellersOptions) {
    // the colliders (the terminals', the island's, the games') must all be in the world by now
    this.obs = new Obstacles(ctx.world);
    this.home = homePlan(opts.home, this.obs);
    this.isle = islandPlan(opts.island, opts.palmCay, this.obs);
    const queueLine = (tail: V2[]) => new Line([...tail.slice(1).reverse(), tail[0]].map((q) => ({ x: q.x, y: 0, z: q.z })));
    this.preLine = { home: queueLine(this.home.tail), island: queueLine(this.isle.tail) };
    const exit = this.home.lanes[0].path;
    this.airsideZ = exit[exit.length - 1].z - 0.5;

    const n = POOL[opts.tier];
    const r = this.rnd;
    const specs: { role: Role; region: Region; look: Look }[] = [];
    for (let i = 0; i < n.home.pilot; i++) specs.push({ role: 'pilot', region: 'home', look: pilotLook(r) });
    for (let i = 0; i < n.home.crew; i++) specs.push({ role: 'crew', region: 'home', look: cabinCrewLook(r) });
    for (let i = 0; i < n.home.traveller; i++) specs.push({ role: 'traveller', region: 'home', look: travellerLook(r, { child: r() < 0.12 }) });
    for (let i = 0; i < n.island.stroller; i++) specs.push({ role: 'stroller', region: 'island', look: beachLook(r, { child: r() < 0.15 }) });
    for (let i = 0; i < n.island.swimmer; i++) specs.push({ role: 'swimmer', region: 'island', look: swimLook(r, { child: r() < 0.2 }) });
    for (let i = 0; i < n.island.departing; i++) specs.push({ role: 'departing', region: 'island', look: travellerLook(r) });
    for (let i = 0; i < n.island.attendant; i++) specs.push({ role: 'attendant', region: 'island', look: groundCrewLook(r) });
    // the island has no crew base: one of the flight's cabin crew, at the door while it boards or unloads
    for (let i = 0; i < n.island.crew; i++) specs.push({ role: 'crew', region: 'island', look: cabinCrewLook(r) });

    // what each carries, decided up front so the instanced props can be sized
    const kit = specs.map((s) => this.kitFor(s.role, s.look));
    const counts: Record<PropKind, number> = { suitcase: 0, backpack: 0, tote: 0, strawHat: 0, pilotCap: 0 };
    for (const k of kit) for (const p of k.props) counts[p.kind]++;
    this.luggage = new Luggage(counts, opts.shadows);
    ctx.scene.add(this.luggage.group);

    specs.forEach((s, i) => {
      const rig = factory.create(s.look);
      rig.setShadows(opts.shadows);
      ctx.scene.add(rig.root);
      const w = new Walker(rig, s.look, s.role, s.region, i, r);
      for (const p of kit[i].props) {
        const item = this.luggage.add(p.kind, p.colour, p.scale);
        if (p.kind === 'suitcase') w.case = item;
        else if (p.kind === 'strawHat' || p.kind === 'pilotCap') w.hat = item;
        else w.bag = item;
      }
      w.bigCase = kit[i].bigCase;
      this.walkers.push(w);
      this.byRegion[s.region].push(w);
    });
  }

  /** What someone in this role carries and wears. */
  private kitFor(role: Role, look: Look) {
    const r = this.rnd;
    const props: { kind: PropKind; colour: THREE.ColorRepresentation; scale: number }[] = [];
    let bigCase = false;
    const caseColours = ['#2d3748', '#c9304f', '#2e7dd6', '#d8dde3', '#ffc23d', '#1d1f22', '#7b5cd6', '#2ec4b6', '#b5651d', '#e9739a'];
    const bagColours = ['#2d3748', '#556b2f', '#c9304f', '#2e5eaa', '#1d1f22', '#8a6a48', '#ff8a3d'];
    const toteColours = ['#f4ead2', '#ffcf3d', '#2ec4b6', '#ff8fab', '#e8dcc4', '#ff6f61'];
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
    switch (role) {
      case 'pilot':
        props.push({ kind: 'suitcase', colour: '#15171c', scale: 0.82 }, { kind: 'pilotCap', colour: '#1b2033', scale: 1 });
        break;
      case 'crew':
        props.push({ kind: 'suitcase', colour: r() < 0.5 ? '#1d1238' : '#c8233f', scale: 0.82 });
        break;
      case 'traveller':
      case 'departing': {
        if (look.child) {
          if (r() < 0.6) props.push({ kind: 'backpack', colour: pick(['#ff4d6d', '#2ec4b6', '#ffc23d', '#7b5cd6']), scale: 1 });
          break;
        }
        const c = r();
        if (c < 0.55) {
          bigCase = role === 'traveller';
          props.push({ kind: 'suitcase', colour: pick(caseColours), scale: bigCase ? 1 : 0.82 });
          if (r() < 0.3) props.push({ kind: r() < 0.5 ? 'backpack' : 'tote', colour: pick(bagColours), scale: 1 });
        } else if (c < 0.85) props.push({ kind: 'suitcase', colour: pick(caseColours), scale: 0.82 });
        else props.push({ kind: 'backpack', colour: pick(bagColours), scale: 1 });
        if (r() < 0.14) props.push({ kind: 'strawHat', colour: pick(['#e4c98a', '#efe2c0', '#f4f1ea']), scale: 1 });
        break;
      }
      case 'stroller':
        if (r() < 0.35) props.push({ kind: 'tote', colour: pick(toteColours), scale: 1 });
        else if (r() < 0.15) props.push({ kind: 'backpack', colour: pick(bagColours), scale: 1 });
        if (r() < 0.4) props.push({ kind: 'strawHat', colour: pick(['#e4c98a', '#efe2c0', '#f4f1ea', '#ff8fab', '#2ec4b6']), scale: look.child ? 0.85 : 1 });
        break;
      case 'swimmer':
        if (!look.child && r() < 0.35) props.push({ kind: 'tote', colour: pick(toteColours), scale: 1 });
        if (r() < 0.3) props.push({ kind: 'strawHat', colour: pick(['#e4c98a', '#efe2c0', '#f4f1ea']), scale: look.child ? 0.85 : 1 });
        break;
      case 'attendant':
        break;
    }
    return { props, bigCase };
  }

  /** The visitor (so people step out of their way, and choose things to do near them), or null. */
  setVisitor(p: THREE.Vector3Like | null) {
    this.visitor = p;
  }

  setNight(k: number) {
    if (Math.abs(k - this.night) < 0.02) return;
    this.night = k;
    for (const w of this.walkers) w.rig.setGlow(k);
  }

  /** How many people each place has (simulated while the visitor is there). */
  get counts() {
    return { home: this.byRegion.home.length, island: this.byRegion.island.length };
  }

  /** Dev: what everyone in the waking place is up to (how many at each; or, with `where`, each one and where they are). */
  debug(where = false) {
    const out: Record<string, number> = {};
    const each: string[] = [];
    for (const w of this.awake ? this.byRegion[this.awake] : []) {
      const k = w.away ? 'away' : w.doing || 'idle';
      out[k] = (out[k] ?? 0) + 1;
      if (where && !w.away) each.push(`${k}@${w.x.toFixed(1)},${w.y.toFixed(1)},${w.z.toFixed(1)}${w.scripted ? 's' : ''}${w.arrived ? '' : `→${w.route[w.ri].x.toFixed(1)},${w.route[w.ri].z.toFixed(1)}`}`);
    }
    return where ? each : out;
  }

  /** Dev: the visitor's flight's line (who's where along it), or ''. */
  debugRun() {
    const r = this.run;
    if (!r) return '';
    const who = r.members.map((w) => (w.onLine ? w.lineS.toFixed(0) : w.away ? 'A' : `~${w.doing}@${w.x.toFixed(0)},${w.z.toFixed(0)}${w.scripted ? 's' : ''}`)).join(' ');
    if (!r.dumped && (r.dumped = true)) console.warn(r.line.pts.map((p, i) => `${i}:(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) s${r.line.cum[i].toFixed(1)}`).join(" "));
    return `${r.kind} L${r.line.length.toFixed(0)} scan${r.scanS.toFixed(0)} n${r.members.length} q${r.queue.length} rel${r.released} join${r.joining} in${r.count} [${who}]`;
  }

  /** Dev: where the first person doing something (`doing` contains `what`) is, and which way they face; or null. */
  whereIs(what: string) {
    for (const w of this.awake ? this.byRegion[this.awake] : []) if (!w.away && w.doing.includes(what)) return { x: w.x, y: w.y, z: w.z, heading: w.heading };
    return null;
  }

  /**
   * Dev: can everyone get where their scripts send them? Routes between each stage of a journey
   * (and the spots people walk to standing on free ground). Returns the failures and a summary.
   */
  check(probes: [V2, V2][] = []) {
    const fails: string[] = [];
    const notes: string[] = [];
    let tried = 0;
    const out: V2[] = [];
    const p = { x: 0, z: 0 };
    const route = (what: string, site: Site, a: V2, b: V2) => {
      tried++;
      out.length = 0;
      const at = `${what}: (${a.x.toFixed(1)}, ${a.z.toFixed(1)}) → (${b.x.toFixed(1)}, ${b.z.toFixed(1)})`;
      if (!site.route(a.x, a.z, b.x, b.z, out)) {
        fails.push(`${at} no route`);
        return;
      }
      // and walk it as move() would, pushed out of the colliders: does anything stop them?
      p.x = a.x;
      p.z = a.z;
      for (let qi = 0; qi < out.length; qi++) {
        const q = out[qi];
        const next = qi < out.length - 1 ? out[qi + 1] : null;
        // stuck: no headway (half a metre nearer) in 120 steps of 5 cm
        let best = Infinity;
        let since = 0;
        // (corners are reached as move() reaches them: close, or early where the way on is clear)
        for (let d = Math.hypot(q.x - p.x, q.z - p.z); d > (next ? 0.12 : 0.3); d = Math.hypot(q.x - p.x, q.z - p.z)) {
          if (next && d < 0.9 && this.obs.clear(p.x, p.z, next.x, next.z, 0.3)) break;
          const k = Math.min(0.05, d) / d;
          p.x += (q.x - p.x) * k;
          p.z += (q.z - p.z) * k;
          this.obs.push(p, 0.28);
          if (d < best - 0.5) {
            best = d;
            since = 0;
          } else if (++since > 120) {
            const near = this.obs.list
              .filter((o) => Math.hypot(o.x - p.x, o.z - p.z) < (o.kind === 'circle' ? o.r : Math.hypot(o.hx, o.hz)) + 1.5)
              .map((o) => (o.kind === 'circle' ? `circle(${o.x.toFixed(1)},${o.z.toFixed(1)} r${o.r.toFixed(2)})` : `box(${o.x.toFixed(1)},${o.z.toFixed(1)} ${o.hx.toFixed(2)}x${o.hz.toFixed(2)} yaw${Math.atan2(o.s, o.c).toFixed(2)})`))
              .join(' ');
            fails.push(`${at} stuck at (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) heading for (${q.x.toFixed(1)}, ${q.z.toFixed(1)}); near ${near}; route ${out.map((r) => `(${r.x.toFixed(1)}, ${r.z.toFixed(1)})`).join(' ')}`);
            return;
          }
        }
      }
    };
    const every = <T>(list: readonly T[], n: number) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0);
    const H = this.home;
    const hs = H.site;
    const kerbIn = H.kerb.departures[0];
    for (const d of H.kerb.departures) route('kerb → hall', hs, d, { x: d.x, z: 444 });
    for (const c of H.checkIn) route('hall → check-in', hs, { x: kerbIn.x, z: 444 }, c);
    for (const l of H.lanes) route('check-in → lane', hs, H.checkIn[0], l.entry);
    for (const c of H.checkIn) route('desk → lane', hs, c, H.lanes[3].entry);
    const air = H.lanes[0].path[H.lanes[0].path.length - 1];
    for (const s of every(H.shops, 8)) route('airside → shop', hs, air, s);
    for (const s of every(H.hallShops, 6)) route('hall → shop', hs, { x: kerbIn.x, z: 444 }, s);
    for (const s of every(H.windows, 8)) route('airside → window', hs, air, s);
    for (const g of Object.keys(H.gateSeats).map(Number)) {
      for (const s of every(H.gateSeats[g], 6)) route(`airside → gate ${g} seat`, hs, air, s.approach);
      route(`gate ${g} seat → desk`, hs, H.gateSeats[g][0].approach, H.gates[g].desk);
      route(`gate ${g} desk → pen door`, hs, H.gates[g].desk, H.gates[g].pen[0]);
    }
    const g3 = H.gates[3].pen;
    route('gate 3 arrivals → reclaim', hs, g3[0], H.reclaimExit);
    for (const b of H.belts) route('reclaim → belt', hs, H.reclaimExit, b);
    for (const k of H.kerb.arrivals) route('reclaim → arrivals door', hs, H.reclaimExit, { x: k.x, z: 443 });
    for (const s of H.hall) route('reclaim → hall', hs, H.reclaimExit, s);
    route('crew → gate 3', hs, H.crewStart, { x: g3[0].x, z: g3[0].z - 0.8 });
    const I = this.isle;
    const is = I.site;
    for (const p of every(I.promenade, 6)) route('promenade → entrance', is, p, I.entrance.out);
    route('entrance → in', is, I.entrance.out, I.entrance.in);
    for (const c of I.checkIn) route('entrance → check-in', is, I.entrance.in, c);
    for (const l of I.lanes) route('entrance → lane', is, I.entrance.in, l.entry);
    const iair = I.lanes[0].path[I.lanes[0].path.length - 1];
    for (const s of every(I.lounge, 8)) route('lane → lounge seat', is, iair, s.approach);
    route('lounge → gate 1', is, I.lounge[0].approach, { x: I.gate1.x, z: I.gate1.z + 1.5 });
    for (const s of every(I.benches, 8)) route('plaza → bench', is, I.plaza, s.approach);
    for (const s of every(I.bars, 8)) route('plaza → bar', is, I.plaza, s.approach);
    for (const s of every(I.beds, 10)) route(`plaza → ${s.kind}`, is, I.plaza, s.approach);
    for (const s of every(I.castles, 6)) route('plaza → sandcastle', is, I.plaza, s);
    for (const s of every(I.shallows, 8)) route('plaza → shallows', is, I.plaza, s.edge);
    for (const s of every(I.watch, 10)) route('plaza → watching', is, I.plaza, s);
    for (const s of every(I.wander, 8)) route('plaza → wander', is, I.plaza, s);
    // and across the park: from one game to the next, from a bed to the sea, along the promenade
    const ws = every(I.watch, 8);
    ws.forEach((s, i) => route('game → game', is, s, ws[(i + 3) % ws.length]));
    const bs = every(I.beds, 8);
    bs.forEach((b, i) => route('bed → shallows', is, b.approach, I.shallows[(i * 5) % I.shallows.length].edge));
    const ps = every(I.promenade, 6);
    ps.forEach((p, i) => route('promenade → watching', is, p, ws[i % ws.length]));
    // and any asked for (dev: a walk seen to go wrong), with the corners found
    for (const [a, b] of probes) {
      const site = a.z > 20000 ? is : hs;
      route('probe', site, a, b);
      notes.push(`probe (${a.x}, ${a.z}) → (${b.x}, ${b.z}): ${out.map((q) => `(${q.x.toFixed(1)}, ${q.z.toFixed(1)})`).join(' ')}`);
    }
    const seats = Object.values(H.gateSeats).reduce((a, s) => a + s.length, 0);
    return {
      fails,
      notes,
      summary: `${tried - fails.length}/${tried} routes · home ${H.checkIn.length} desks, ${H.lanes.length} lanes, ${H.shops.length + H.hallShops.length} shop spots, ${H.windows.length} windows, ${seats} gate seats · island ${I.lounge.length} lounge seats, ${I.benches.length} benches, ${I.bars.length} bar stools, ${I.beds.length} beds, ${I.castles.length} castles, ${I.shallows.length} shallows, ${I.watch.length} watch spots`,
    };
  }

  // ----------------------------------------------------------------------------------------------
  // The visitor's flight
  // ----------------------------------------------------------------------------------------------

  /**
   * Board up to `n` passengers along `path` (the gate's queue head → the bridge or the stairs →
   * the door sill). The gate lounge's seated travellers go first; then others are found seats at
   * the gate out of sight, and join the queue behind them. Each vanishes at the door.
   */
  board(region: Region, n: number, path: THREE.Vector3Like[]): Boarding {
    if (this.run) this.finishRun(this.run);
    this.wake(region);
    const plan = region === 'home' ? this.home : this.isle;
    // the queue winds back from the path's head through the lounge (the plan's tail, reversed)
    const tail = plan.tail.slice(1).reverse();
    const pts: V3[] = [...tail.map((p) => ({ x: p.x, y: 0, z: p.z })), ...path.map((p) => ({ x: p.x, y: p.y, z: p.z }))];
    const scanS = new Line(pts.slice(0, tail.length + 1)).length;
    const run = new Run('board', region, pts, scanS, region === 'home' ? this.home.gates[3].desk : null, this);
    this.run = run;
    const head = path[0];
    // those already queueing at the desk go first, in their order; then those seated at the gate
    // (nearest the desk first), then whoever can be put there unseen
    const queued = this.preQ[region].splice(0, n);
    this.preQ[region].length = 0;
    const seats = region === 'home' ? this.home.gateSeats[3] : this.isle.lounge;
    // (on Palm Cay, beachgoers going home too, put at the gate out of sight)
    const pool = this.byRegion[region].filter((w) => w.role === 'traveller' || w.role === 'departing' || (w.role === 'stroller' && (w.away || !w.visible)));
    // (those sat at the lounge's far end wait for the stragglers' call, in time for the next flight)
    const atGate = pool.filter((w) => !queued.includes(w) && !w.away && w.claim && seats.includes(w.claim as Seat) && Math.hypot(w.x - head.x, w.z - head.z) < 14);
    atGate.sort((a, b) => Math.hypot(a.x - head.x, a.z - head.z) - Math.hypot(b.x - head.x, b.z - head.z));
    const chosen = [...queued, ...atGate.slice(0, n - queued.length)];
    const others = pool.filter((w) => !chosen.includes(w) && (w.away || !w.visible) && !w.line);
    for (const w of others) {
      if (chosen.length >= n) break;
      const s = this.freeSeat(seats, head, true);
      // (not from the far end of the lounge: they would hold the boarding up)
      if (!s || Math.hypot(s.x - head.x, s.z - head.z) > (region === 'home' ? 14 : 30)) break;
      this.reset(w);
      this.claimSpot(w, s);
      this.sitNow(w, s);
      chosen.push(w);
    }
    chosen.forEach((w, i) => {
      w.line = run;
      w.lineOrder = i;
      w.lineS = 0;
      w.onLine = false;
      w.lineV = 0;
      run.members.push(w);
      if (i < queued.length) {
        // already standing in the queue: straight onto the line where they stand
        w.lineS = Math.max(0, run.scanS - i * QUEUE_GAP);
        w.onLine = true;
        w.doing = 'queueing';
        w.rig.setBase('stand');
        run.queue.push(w);
        this.alongLine(w, run);
        w.task = this.onTheLine(w, run);
      } else w.task = this.boarder(w, run);
    });
    // a cabin crew member greets them at the door; on the island a ramp agent minds the stairs
    run.greeter = this.doorCrew(region, run);
    run.attendant = region === 'island' ? this.stairsAttendant(run) : null;
    return run;
  }

  /**
   * Walk up to `n` passengers out of the door along `path` (door → bridge or stairs → arrivals →
   * plaza). At home they go on to collect their bags and leave by the kerb; on Palm Cay they
   * become holidaymakers (or, with a case, head off to their hotel).
   */
  deplane(region: Region, n: number, path: THREE.Vector3Like[]): Boarding {
    if (this.run) this.finishRun(this.run);
    this.wake(region);
    const run = new Run('deplane', region, path.map((p) => ({ x: p.x, y: p.y, z: p.z })), -1, null, this);
    this.run = run;
    const roles: Role[] = region === 'home' ? ['traveller'] : ['stroller', 'departing'];
    const pool = this.byRegion[region].filter((w) => roles.includes(w.role) && !w.line);
    // those out of the world first, then whoever isn't in sight
    pool.sort((a, b) => Number(b.away) - Number(a.away) || Number(a.visible) - Number(b.visible));
    for (const w of pool) {
      if (run.members.length >= n) break;
      if (!w.away && w.visible) continue;
      if (!w.away) this.vanish(w);
      this.reset(w);
      w.line = run;
      w.lineS = 0;
      w.lineV = 0;
      w.onLine = false;
      w.counted = false;
      // no hold luggage off the aircraft: that comes on the belt
      w.holding = !w.bigCase && !!w.case;
      run.members.push(w);
      w.task = this.deplaner(w, run);
    }
    run.greeter = this.doorCrew(region, run);
    run.attendant = region === 'island' ? this.stairsAttendant(run) : null;
    return run;
  }

  /** Ends a run at once (Boarding.skip, or a new run starting). */
  finishRun(run: Run) {
    if (run.finished) return;
    run.finished = true;
    if (run.kind === 'board') {
      for (const w of run.members) {
        if (w.away) continue;
        this.vanish(w);
        w.task = this.later(w, 40 + this.rnd() * 60);
      }
    } else {
      // everyone not yet clear of the aircraft is put further along the walk, a pace or two apart,
      // and let off the line to go on their way from there
      let k = 0;
      for (const w of run.members) {
        if (w.line !== run) continue;
        if (w.lineS < run.clearS) {
          w.lineS = Math.max(run.clearS, run.line.length - 3 - k++ * 1.7);
          this.appear(w);
          this.alongLine(w, run);
          w.heading = w.faceHeading ?? w.heading;
        }
        this.offLine(w);
      }
    }
    run.count = run.members.length;
    if (run.greeter && !run.greeter.away) this.vanish(run.greeter);
    if (run.attendant && !run.attendant.away) this.vanish(run.attendant);
    if (this.run === run) this.run = null;
  }

  // ----------------------------------------------------------------------------------------------
  // Frame
  // ----------------------------------------------------------------------------------------------

  update(dt: number, t: number, camera: THREE.Camera, region: Region) {
    this.dt = Math.min(dt, 0.1);
    this.t = t;
    this.frame++;
    this.routesLeft = ROUTES_PER_FRAME;
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.camPos);
    this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    this.wake(region);
    const list = this.byRegion[region];
    if (region === 'home') this.crewSchedule();
    for (const w of list) {
      if (w.task && w.task.next().done) w.task = null;
      if (!w.task) w.task = this.life(w, false);
    }
    this.runLines();
    this.move(list);
    this.draw(list);
    this.luggage.flush();
  }

  /** Bring a place to life (and put the other to sleep): everyone straight into the middle of something. */
  private wake(region: Region) {
    if (this.awake === region) return;
    if (this.awake) for (const w of this.byRegion[this.awake]) this.sleep(w);
    this.awake = region;
    if (this.run && this.run.region !== region) this.finishRun(this.run);
    for (const w of this.byRegion[region]) {
      this.reset(w);
      w.task = this.life(w, true);
    }
    this.crewDue = this.t + 15;
    this.crewOut = false;
  }

  private sleep(w: Walker) {
    this.vanish(w);
    w.task = null;
  }

  /** Clear whatever they were doing (the spot they held, their pose, the line). */
  private reset(w: Walker) {
    w.hurry = 1;
    this.release(w);
    this.leavePreQueue(w);
    w.line = null;
    w.onLine = false;
    w.scripted = false;
    w.setPose(UPRIGHT, 0);
    w.rig.setBase('stand');
    w.rig.armsUp = 0;
    w.face = null;
    w.faceHeading = null;
    w.route = [];
    w.ri = 0;
    w.speed = 0;
    w.holding = !!w.case;
    w.caseAt = null;
    w.bagDown = null;
    w.hatDown = null;
  }

  private vanish(w: Walker) {
    this.release(w);
    this.leavePreQueue(w);
    w.away = true;
    w.visible = false;
    w.rig.root.visible = false;
    w.speed = 0;
    w.line = null;
    this.hideProps(w);
  }

  private hideProps(w: Walker) {
    if (w.case) this.luggage.hide(w.case);
    if (w.bag) this.luggage.hide(w.bag);
    if (w.hat) this.luggage.hide(w.hat);
  }

  private appear(w: Walker) {
    w.away = false;
  }

  // ----------------------------------------------------------------------------------------------
  // Little scripts
  // ----------------------------------------------------------------------------------------------

  private *wait(seconds: number): Task {
    let t = seconds;
    while ((t -= this.dt) > 0) yield;
  }

  /** Away for a while, then back into life. */
  private *later(w: Walker, seconds: number): Task {
    if (!w.away) this.vanish(w);
    yield* this.wait(seconds);
    yield* this.life(w, false);
  }

  /** Is (x, y, z) where the camera can see it (close enough to matter)? */
  private seen(x: number, y: number, z: number, range = 90) {
    const d = Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z);
    if (d > range) return false;
    if (d < 12) return true;
    this.sphere.center.set(x, y + 0.9, z);
    this.sphere.radius = 1.2;
    return this.frustum.intersectsSphere(this.sphere);
  }

  private site(w: Walker): Site {
    return w.region === 'home' ? this.home.site : this.isle.site;
  }

  /** Walk to (x, z) on the site's grid (waiting a frame or two for a route when many are asked at once). */
  private *walkTo(w: Walker, x: number, z: number, arriveR = 0.35): Task {
    w.scripted = false;
    w.face = null;
    w.faceHeading = null;
    if (Math.hypot(x - w.x, z - w.z) < arriveR) return;
    w.replans = 3;
    for (;;) {
      w.replan = false;
      // (searches are rationed per frame; wait a frame or two for one)
      while (this.routesLeft <= 0) yield;
      this.routesLeft--;
      this.route.length = 0;
      if (this.site(w).route(w.x, w.z, x, z, this.route)) w.goTo(this.route.slice(), arriveR);
      // nowhere to go from here: straight there, and the colliders will have their say
      else w.goTo([{ x, z }], arriveR);
      while (!w.arrived && !w.replan) yield;
      if (!w.replan) break;
    }
    w.speed = 0;
  }

  /** Walk the given points straight (a lane, a pen door): no searching. */
  private *walkPoints(w: Walker, pts: V2[], arriveR = 0.3): Task {
    w.scripted = false;
    // (a set walk, no searching: a stuck walker moves on to the next point)
    w.replans = 0;
    w.goTo(
      pts.map((p) => ({ x: p.x, z: p.z })),
      arriveR,
    );
    while (!w.arrived) yield;
    w.speed = 0;
  }

  /** Glide straight to a point (seats, escalators, beds), the height blending too. */
  private *glide(w: Walker, to: V3, speed: number, turn = true, gait = true): Task {
    w.scripted = true;
    const fx = w.x;
    const fy = w.y;
    const fz = w.z;
    const len = Math.hypot(to.x - fx, to.y - fy, to.z - fz);
    const dur = Math.max(0.15, len / speed);
    if (turn && Math.hypot(to.x - fx, to.z - fz) > 0.05) w.faceHeading = Math.atan2(-(to.x - fx), -(to.z - fz));
    for (let t = 0; t < dur; t += this.dt) {
      const k = t / dur;
      w.x = fx + (to.x - fx) * k;
      w.y = fy + (to.y - fy) * k;
      w.z = fz + (to.z - fz) * k;
      w.speed = gait ? len / dur : 0;
      yield;
    }
    w.x = to.x;
    w.y = to.y;
    w.z = to.z;
    w.speed = 0;
  }

  /** Up or down a bridge's escalator and on along the bridge: carried standing on the steep parts, walking on the flat. */
  private *escalate(w: Walker, to: V3): Task {
    const steep = Math.abs(to.y - w.y) > 0.5;
    yield* this.glide(w, to, steep ? 0.75 : w.pace, true, !steep);
  }

  private *turnTo(w: Walker, yaw: number): Task {
    w.faceHeading = yaw;
    for (let t = 0; t < 1.2 && Math.abs(wrap(yaw - w.heading)) > 0.08; t += this.dt) yield;
  }

  private claimSpot(w: Walker, s: object) {
    this.release(w);
    this.claims.add(s);
    w.claim = s;
  }

  private release(w: Walker) {
    if (w.claim) this.claims.delete(w.claim);
    w.claim = null;
  }

  /** A free spot from `list`, the nearer `near` the likelier (and none in sight, if asked). */
  private pick<T extends V2 | Shallows>(list: readonly T[], near: V2 | null, scale = 120, unseen = false): T | null {
    let total = 0;
    const weights: number[] = [];
    for (const s of list) {
      // (a stretch of the shallows is where it meets the sand)
      const p: V2 = 'edge' in s ? s.edge : s;
      let wgt = 0;
      if (!this.claims.has(s) && !(unseen && this.seen(p.x, 0, p.z))) wgt = near ? Math.exp(-Math.hypot(p.x - near.x, p.z - near.z) / scale) + 1e-4 : 1;
      weights.push(wgt);
      total += wgt;
    }
    if (total <= 0) return null;
    let r = this.rnd() * total;
    for (let i = 0; i < list.length; i++) if ((r -= weights[i]) <= 0 && weights[i] > 0) return list[i];
    return null;
  }

  /** A free seat at the gate, nearest the desk first (out of sight, if asked). */
  private freeSeat(seats: Seat[], near: V2, unseen: boolean) {
    let best: Seat | null = null;
    let bd = Infinity;
    for (const s of seats) {
      if (this.claims.has(s) || (unseen && this.seen(s.x, 0.5, s.z))) continue;
      const d = Math.hypot(s.x - near.x, s.z - near.z);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** Where the visitor is (or the camera): people's choices drift towards it. */
  private focus(): V2 {
    const v = this.visitor;
    return v ? { x: v.x, z: v.z } : { x: this.camPos.x, z: this.camPos.z };
  }

  // ---- seats and beds

  /** Sit down at once (when a place wakes, or someone is put at the gate). */
  private sitNow(w: Walker, s: Seat) {
    this.appear(w);
    w.scripted = true;
    w.heading = s.yaw;
    w.faceHeading = s.yaw;
    w.x = s.x;
    w.z = s.z;
    w.y = s.y - w.rig.seatDrop;
    w.rig.setBase('sit');
    w.doing = 'sit';
    this.putThingsDown(w, s);
  }

  private *sitOn(w: Walker, s: Seat): Task {
    this.claimSpot(w, s);
    yield* this.walkTo(w, s.approach.x, s.approach.z, 0.25);
    yield* this.turnTo(w, s.yaw);
    w.rig.setBase('sit');
    this.putThingsDown(w, s);
    yield* this.glide(w, { x: s.x, y: s.y - w.rig.seatDrop, z: s.z }, 0.9, false, false);
    w.doing = 'sit';
  }

  private *standUp(w: Walker): Task {
    const s = w.claim as Seat | null;
    w.rig.setBase('stand');
    if (s && 'approach' in s) yield* this.glide(w, { x: s.approach.x, y: 0, z: s.approach.z }, 0.9, false, false);
    else w.y = 0;
    this.pickThingsUp(w);
    this.release(w);
    w.scripted = false;
  }

  /** Bags and cases put down beside a seat (cases stand by the approach, bags at the sitter's feet). */
  private putThingsDown(w: Walker, s: Seat) {
    const f = forward(s.yaw);
    const right = { x: -f.z, z: f.x };
    if (w.case && w.holding) {
      w.holding = false;
      w.caseAt = { x: s.approach.x + right.x * 0.45, y: 0, z: s.approach.z + right.z * 0.45, yaw: s.yaw, flat: false };
    }
    if (w.bag) w.bagDown = { x: s.x + f.x * 0.4 - right.x * 0.35, y: 0, z: s.z + f.z * 0.4 - right.z * 0.35, yaw: s.yaw + 0.4 };
  }

  private pickThingsUp(w: Walker) {
    if (w.case && w.caseAt) {
      w.holding = true;
      w.caseAt = null;
    }
    w.bagDown = null;
    w.hatDown = null;
  }

  /** Lie down on a towel, a lounger or in a hammock (at once when `instant`). */
  private *lieOn(w: Walker, b: LieSpot, instant: boolean): Task {
    this.claimSpot(w, b);
    if (!instant) yield* this.walkTo(w, b.approach.x, b.approach.z, 0.3);
    const f = forward(b.yaw);
    const right = { x: -f.z, z: f.x };
    // the bag and the hat go down beside the bed
    if (w.bag) w.bagDown = { x: b.approach.x + f.x * 0.3, y: 0, z: b.approach.z + f.z * 0.3, yaw: b.yaw + 1.2 };
    if (w.hat) w.hatDown = { x: b.approach.x - f.x * 0.25 + right.x * 0.2, y: 0.03, z: b.approach.z - f.z * 0.25 + right.z * 0.2, yaw: b.yaw };
    w.doing = b.kind;
    if (b.kind === 'lounger') {
      // the lounger's seat is under its middle, the sitter facing up its length
      const seatAt = { x: b.x - f.x * 0.1, y: 0.4 - w.rig.seatDrop, z: b.z - f.z * 0.1 };
      if (instant) this.placeAt(w, seatAt.x, seatAt.y, seatAt.z, b.yaw);
      else {
        yield* this.turnTo(w, b.yaw);
        w.rig.setBase('sit');
        yield* this.glide(w, seatAt, 0.8, false, false);
      }
      w.scripted = true;
      w.rig.setBase('sit');
      w.faceHeading = b.yaw;
      w.setPose(RECLINED, instant ? 0 : 1.2);
      return;
    }
    // on the towel or in the hammock: lying along it (a hammock's length is across its spot's facing)
    const along = b.kind === 'hammock' ? b.yaw + Math.PI / 2 : b.yaw;
    const up = this.rnd() < (b.kind === 'towel' ? 0.65 : 1);
    const at = { x: b.x, y: b.kind === 'hammock' ? 0.5 : 0, z: b.z };
    if (instant) this.placeAt(w, at.x, at.y, at.z, along);
    else {
      yield* this.glide(w, at, 0.8, false);
      yield* this.turnTo(w, along);
      w.rig.setBase('crouch');
      yield* this.wait(0.5);
    }
    w.scripted = true;
    w.faceHeading = along;
    w.rig.setBase('stand');
    w.setPose(up ? ON_BACK : ON_FRONT, instant ? 0 : 1.3);
  }

  private *getUp(w: Walker): Task {
    const b = w.claim as LieSpot | null;
    w.setPose(UPRIGHT, 1.1);
    // off a lounger from sitting; up off a towel or out of a hammock by way of a crouch
    w.rig.setBase(w.rig.pose === 'sit' ? 'sit' : 'crouch');
    yield* this.wait(1.1);
    w.rig.setBase('stand');
    if (b && 'approach' in b) yield* this.glide(w, { x: b.approach.x, y: 0, z: b.approach.z }, 0.9, true);
    else w.y = 0;
    this.pickThingsUp(w);
    this.release(w);
    w.scripted = false;
  }

  /** Stand somewhere facing something (a window, a shop's shelves, a belt, a game) for a while. */
  private *standAt(w: Walker, s: Spot, seconds: number, instant: boolean, mood: 'look' | 'talk' | 'cheer' | 'browse' = 'look'): Task {
    this.claimSpot(w, s);
    if (instant) this.placeAt(w, s.x, 0, s.z, s.yaw);
    else yield* this.walkTo(w, s.x, s.z, 0.3);
    w.faceHeading = s.yaw;
    if (mood === 'talk') w.rig.setBase('talk');
    let t = seconds;
    let next = 2 + this.rnd() * 4;
    while ((t -= this.dt) > 0) {
      if ((next -= this.dt) <= 0) {
        next = 3 + this.rnd() * 6;
        if (mood === 'browse' && this.rnd() < 0.6) w.rig.play('Interact', 0.8 + this.rnd() * 0.4);
        if (mood === 'cheer') {
          const c = this.rnd();
          if (c < 0.3) w.rig.armsUp = 1;
          else if (c < 0.5) w.rig.wave(1.5);
          else if (c < 0.6) w.rig.play('Jump_Start', 1);
          next = 2 + this.rnd() * 4;
        }
        if (mood === 'look' && this.rnd() < 0.4) w.faceHeading = s.yaw + (this.rnd() - 0.5) * 0.9;
      }
      if (w.rig.armsUp > 0) w.rig.armsUp = Math.max(0, w.rig.armsUp - this.dt * 0.9);
      yield;
    }
    w.rig.armsUp = 0;
    w.rig.setBase('stand');
    this.release(w);
  }

  private placeAt(w: Walker, x: number, y: number, z: number, yaw: number) {
    this.appear(w);
    w.x = x;
    w.y = y;
    w.z = z;
    w.heading = yaw;
    w.faceHeading = yaw;
  }

  // ----------------------------------------------------------------------------------------------
  // Lives
  // ----------------------------------------------------------------------------------------------

  /** What someone does next (`seed`: the place just woke; put them in the middle of it). */
  private *life(w: Walker, seed: boolean): Task {
    switch (w.role) {
      case 'traveller':
        yield* this.homeTraveller(w, seed);
        break;
      case 'pilot':
      case 'crew':
        yield* this.crewMember(w);
        break;
      case 'stroller':
        yield* this.holidaymaker(w, seed, false);
        break;
      case 'swimmer':
        yield* this.holidaymaker(w, seed, true);
        break;
      case 'departing':
        yield* this.islandDeparture(w, seed);
        break;
      case 'attendant':
        // only out on the apron while the visitor's flight boards or unloads
        if (!w.away) this.vanish(w);
        yield* this.wait(5);
        break;
    }
  }

  // ---- Funfair International

  private *homeTraveller(w: Walker, seed: boolean): Task {
    const H = this.home;
    const f = this.focus();
    if (seed) {
      // somewhere along the way through the terminal, likelier near the visitor
      yield* this.homeStart(w, f);
      return;
    }
    // a new life: most are dropped off for a flight; some come off one at another gate; and when
    // the visitor is airside, some are simply there already (come through security unseen)
    const r = this.rnd();
    if (r < 0.25) yield* this.arrival(w);
    else if (f.z > this.airsideZ && r < 0.6) {
      const shop = this.rnd() < 0.6;
      const s = this.pick(shop ? H.shops : H.windows, f, 60, true);
      if (s) {
        this.reset(w);
        w.doing = shop ? 'shopping' : 'plane-spotting';
        yield* this.standAt(w, s, 5 + this.rnd() * 15, true, shop ? 'browse' : 'look');
        yield* this.toGate(w);
      } else yield* this.departure(w, 'kerb');
    } else yield* this.departure(w, 'kerb');
  }

  /** Put a traveller straight into the middle of a stage of their journey: which stage, weighted by how busy it is and how near the visitor. */
  private *homeStart(w: Walker, f: V2): Task {
    const H = this.home;
    const others = [1, 2, 4, 5, 6];
    const kinds: { kind: 'gate3' | 'gate' | 'shop' | 'window' | 'checkIn' | 'hall' | 'hallShop' | 'belt'; base: number; spots: readonly V2[] }[] = [
      { kind: 'gate3', base: 3, spots: H.gateSeats[3] },
      { kind: 'gate', base: 1.2, spots: others.flatMap((g) => H.gateSeats[g]) },
      { kind: 'shop', base: 1.2, spots: H.shops },
      { kind: 'window', base: 0.8, spots: H.windows },
      { kind: 'checkIn', base: w.bigCase ? 2.5 : 0.6, spots: H.checkIn },
      { kind: 'hall', base: 1, spots: H.hall },
      { kind: 'hallShop', base: 0.8, spots: H.hallShops },
      { kind: 'belt', base: 0.8, spots: H.belts },
    ];
    let total = 0;
    const weights = kinds.map((k) => {
      let d = Infinity;
      for (const s of k.spots) d = Math.min(d, Math.hypot(s.x - f.x, s.z - f.z));
      const wgt = k.spots.length ? k.base * (0.15 + Math.exp(-d / 60)) : 0;
      total += wgt;
      return wgt;
    });
    let r = this.rnd() * total;
    const k = kinds.find((_, i) => (r -= weights[i]) <= 0)?.kind ?? 'hall';
    switch (k) {
      case 'gate3':
      case 'gate': {
        let g = 3;
        if (k === 'gate') {
          // the other gate nearest the visitor, most likely
          const gw = others.map((n) => Math.exp(-Math.hypot(H.gates[n].desk.x - f.x, H.gates[n].desk.z - f.z) / 80) + 0.05);
          let q = this.rnd() * gw.reduce((a, b) => a + b, 0);
          g = others.find((_, i) => (q -= gw[i]) <= 0) ?? 1;
        }
        if (g === 3 && this.preQueueOpen('home') && this.rnd() < 0.6) {
          this.reset(w);
          yield* this.preQueue(w, true);
          return;
        }
        const s = this.pick(H.gateSeats[g], f, 40);
        if (!s) break;
        this.claimSpot(w, s);
        this.sitNow(w, s);
        yield* this.atGate(w, g);
        return;
      }
      case 'shop':
      case 'window': {
        const s = this.pick(k === 'shop' ? H.shops : H.windows, f, 60);
        if (!s) break;
        w.doing = k === 'shop' ? 'shopping' : 'plane-spotting';
        yield* this.standAt(w, s, 4 + this.rnd() * 20, true, k === 'shop' ? 'browse' : 'look');
        yield* this.toGate(w);
        return;
      }
      case 'checkIn': {
        const s = this.pick(H.checkIn, f, 40);
        if (!s) break;
        this.claimSpot(w, s);
        this.placeAt(w, s.x, 0, s.z, s.yaw);
        yield* this.checkIn(w, s);
        yield* this.departure(w, 'security');
        return;
      }
      case 'hall':
      case 'hallShop': {
        const s = this.pick(k === 'hall' ? H.hall : H.hallShops, f, 60);
        if (!s) break;
        w.doing = k === 'hall' ? 'meeting someone' : 'shopping';
        yield* this.standAt(w, s, 6 + this.rnd() * 30, true, k === 'hall' ? 'talk' : 'browse');
        // seeing someone off (and going home), or about to check in themselves
        if (this.rnd() < 0.35) yield* this.leaveByKerb(w);
        else yield* this.departure(w, 'hall');
        return;
      }
      case 'belt': {
        const b = this.pick(H.belts, f, 40);
        if (!b) break;
        w.holding = !w.bigCase && !!w.case;
        yield* this.collect(w, b, true);
        yield* this.homeOut(w);
        return;
      }
    }
    yield* this.later(w, 1 + this.rnd() * 10);
  }

  private otherGate() {
    const g = [1, 2, 4, 5, 6];
    return g[Math.floor(this.rnd() * g.length)];
  }

  /** From the kerb (or a later stage) to a seat at a gate. */
  private *departure(w: Walker, from: 'kerb' | 'hall' | 'security'): Task {
    const H = this.home;
    if (from === 'kerb') {
      // dropped off at the kerb by a door, when no one's looking at it
      const door = H.kerb.departures[Math.floor(this.rnd() * H.kerb.departures.length)];
      const x = door.x + (this.rnd() - 0.5) * 5;
      while (this.seen(x, 0, door.z)) yield;
      this.reset(w);
      this.placeAt(w, x, 0, door.z, 0);
      w.doing = 'arriving';
      yield* this.walkTo(w, door.x + (this.rnd() - 0.5) * 2, 443 + this.rnd() * 3);
      // goodbyes in the hall, or a look in its shops, now and then
      if (this.rnd() < 0.3) {
        const s = this.pick(H.hall, { x: w.x, z: w.z }, 60);
        if (s) {
          w.doing = 'saying goodbye';
          yield* this.standAt(w, s, 8 + this.rnd() * 18, false, 'talk');
        }
      } else if (this.rnd() < 0.25) {
        const s = this.pick(H.hallShops, { x: w.x, z: w.z }, 40);
        if (s) {
          w.doing = 'shopping';
          yield* this.standAt(w, s, 5 + this.rnd() * 12, false, 'browse');
        }
      }
    }
    if (from !== 'security' && ((w.bigCase && w.case) || this.rnd() < 0.35)) {
      // the big case is checked in; most with only cabin bags go straight through (some see the desk anyway)
      const desk = this.pick(H.checkIn, { x: w.x, z: w.z }, 60);
      if (desk) {
        this.claimSpot(w, desk);
        w.doing = 'to check-in';
        yield* this.walkTo(w, desk.x, desk.z, 0.25);
        yield* this.checkIn(w, desk);
      }
    }
    yield* this.security(w);
    // a look round the shops, the window, then the gate
    if (this.rnd() < 0.5) {
      const s = this.pick(H.shops, { x: w.x, z: w.z }, 50);
      if (s) {
        w.doing = 'shopping';
        yield* this.standAt(w, s, 6 + this.rnd() * 14, false, 'browse');
      }
    }
    yield* this.toGate(w);
  }

  private *toGate(w: Walker): Task {
    const H = this.home;
    if (this.rnd() < 0.25) {
      const s = this.pick(H.windows, { x: w.x, z: w.z }, 60);
      if (s) {
        w.doing = 'plane-spotting';
        yield* this.standAt(w, s, 12 + this.rnd() * 30, false);
      }
    }
    // gate 3 (the visitor's flight) gets the most, but not everyone: the other gates have flights too
    let at3 = 0;
    for (const o of this.byRegion.home) if (o.doing === 'waiting for FA101' || o.doing === 'queueing early') at3++;
    const g = this.rnd() < 0.6 && at3 < this.byRegion.home.length * 0.4 ? 3 : this.otherGate();
    const s = this.pick(H.gateSeats[g], g === 3 ? { x: -30, z: 528 } : null, 30);
    if (!s) {
      yield* this.leaveByGate(w, g);
      return;
    }
    w.doing = `to gate ${g}`;
    yield* this.sitOn(w, s);
    yield* this.atGate(w, g);
  }

  /** Waiting at a gate: gate 3's wait for the visitor's flight; the others board their own in time. */
  private *atGate(w: Walker, g: number): Task {
    w.doing = g === 3 ? 'waiting for FA101' : `waiting at gate ${g}`;
    if (g === 3) {
      // (board() takes them from here, or from the queue at the desk they go and stand in early;
      // now and then someone gets up to stretch their legs)
      for (let t = 90 + this.rnd() * 180; t > 0; t -= this.dt) {
        if (this.preQueueOpen('home') && this.rnd() < this.dt / 25) {
          yield* this.preQueue(w, false);
          return;
        }
        yield;
      }
      yield* this.standUp(w);
      yield* this.toGate(w);
      return;
    }
    // (while the visitor is landside the other gates' flights go sooner, so more of the travellers
    // are out in the hall, where they can be seen, than sat at gates nobody is looking at)
    yield* this.wait((40 + this.rnd() * 110) * (this.landside() ? 0.35 : 1));
    yield* this.standUp(w);
    yield* this.leaveByGate(w, g);
  }

  /** Is the visitor (or the camera) on the landside of security? */
  private landside() {
    return this.focus().z < this.airsideZ;
  }

  /** Boarding another flight: the gate's desk, the boarding area, up the escalator and out of sight onto the bridge. */
  private *leaveByGate(w: Walker, g: number): Task {
    const way = this.home.gates[g];
    w.doing = `boarding at gate ${g}`;
    yield* this.walkTo(w, way.desk.x, way.desk.z, 0.5);
    w.rig.play('Interact', 1.2);
    yield* this.wait(1.2);
    yield* this.walkPoints(w, way.pen);
    for (const p of way.up) yield* this.escalate(w, p);
    this.vanish(w);
    yield* this.wait(30 + this.rnd() * 60);
  }

  /** Off a flight at one of the other gates: down from the bridge, to the belts, out to the kerb. */
  private *arrival(w: Walker): Task {
    if (this.landside() && this.rnd() < 0.7) {
      // with the visitor landside, most of the walk from the gate would go unseen: start at the belts
      const b = this.pick(this.home.belts, this.focus(), 60, true);
      if (b) {
        this.reset(w);
        w.holding = !w.bigCase && !!w.case;
        yield* this.collect(w, b, true);
        yield* this.homeOut(w);
        return;
      }
    }
    const g = this.otherGate();
    const way = this.home.gates[g];
    const top = way.up[way.up.length - 1];
    while (this.seen(top.x, top.y, top.z, 60)) yield;
    this.reset(w);
    w.holding = !w.bigCase && !!w.case;
    this.placeAt(w, top.x, top.y, top.z, 0);
    w.doing = 'arriving off a flight';
    for (let i = way.up.length - 2; i >= 0; i--) yield* this.escalate(w, way.up[i]);
    w.y = 0;
    w.scripted = false;
    yield* this.walkPoints(w, [...way.pen].reverse().slice(1));
    yield* this.reclaim(w);
  }

  /** Reclaim: a belt (and the bag, for those who checked one), then the way out. */
  private *reclaim(w: Walker): Task {
    const H = this.home;
    const b = this.pick(H.belts, { x: w.x, z: w.z }, 40);
    if (b) yield* this.collect(w, b, false);
    yield* this.homeOut(w);
  }

  /** At a belt, waiting; those who checked a bag lift it off when it comes round. */
  private *collect(w: Walker, b: Spot, instant: boolean): Task {
    w.doing = 'waiting for bags';
    this.claimSpot(w, b);
    if (instant) this.placeAt(w, b.x, 0, b.z, b.yaw);
    else yield* this.walkTo(w, b.x, b.z, 0.3);
    w.faceHeading = b.yaw;
    yield* this.wait(6 + this.rnd() * 16);
    if (w.bigCase && w.case && !w.holding) {
      w.rig.play('Interact', 1);
      yield* this.wait(0.6);
      w.holding = true;
      yield* this.wait(0.6);
    }
    this.release(w);
  }

  /** Out of reclaim into the arrivals hall (perhaps met there), and away from the kerb. */
  private *homeOut(w: Walker): Task {
    const H = this.home;
    yield* this.walkTo(w, H.reclaimExit.x, H.reclaimExit.z, 0.8);
    if (this.rnd() < 0.3) {
      const s = this.pick(H.hall, { x: w.x, z: w.z }, 30);
      if (s) {
        w.doing = 'met in the hall';
        yield* this.standAt(w, s, 5 + this.rnd() * 10, false, 'talk');
      }
    }
    yield* this.leaveByKerb(w);
  }

  private *leaveByKerb(w: Walker): Task {
    const H = this.home;
    const door = H.kerb.arrivals[Math.floor(this.rnd() * H.kerb.arrivals.length)];
    w.doing = 'leaving';
    yield* this.walkTo(w, door.x, 443, 0.6);
    yield* this.walkTo(w, door.x + (this.rnd() - 0.5) * 6, door.z, 0.6);
    // picked up at the kerb: gone once nobody is looking
    while (this.seen(w.x, 0, w.z, 40)) yield;
    this.vanish(w);
    yield* this.wait(20 + this.rnd() * 50);
  }

  /** At a check-in desk: hand the case over; it goes onto the scale and off along the belt. */
  private *checkIn(w: Walker, desk: Spot): Task {
    w.doing = 'checking in';
    w.faceHeading = desk.yaw;
    yield* this.wait(0.8 + this.rnd());
    w.rig.play('Interact', 0.9);
    yield* this.wait(0.7);
    const f = forward(desk.yaw);
    if (w.case && w.bigCase && w.holding) {
      // onto the bag scale beside the desk, laid on its back, then away along the belt behind the desks
      w.holding = false;
      const start = { x: desk.x + f.x * 0.9, z: desk.z + f.z * 0.9 + 0.75 };
      const c = { x: start.x, y: 0.42, z: start.z, yaw: desk.yaw + Math.PI / 2, flat: true };
      w.caseAt = c;
      yield* this.wait(1.6 + this.rnd() * 1.5);
      for (let t = 0; t < 2.2; t += this.dt) {
        const k = t / 2.2;
        c.x = start.x + f.x * 1.6 * k;
        c.z = start.z + f.z * 1.6 * k;
        c.y = 0.42 + 0.06 * k;
        yield;
      }
      w.caseAt = null;
    }
    yield* this.wait(1.5 + this.rnd() * 3);
    w.rig.play('Interact', 1.1);
    yield* this.wait(1.2);
    this.release(w);
  }

  /** Through security: a lane's entry, the arch (a pause in it), out airside. */
  private *security(w: Walker): Task {
    const lanes = w.region === 'home' ? this.home.lanes : this.isle.lanes;
    // the nearest lane, give or take (people don't all pile into one)
    let lane = lanes[0];
    let best = Infinity;
    for (const l of lanes) {
      const d = Math.hypot(l.entry.x - w.x, l.entry.z - w.z) + this.rnd() * 20;
      if (d < best) {
        best = d;
        lane = l;
      }
    }
    w.doing = 'security';
    yield* this.walkTo(w, lane.entry.x, lane.entry.z, 0.4);
    // one at a time through each arch
    while (this.claims.has(lane)) yield;
    this.claimSpot(w, lane);
    yield* this.walkPoints(w, lane.path.slice(0, 2), 0.2);
    yield* this.wait(0.8 + this.rnd() * 0.8);
    this.release(w);
    yield* this.walkPoints(w, lane.path.slice(2), 0.4);
  }

  // ---- the crew

  private crewSchedule() {
    if (this.crewOut || this.t < this.crewDue) return;
    const start = this.home.crewStart;
    if (this.seen(start.x, 0, start.z, 70)) return;
    // (whoever is at the aircraft door greeting stays there)
    const crew = this.byRegion.home.filter((w) => (w.role === 'pilot' || w.role === 'crew') && w !== this.run?.greeter);
    if (!crew.length) return;
    this.crewOut = true;
    // in pairs: the pilots first, then the cabin crew, a couple of paces apart
    crew.forEach((w, i) => {
      this.reset(w);
      const row = Math.floor(i / 2);
      const side = i % 2 ? 0.55 : -0.55;
      this.placeAt(w, start.x + row * 1.8, 0, start.z + side, Math.PI / 2);
      w.task = this.crewWalk(w, row * 0.25, i === crew.length - 1);
    });
  }

  private *crewWalk(w: Walker, delay: number, last: boolean): Task {
    w.doing = 'crew to gate 3';
    w.pace = 1.3;
    yield* this.wait(delay);
    const way = this.home.gates[3];
    yield* this.walkTo(w, way.pen[0].x, way.pen[0].z - 0.8, 0.6);
    yield* this.walkPoints(w, way.pen);
    for (const p of way.up) yield* this.escalate(w, p);
    this.vanish(w);
    if (last) {
      this.crewOut = false;
      this.crewDue = this.t + 200 + this.rnd() * 160;
    }
    yield* this.crewMember(w);
  }

  /** Between walks the crew are aboard (out of the world); one comes to the door for the visitor's flight. */
  private *crewMember(w: Walker): Task {
    if (!w.away) this.vanish(w);
    for (;;) yield;
  }

  /** The member of cabin crew who stands just inside the door, greeting (or seeing off) each passenger. */
  private doorCrew(region: Region, run: Run): Walker | null {
    const end = run.kind === 'board' ? run.line.pts.length - 1 : 0;
    const door = run.line.pts[end];
    const prev = run.line.pts[run.kind === 'board' ? end - 1 : 1];
    if (!door || !prev) return null;
    const w = this.byRegion[region].find((c) => c.role === 'crew' && (c.away || !c.visible));
    if (!w) return null;
    this.reset(w);
    // into the aircraft past the sill, across the vestibule, facing back at the door
    const dx = door.x - prev.x;
    const dz = door.z - prev.z;
    const d = Math.hypot(dx, dz) || 1;
    this.placeAt(w, door.x + (dx / d) * 1.15, door.y, door.z + (dz / d) * 1.15, Math.atan2(dx / d, dz / d));
    w.scripted = true;
    w.holding = false;
    w.doing = 'greeting';
    w.task = this.greet(w, run);
    return w;
  }

  private *greet(w: Walker, run: Run): Task {
    let seen = run.count;
    while (!run.done) {
      if (run.count > seen) {
        seen = run.count;
        if (this.rnd() < 0.5) w.rig.wave(1.2);
      }
      yield;
    }
    yield* this.wait(3);
    this.vanish(w);
    yield* this.crewMember(w);
  }

  // ---- the visitor's flight: on the line

  private *boarder(w: Walker, run: Run): Task {
    // the back of the queue: a pace behind everyone waiting to be scanned, and everyone on their way to it
    const back = () => run.scanS - (run.queue.length - run.released + run.joining) * QUEUE_GAP;
    // the nearer the desk, the sooner they stir; while the queue reaches back to its end the rest stay sat
    yield* this.wait(Math.min(3, w.lineOrder * 0.15) + this.rnd() * 0.8);
    while (!run.finished && back() < 0) yield;
    if (run.finished) return;
    run.joining++;
    w.hurry = 1.4;
    const place = back();
    if (w.claim && 'approach' in w.claim) yield* this.standUp(w);
    this.release(w);
    run.line.at(place, this.tmp);
    w.doing = 'queueing';
    yield* this.walkTo(w, this.tmp.x, this.tmp.z, 0.35);
    run.joining--;
    w.hurry = 1;
    if (run.finished) return;
    // into the queue behind whoever is last in it now (runLines moves them from here)
    const last = run.queue[run.queue.length - 1];
    w.lineS = Math.max(0, Math.min(place, last ? last.lineS - QUEUE_GAP : run.scanS));
    w.lineV = 0;
    run.queue.push(w);
    w.onLine = true;
    this.alongLine(w, run);
    yield* this.onTheLine(w, run);
  }

  /** On the line: runLines moves them, till they're aboard. */
  private *onTheLine(w: Walker, run: Run): Task {
    while (w.line === run) yield;
  }

  // ---- the visitor's flight: the queue before it's called

  private leavePreQueue(w: Walker) {
    const q = this.preQ[w.region];
    const i = q.indexOf(w);
    if (i >= 0) q.splice(i, 1);
  }

  /** Room in the queue at the visitor's flight's desk (and no boarding under way)? */
  private preQueueOpen(region: Region) {
    return !this.run && this.preQ[region].length < PRE_QUEUE[region];
  }

  /**
   * Up to the desk early, to stand in line before boarding's called: shuffling up as those ahead
   * give up and sit down again, which they do after a while (board() takes them from here).
   */
  private *preQueue(w: Walker, instant: boolean): Task {
    const q = this.preQ[w.region];
    const line = this.preLine[w.region];
    if (w.claim && 'approach' in w.claim && !instant) yield* this.standUp(w);
    this.release(w);
    q.push(w);
    w.doing = 'queueing early';
    let slot = -1;
    let patience = 120 + this.rnd() * 150;
    let fidget = 3 + this.rnd() * 5;
    const to: V3 = { x: 0, y: 0, z: 0 };
    while (q.includes(w)) {
      const i = q.indexOf(w);
      if (i !== slot) {
        slot = i;
        line.at(line.length - i * QUEUE_GAP, to);
        const yaw = Number.isNaN(line.heading) ? w.heading : line.heading;
        if (instant) {
          this.placeAt(w, to.x, 0, to.z, yaw);
          instant = false;
        } else {
          if (Math.hypot(to.x - w.x, to.z - w.z) > 1.2) yield* this.walkTo(w, to.x, to.z, 0.4);
          if (!q.includes(w)) break;
          yield* this.glide(w, { x: to.x, y: 0, z: to.z }, 0.7);
        }
        w.scripted = true;
        w.faceHeading = yaw;
        continue;
      }
      if ((fidget -= this.dt) <= 0) {
        fidget = 4 + this.rnd() * 8;
        const c = this.rnd();
        if (c < 0.3) w.rig.play('Interact', 0.8);
        else if (c < 0.5) w.rig.setBase(w.rig.pose === 'talk' ? 'stand' : 'talk');
      }
      if ((patience -= this.dt) <= 0) {
        // tired of standing: back to a seat for a bit
        this.leavePreQueue(w);
        w.rig.setBase('stand');
        w.scripted = false;
        if (w.region === 'home') yield* this.toGate(w);
        else yield* this.islandLounge(w);
        return;
      }
      yield;
    }
    w.rig.setBase('stand');
  }

  private *deplaner(w: Walker, run: Run): Task {
    w.doing = 'deplaning';
    // they step out of the door one after another (runLines lets each out), and walk the line to its end
    while (w.line === run) yield;
    if (w.away) return;
    // off the walk: home to collect their bags and leave; on the island, into the holiday
    w.scripted = false;
    w.y = 0;
    if (w.region === 'home') yield* this.reclaim(w);
    else if (w.role === 'departing') yield* this.toHotel(w);
    else yield* this.holidaymaker(w, false, false);
  }

  /** Off the island's flight with a case: away along the promenade to the hotels, out of sight. */
  private *toHotel(w: Walker): Task {
    const I = this.isle;
    const p = this.pick(I.promenade, { x: w.x, z: w.z + 200 }, 200);
    w.doing = 'to the hotel';
    if (p) yield* this.walkTo(w, p.x, p.z, 1);
    for (let tries = 0; tries < 4 && this.seen(w.x, 0, w.z, 50); tries++) {
      const q = this.pick(I.wander, { x: w.x, z: w.z }, 60);
      if (!q) break;
      yield* this.walkTo(w, q.x, q.z, 1);
    }
    while (this.seen(w.x, 0, w.z, 50)) yield;
    this.vanish(w);
    yield* this.wait(60 + this.rnd() * 90);
  }

  /** Put a walker on the line at its lineS (position and facing). */
  private alongLine(w: Walker, run: Run) {
    run.line.at(w.lineS, this.tmp);
    w.x = this.tmp.x;
    w.y = this.tmp.y;
    w.z = this.tmp.z;
    w.scripted = true;
    if (!Number.isNaN(run.line.heading)) w.faceHeading = run.line.heading;
  }

  /** Moves everyone on the visitor's flight's line: the queue shuffling up, the scans, the walk. */
  private runLines() {
    const run = this.run;
    if (!run || run.finished || run.region !== this.awake) return;
    const dt = this.dt;
    const L = run.line.length;
    // (boarding goes by the order people joined the queue; deplaning by the order they leave the aircraft)
    const order = run.kind === 'board' ? run.queue : run.members;
    let left = 0;
    for (let i = 0; i < order.length; i++) {
      const w: Walker = order[i];
      if (w.line !== run) continue;
      left++;
      const ahead: Walker | null = i > 0 ? order[i - 1] : null;
      const aheadOn = ahead !== null && ahead.line === run;
      const aheadS = aheadOn ? ahead.lineS : Infinity;
      if (run.kind === 'deplane' && !w.onLine) {
        // out of the door when the one before is clear of it
        if (aheadOn && (!ahead.onLine || aheadS < WALK_GAP + 0.15)) continue;
        if (this.t - run.lastAppear < OUT_EVERY[run.region]) continue;
        run.lastAppear = this.t;
        this.appear(w);
        w.onLine = true;
        w.lineS = 0;
        // (out of the door already walking)
        w.lineV = 1.4;
        this.alongLine(w, run);
        w.heading = w.faceHeading ?? w.heading;
        continue;
      }
      if (!w.onLine) continue;
      // how far they may go: behind the one ahead, and (boarding) not past the desk till scanned
      const behind = aheadS - (w.lineS < run.scanS ? QUEUE_GAP : WALK_GAP);
      let cap = Math.min(L, behind);
      // (following someone who is walking: keep up with them, not slow as if coming to a stop)
      let leadV = aheadOn && cap === behind ? ahead.lineV : 0;
      if (run.kind === 'board' && i >= run.released && run.scanS < cap) {
        cap = run.scanS;
        leadV = 0;
      }
      run.line.at(w.lineS, this.tmp);
      const steep = Math.abs(run.line.slope);
      // escalators carry people standing; stairs are climbed (or come down) at a careful pace
      const riding = run.escalators && steep > 0.3;
      // in the queue at their own pace; through the gate (or off the aircraft) briskly, walking up
      // or down the escalator as it moves, and slower on the airstairs
      const brisk = run.kind === 'deplane' ? w.lineS < run.clearS + 6 : w.lineS >= run.scanS;
      // (and out of sight, where nobody can tell, quicker still: the bridge is long)
      const pace = (brisk ? THREE.MathUtils.clamp(w.pace * 1.4, BRISK.min, BRISK.max) : w.pace) * (w.visible ? 1 : 1.8);
      const want = riding ? ESCALATOR.speed + (brisk ? ESCALATOR.walk : 0) : pace / (1 + 2 * steep);
      const gap = cap - w.lineS;
      const target = gap > 0.02 ? Math.min(want, leadV + 0.35 + gap * 2.4) : Math.min(want, leadV);
      w.lineV += (target - w.lineV) * Math.min(1, dt * 7);
      w.lineS = Math.max(w.lineS, Math.min(cap, w.lineS + w.lineV * dt));
      this.alongLine(w, run);
      // the legs: still when standing on an escalator, walking otherwise
      w.speed = riding ? Math.max(0, w.lineV - ESCALATOR.speed) : w.lineV;
      // the desk: a pause, the boarding pass scanned, then through
      if (run.kind === 'board' && i === run.released && w.lineS >= run.scanS - 0.3) {
        if (run.headAt < 0) {
          run.headAt = this.t;
          if (run.desk) w.face = run.desk;
          w.rig.play('Interact', 1.3);
        }
        const interval = SCAN_EVERY;
        if (this.t - run.headAt > SCAN_PAUSE && this.t - run.lastRelease > interval) {
          run.released++;
          // (stepping off briskly, so the next in line can step up)
          w.lineV = Math.max(w.lineV, 1.0);
          run.lastRelease = this.t;
          run.headAt = -1;
          w.face = null;
        }
      }
      if (run.kind === 'board' && w.lineS >= L - 0.05) {
        // aboard
        this.vanish(w);
        run.count++;
        left--;
        w.task = this.later(w, 40 + this.rnd() * 80);
      } else if (run.kind === 'deplane') {
        if (w.lineS >= run.clearS && !w.counted) {
          w.counted = true;
          run.count++;
        }
        if (w.lineS >= L - 0.05) {
          this.offLine(w);
          left--;
        }
      }
    }
    if (run.kind === 'board' ? run.count >= run.members.length : left === 0) {
      run.finished = true;
      if (this.run === run) this.run = null;
    }
  }

  /** Off the end of a deplaning line, free to go about their day. */
  private offLine(w: Walker) {
    w.line = null;
    w.onLine = false;
    w.scripted = false;
    w.counted = false;
    w.face = null;
  }

  /** A ramp agent in hi-vis at the foot of the airstairs, waving the passengers along the walkway. */
  private stairsAttendant(run: Run): Walker | null {
    const w = this.byRegion.island.find((c) => c.role === 'attendant');
    if (!w) return null;
    // the stairs' foot: the last point of the walk on the apron before the line starts climbing
    const pts = run.line.pts;
    let i = run.kind === 'board' ? pts.findIndex((p, k) => k > 0 && p.y > 0.3) - 1 : pts.findIndex((p) => p.y < 0.05);
    if (i < 0) i = 0;
    const foot = pts[i];
    const next = pts[run.kind === 'board' ? Math.max(0, i - 1) : Math.min(pts.length - 1, i + 1)];
    const dx = next.x - foot.x;
    const dz = next.z - foot.z;
    const d = Math.hypot(dx, dz) || 1;
    this.reset(w);
    // beside the walkway, a couple of metres out from the stairs, facing the passengers
    this.placeAt(w, foot.x + (dx / d) * 2.2 + (-dz / d) * 1.8, 0, foot.z + (dz / d) * 2.2 + (dx / d) * 1.8, 0);
    w.faceHeading = Math.atan2(-(foot.x - w.x), -(foot.z - w.z));
    w.heading = w.faceHeading;
    w.doing = 'on the apron';
    w.task = this.attend(w, run);
    return w;
  }

  private *attend(w: Walker, run: Run): Task {
    let next = 2;
    while (!run.done) {
      if ((next -= this.dt) <= 0) {
        next = 3 + this.rnd() * 4;
        if (this.rnd() < 0.6) w.rig.wave(1.6);
      }
      yield;
    }
    yield* this.wait(4);
    while (this.seen(w.x, 0, w.z, 60)) yield;
    this.vanish(w);
  }

  // ---- Palm Cay

  private *islandDeparture(w: Walker, seed: boolean): Task {
    const I = this.isle;
    if (seed && this.preQueueOpen('island') && this.rnd() < 0.4) {
      this.reset(w);
      yield* this.preQueue(w, true);
      return;
    }
    if (seed && this.rnd() < 0.75) {
      const s = this.pick(I.lounge, { x: -40, z: 40618 }, 40);
      if (s) {
        this.claimSpot(w, s);
        this.sitNow(w, s);
        yield* this.islandLounge(w);
        return;
      }
    }
    // from the promenade, out of sight, up to the terminal
    const p = this.pick(I.promenade, null, 120, true);
    if (!p) {
      yield* this.later(w, 10);
      return;
    }
    this.reset(w);
    this.placeAt(w, p.x + (this.rnd() - 0.5) * 6, 0, p.z, 0);
    w.doing = 'to the airport';
    yield* this.walkTo(w, I.entrance.out.x, I.entrance.out.z, 0.8);
    yield* this.walkTo(w, I.entrance.in.x, I.entrance.in.z, 0.6);
    if (this.rnd() < 0.5) {
      const d = this.pick(I.checkIn, { x: w.x, z: w.z }, 40);
      if (d) {
        this.claimSpot(w, d);
        yield* this.walkTo(w, d.x, d.z, 0.25);
        w.faceHeading = d.yaw;
        w.doing = 'checking in';
        yield* this.wait(1);
        w.rig.play('Interact', 0.9);
        yield* this.wait(3 + this.rnd() * 4);
        this.release(w);
      }
    }
    yield* this.security(w);
    const s = this.pick(I.lounge, { x: -40, z: 40618 }, 40);
    if (s) {
      w.doing = 'to the lounge';
      yield* this.sitOn(w, s);
      yield* this.islandLounge(w);
    } else yield* this.islandGate1(w);
  }

  private *islandLounge(w: Walker): Task {
    w.doing = 'waiting for FA102';
    for (let t = 120 + this.rnd() * 300; t > 0; t -= this.dt) {
      if (this.preQueueOpen('island') && this.rnd() < this.dt / 30) {
        yield* this.preQueue(w, false);
        return;
      }
      yield;
    }
    yield* this.standUp(w);
    yield* this.islandGate1(w);
  }

  /** Off on one of the island's other flights, through gate 1. */
  private *islandGate1(w: Walker): Task {
    const I = this.isle;
    w.doing = 'boarding at gate 1';
    yield* this.walkTo(w, I.gate1.x, I.gate1.z + 1.5, 0.5);
    yield* this.walkPoints(w, [I.gate1]);
    this.vanish(w);
    yield* this.wait(40 + this.rnd() * 60);
  }

  /** A day at the beach: strollers keep to the paths, bars, benches and games; swimmers to the sand and the sea. */
  private *holidaymaker(w: Walker, seed: boolean, swimmer: boolean): Task {
    const I = this.isle;
    // just woken: straight into the middle of something, anywhere (nobody walks in from nowhere)
    let instant = seed;
    for (;;) {
      if (!instant && w.away) {
        // not yet anywhere (nothing was free, or back from a while away): from a path out of sight
        const p = this.pick([...I.promenade, ...I.wander], this.focus(), 2 * BEACH_FOCUS, true);
        if (!p) {
          yield* this.wait(3);
          continue;
        }
        this.reset(w);
        this.placeAt(w, p.x + (this.rnd() - 0.5) * 3, 0, p.z + (this.rnd() - 0.5) * 3, this.rnd() * Math.PI * 2);
      }
      const r = this.rnd();
      const near = this.focus();
      if (swimmer) {
        if (r < 0.45) {
          const b = this.pick(I.beds, near, BEACH_FOCUS);
          if (b) {
            yield* this.lieOn(w, b, instant);
            yield* this.wait(40 + this.rnd() * 140);
            yield* this.getUp(w);
          }
        } else if (r < 0.58 || (w.look.child && r < 0.7)) {
          const c = this.pick(I.castles, near, BEACH_FOCUS);
          if (c) yield* this.buildCastle(w, c, instant);
        } else if (r < 0.88) {
          const s = this.pick(I.shallows, near, BEACH_FOCUS);
          if (s) yield* this.paddle(w, s, instant);
        } else yield* this.stroll(w, instant);
      } else {
        if (r < 0.3) yield* this.stroll(w, instant);
        else if (r < 0.5) {
          const s = this.pick(I.bars, near, BEACH_FOCUS);
          if (s) yield* this.sitAWhile(w, s, instant, 40 + this.rnd() * 90, true);
        } else if (r < 0.68) {
          const s = this.pick(I.benches, near, BEACH_FOCUS);
          if (s) yield* this.sitAWhile(w, s, instant, 30 + this.rnd() * 80, false);
        } else if (r < 0.88) {
          const s = this.pick(I.watch, near, BEACH_FOCUS);
          if (s) {
            w.doing = 'watching the games';
            yield* this.standAt(w, s, 25 + this.rnd() * 50, instant, 'cheer');
          }
        } else {
          const b = this.pick(
            I.beds.filter((d) => d.kind !== 'towel'),
            near,
            BEACH_FOCUS,
          );
          if (b) {
            yield* this.lieOn(w, b, instant);
            yield* this.wait(30 + this.rnd() * 90);
            yield* this.getUp(w);
          }
        }
      }
      instant = false;
      yield;
    }
  }

  private *sitAWhile(w: Walker, s: Seat, instant: boolean, seconds: number, bar: boolean): Task {
    if (instant) {
      this.claimSpot(w, s);
      this.sitNow(w, s);
    } else yield* this.sitOn(w, s);
    w.doing = bar ? 'at the bar' : 'on a bench';
    let t = seconds;
    let next = 3 + this.rnd() * 5;
    while ((t -= this.dt) > 0) {
      if ((next -= this.dt) <= 0) {
        next = 4 + this.rnd() * 8;
        if (bar && this.rnd() < 0.6) w.rig.play('Interact', 0.7);
        else if (this.rnd() < 0.3) w.faceHeading = s.yaw + (this.rnd() - 0.5) * 0.8;
        else w.faceHeading = s.yaw;
      }
      yield;
    }
    yield* this.standUp(w);
  }

  /** A stroll: a few points along the promenade, the gardens and the top of the beach, pausing now and then. */
  private *stroll(w: Walker, instant: boolean): Task {
    const I = this.isle;
    const pts = [...I.promenade, ...I.wander];
    let at = this.pick(pts, instant ? this.focus() : { x: w.x, z: w.z }, 60);
    if (!at) return;
    w.doing = 'strolling';
    if (instant) this.placeAt(w, at.x + (this.rnd() - 0.5) * 4, 0, at.z + (this.rnd() - 0.5) * 4, this.rnd() * Math.PI * 2);
    const legs = 2 + Math.floor(this.rnd() * 3);
    for (let i = 0; i < legs; i++) {
      at = this.pick(pts, { x: w.x, z: w.z }, 45) ?? at;
      yield* this.walkTo(w, at.x + (this.rnd() - 0.5) * 5, at.z + (this.rnd() - 0.5) * 5, 0.8);
      if (this.rnd() < 0.5) {
        w.faceHeading = w.heading + (this.rnd() - 0.5) * 2;
        if (this.rnd() < 0.3) w.rig.setBase('talk');
        yield* this.wait(2 + this.rnd() * 5);
        w.rig.setBase('stand');
      }
    }
  }

  private *buildCastle(w: Walker, c: Spot, instant: boolean): Task {
    this.claimSpot(w, c);
    if (instant) this.placeAt(w, c.x, 0, c.z, c.yaw);
    else yield* this.walkTo(w, c.x, c.z, 0.3);
    w.faceHeading = c.yaw;
    w.rig.setBase('crouch');
    w.doing = 'building a sandcastle';
    let t = 40 + this.rnd() * 60;
    let next = 1 + this.rnd() * 2;
    while ((t -= this.dt) > 0) {
      if ((next -= this.dt) <= 0) {
        next = 2.5 + this.rnd() * 3;
        w.rig.play('Interact', 0.7 + this.rnd() * 0.5);
      }
      yield;
    }
    w.rig.setBase('stand');
    this.release(w);
  }

  /** Down to the water: paddling in the shallows, a splash about, maybe a swim further out. */
  private *paddle(w: Walker, s: Shallows, instant: boolean): Task {
    this.claimSpot(w, s);
    const edge = s.edge;
    const wade = s.wade[Math.floor(this.rnd() * s.wade.length)];
    const swim = this.rnd() < (w.look.child ? 0.2 : 0.55);
    if (instant) this.placeAt(w, wade.x, wade.y, wade.z, this.rnd() * Math.PI * 2);
    else yield* this.walkTo(w, edge.x, edge.z, 0.5);
    // the bag and the hat are left on the sand
    if (w.bag) w.bagDown = { x: edge.x + 0.4, y: 0, z: edge.z, yaw: 0.6 };
    if (w.hat) w.hatDown = { x: edge.x - 0.3, y: 0.03, z: edge.z + 0.2, yaw: 0 };
    if (!instant) {
      // down the wet sand into the water, slowing as it gets deeper
      yield* this.glideOverGround(w, { x: (edge.x + wade.x) / 2, z: (edge.z + wade.z) / 2 }, w.pace * 0.9);
      yield* this.glideOverGround(w, wade, 0.55);
    }
    w.scripted = true;
    w.doing = 'paddling';
    let t = 15 + this.rnd() * 30;
    let next = 1 + this.rnd() * 3;
    while ((t -= this.dt) > 0) {
      if ((next -= this.dt) <= 0) {
        next = 3 + this.rnd() * 5;
        const c = this.rnd();
        if (c < 0.3) w.rig.play('Jump_Start', 1.1);
        else if (c < 0.5) w.rig.wave(1.4);
        else if (c < 0.6) w.rig.play('Interact', 0.8);
        w.faceHeading = this.rnd() * Math.PI * 2;
      }
      yield;
    }
    if (swim) {
      // a swim: face down, along the swimming area and back
      w.doing = 'swimming';
      const out = s.swim[Math.floor(this.rnd() * s.swim.length)];
      yield* this.turnTo(w, yawTo(w, out));
      w.setPose(SWIMMING, 1.0);
      yield* this.swimTo(w, out);
      for (let i = 0; i < 2; i++) yield* this.swimTo(w, s.swim[Math.floor(this.rnd() * s.swim.length)]);
      yield* this.swimTo(w, wade);
      w.setPose(UPRIGHT, 1.0);
      w.y = wade.y;
      yield* this.wait(1);
    }
    // and out again
    w.doing = 'out of the sea';
    yield* this.glideOverGround(w, edge, w.pace * 0.8);
    w.y = 0;
    w.scripted = false;
    this.pickThingsUp(w);
    this.release(w);
  }

  /** Walk straight over the sand into (or out of) the sea, feet on the sea bed. */
  private *glideOverGround(w: Walker, to: V2, speed: number): Task {
    w.scripted = true;
    const fx = w.x;
    const fz = w.z;
    const len = Math.hypot(to.x - fx, to.z - fz);
    const dur = Math.max(0.2, len / speed);
    w.faceHeading = Math.atan2(-(to.x - fx), -(to.z - fz));
    for (let t = 0; t < dur; t += this.dt) {
      const k = t / dur;
      w.x = fx + (to.x - fx) * k;
      w.z = fz + (to.z - fz) * k;
      w.y = Math.min(0, groundY(w.x, w.z));
      // wading is slow going
      w.speed = (len / dur) * (1 - 0.45 * THREE.MathUtils.clamp(-w.y / 0.6, 0, 1));
      yield;
    }
    w.x = to.x;
    w.z = to.z;
    w.y = Math.min(0, groundY(w.x, w.z));
    w.speed = 0;
  }

  /** Swim to a point: the body at the surface, the walk cycle reading as a crawl's kicks and strokes. */
  private *swimTo(w: Walker, to: V2): Task {
    const fx = w.x;
    const fz = w.z;
    const len = Math.hypot(to.x - fx, to.z - fz);
    const dur = Math.max(0.5, len / 0.6);
    w.faceHeading = Math.atan2(-(to.x - fx), -(to.z - fz));
    for (let t = 0; t < dur; t += this.dt) {
      const k = t / dur;
      w.x = fx + (to.x - fx) * k;
      w.z = fz + (to.z - fz) * k;
      // the chest just under the surface, bobbing
      w.y = SEA_Y - 0.18 + Math.sin(this.t * 3 + w.index) * 0.03;
      w.speed = 0.75;
      yield;
    }
    w.speed = 0;
  }

  // ----------------------------------------------------------------------------------------------
  // Moving and drawing
  // ----------------------------------------------------------------------------------------------

  private move(list: Walker[]) {
    const dt = this.dt;
    const pl = this.visitor;
    for (const w of list) {
      if (w.away) continue;
      w.stepPose(dt);
      if (!w.scripted) {
        let vx = 0;
        let vz = 0;
        let want = 0;
        if (!w.arrived) {
          const t = w.route[w.ri];
          const dx = t.x - w.x;
          const dz = t.z - w.z;
          const d = Math.hypot(dx, dz);
          const last = w.ri === w.route.length - 1;
          // a corner is taken a little early, but only where the way on to the next is clear
          // (cutting it blind would walk them into the corner of whatever the route goes round)
          const next = last ? null : w.route[w.ri + 1];
          if (d < (last ? w.arriveR : 0.12) || (next && d < 0.9 && this.obs.clear(w.x, w.z, next.x, next.z, 0.3))) {
            w.ri++;
            w.resetProgress();
          } else {
            w.progress(d, dt);
            want = w.pace * w.hurry;
            if (last) want = Math.min(want, 0.3 + d * 1.2);
            vx = dx / d;
            vz = dz / d;
          }
        }
        // personal space: ease away from neighbours (and give the visitor room)
        let px = 0;
        let pz = 0;
        for (const o of list) {
          if (o === w || o.away) continue;
          const dx = w.x - o.x;
          const dz = w.z - o.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 0.45 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const push = (0.67 - d) / 0.67;
          px += (dx / d) * push;
          pz += (dz / d) * push;
        }
        if (pl) {
          const dx = w.x - pl.x;
          const dz = w.z - pl.z;
          const d = Math.hypot(dx, dz);
          if (d < 1.2 && d > 1e-4) {
            px += (dx / d) * (1.2 - d) * 3;
            pz += (dz / d) * (1.2 - d) * 3;
          }
        }
        w.speed += (want - w.speed) * Math.min(1, dt * 5);
        w.x += vx * w.speed * dt + px * dt * 1.2;
        w.z += vz * w.speed * dt + pz * dt * 1.2;
        this.obs.push(w, 0.28);
        w.y = 0;
        w.floor = 0;
        if (w.speed > 0.15) this.turn(w, Math.atan2(-vx, -vz), dt, 7);
      } else w.floor = w.y;
      if (w.speed <= 0.15 || w.scripted) {
        if (w.face) this.turn(w, Math.atan2(-(w.face.x - w.x), -(w.face.z - w.z)), dt, 3);
        else if (w.faceHeading !== null) this.turn(w, w.faceHeading, dt, w.line ? 6 : 4);
      }
      w.place();
    }
  }

  private turn(w: Walker, to: number, dt: number, rate: number) {
    const d = wrap(to - w.heading);
    w.heading += THREE.MathUtils.clamp(d, -rate * dt, rate * dt);
  }

  private draw(list: Walker[]) {
    const cp = this.camPos;
    for (const w of list) {
      if (w.away) continue;
      const d = Math.hypot(w.x - cp.x, w.y - cp.y, w.z - cp.z);
      this.sphere.center.set(w.x, w.y + w.look.height / 2, w.z);
      this.sphere.radius = w.look.height;
      const vis = d < DRAW && (d < 10 || this.frustum.intersectsSphere(this.sphere));
      w.visible = vis;
      w.rig.root.visible = vis;
      if (!vis) {
        this.hideProps(w);
        continue;
      }
      w.rig.setDetail(d < 22);
      w.animate(this.dt, d < 30 ? 1 : d < 70 ? 2 : 4, this.frame);
      if (d > PROP_RANGE) {
        this.hideProps(w);
        continue;
      }
      this.props(w, this.m4);
    }
  }

  /** Where each of their things is this frame: held, worn, or put down. */
  private props(w: Walker, m: THREE.Matrix4) {
    const upright = w.pose === UPRIGHT && w.poseK >= 1;
    const sitting = w.rig.pose === 'sit';
    if (w.case) {
      // the handle: pushed home when the case is laid on a belt, pulled up again when it's taken
      const handleTo = !w.holding && w.caseAt?.flat ? 0 : 1;
      w.handle += THREE.MathUtils.clamp(handleTo - w.handle, -this.dt * 2.5, this.dt * 2.5);
      if (w.holding && upright && !sitting) {
        // pulled along when walking (not when carried by an escalator), stood beside them otherwise
        const want = w.speed > 0.25 ? 1 : 0;
        w.caseState.pull += (want - w.caseState.pull) * Math.min(1, this.dt * 4);
        this.luggage.set(w.case, pulledCase(w.rig, w.heading, w.floor, w.caseState, w.case.scale, w.posed, m), w.handle);
      } else if (w.caseAt) {
        const c = w.caseAt;
        // a case laid on its back rests on its shell (its origin is at the back, by the wheels)
        this.luggage.set(w.case, standingCase(c.x, c.y + (c.flat ? CASE.d * w.case.scale : 0), c.z, c.yaw, c.flat, w.case.scale, m), w.handle);
      } else this.luggage.hide(w.case);
    }
    if (w.bag) {
      if (w.bagDown) {
        const b = w.bagDown;
        this.luggage.set(w.bag, putDown(b.x, b.y + (w.bag.kind === 'tote' ? 0.66 : 0.33), b.z, b.yaw, 1, m));
      } else if (upright && w.rig.pose !== 'crouch') this.luggage.set(w.bag, w.bag.kind === 'tote' ? toteOn(w.rig, w.heading, m) : backpackOn(w.rig, w.heading, m));
      else this.luggage.hide(w.bag);
    }
    if (w.hat) {
      if (w.hatDown) {
        const h = w.hatDown;
        this.luggage.set(w.hat, putDown(h.x, h.y + 0.04, h.z, h.yaw, w.hat.scale, m));
      } else if (upright && w.y > SEA_Y - 0.4) this.luggage.set(w.hat, hatOnHead(w.rig, w.heading, w.hat.scale, m));
      else this.luggage.hide(w.hat);
    }
  }
}
