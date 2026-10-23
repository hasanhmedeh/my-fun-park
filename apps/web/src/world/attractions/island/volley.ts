// Beach Volley: a stand-in-place game on Palm Cay's south beach. The visitor and an island partner
// play ten serves against two locals. Each serve is a timing shot: aim at the far court (the
// scoring rings are worth 1–3, and the coconut shy beyond the far end pays 5 a coconut), toss,
// and strike as the ball drops back to your reach, as the meter shows. The locals run down what
// they can (a hard topspin serve deep into a corner is an ace), dig it, set it and attack it back
// over: then it's the visitor's turn to dig with timing, their partner sets, and they spike it,
// aimed and timed again, past the block. Ten rallies make a round.
//
// The ball flies on real physics (volley-ball.ts: drag, Magnus dip, float wobble) in the court's
// own frame; the locals judge from a prediction of that same flight whether they can get there.
// Between rounds, while anyone is about, the four players keep a gentle warm-up rally going.

import * as THREE from 'three';
import type { Attraction, Ctx } from '../../context';
import type { PeopleFactory } from '../../crowd/people-factory';
import { lookKey, type Look } from '../../crowd/looks';
import type { Input } from '../../input';
import { mulberry } from '../../random';
import { PALETTE } from '../../textures';
import {
  attack,
  attackThrough,
  ball,
  copyBall,
  HALF_L,
  HALF_W,
  inCourt,
  lob,
  predict,
  SAND_Y,
  speedOf,
  STEP,
  stepBall,
  stepCheck,
  BALL_R,
  type Ball,
  type FlyOptions,
  type Hit,
} from './volley-ball';
import { BLEACHER, CATCH_Z, COCONUTS, COURT_ORIGIN, Court, SHY_BACK_Z, SHY_Z, toLocal, toWorld, UMPIRE } from './volley-court';
import { CourtFx } from './volley-fx';
import { Athlete, Fans, playerLooks, visitorBeachLook } from './volley-players';
import { digChance, ELEVS, grade, placeRings, points, reach, ringAt, SERVES, shot, TOLERANCE, type Grade, type Outcome, type Ring } from './volley-rules';
import './volley.css';

/** How long the round's last rally shows before the round wraps up on its own. */
const LAST_LOOK = 3;
/** How long a rally's result shows before the next serve. */
const BETWEEN = 2.6;
/** The serve: where the visitor stands (court frame), the toss, and the height they strike it at. */
const SERVE_SPOT = { x: 1.4, z: -9.7 };
const STRIKE_Y = 3.05;
/** The heights a dig and a set are played at. */
const DIG_Y = 0.78;
const SET_Y = 2.45;
/** The locals' skill (a dig's base chance), the visitor's running speed (the game runs them to the ball). */
const LOCAL_SKILL = 0.9;
const VISITOR_SPEED = 6.8;
const STORE_KEY = 'fair-volley';
/** The nearest to the net the visitor can aim (a jump serve can't drop any shorter). */
const AIM_NEAR = 1.6;

type Phase = 'idle' | 'aim' | 'toss' | 'play' | 'point' | 'over';
type Cam = 'player' | 'tv' | 'beach';
const CAM_LABEL: Record<Cam, string> = { player: '🎥 Player', tv: '📺 Courtside', beach: '🏖️ Beach' };
type Side = 1 | -1;

/** A touch the game plays when the ball's clock reaches `t` (a local's dig, the partner's set…). */
interface Contact {
  t: number;
  run: () => void;
}

/** The visitor's timing meter: from t0 to t1 on the ball's clock, perfect at `perfect`; `scale` < 1 is harder. */
interface Timing {
  kind: 'serve' | 'dig' | 'spike';
  t0: number;
  perfect: number;
  t1: number;
  scale: number;
}

const $ = (id: string) => document.getElementById(id)!;

export class Volley implements Attraction {
  private court: Court;
  private fx: CourtFx;
  private rnd = mulberry(Date.now() % 100000);
  private phase: Phase = 'idle';
  private phaseT = 0;
  /** The ball in play (court frame), its flight options, and what happens next. */
  private b: Ball = ball();
  private flying = false;
  private opts: FlyOptions = {};
  private contact: Contact | null = null;
  private timing: Timing | null = null;
  /** A ball that's already decided (into the net, off a coconut): how the rally ends when it lands. */
  private dead: Outcome | null = null;
  private acc = 0;
  /** Who touched the ball last, whether the locals touched the visitor's last attack, how many times it crossed. */
  private lastTouch: Side = -1;
  private serveInPlay = false;
  private touchedByLocals = false;
  private shanked = false;
  private blocked = false;
  private exchanges = 0;
  private coconutsThisRally = 0;
  private rings: Ring[] = [];
  /** The visitor's target (court frame), and which coconut it's on (−1: the court). */
  private target = new THREE.Vector3(0, SAND_Y, 5);
  private coconut = -1;
  private aimStepT = 0;
  private previewT = 0;
  private pointerAim = false;
  // the players: the visitor and their partner (near side, −z), the two locals (far side, +z), and
  // the island regular who keeps the visitor's place warm between rounds
  private me: Athlete;
  private partner: Athlete;
  private stand: Athlete;
  private locals: [Athlete, Athlete];
  private fans: Fans | null = null;
  private awake = true;
  private night = 0;
  private stats = { score: 0, aces: 0, coconuts: 0, streak: 0, bestStreak: 0, attacks: 0, onTarget: 0, served: 0, lost: 0 };
  private final: Record<string, number> | null = null;
  private best = 0;
  private introTimer = 0;
  private cam: Cam = 'player';
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camInit = false;
  private hud: HTMLElement;
  private toastT = 0;
  private gradeT = 0;
  private hudKey = '';
  private ray = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private focusV = new THREE.Vector3();
  /** The camera in the court's frame, this frame. */
  private camLocal = new THREE.Vector3();
  private probe: Ball = ball();
  /** The ambient warm-up's pause between dropped balls. */
  private ambientT = 0;
  active = false;
  input: Input | null = null;
  onFinish: (() => void) | null = null;
  /** The tenth rally is over: the round is done (fired once). */
  onComplete: (() => void) | null = null;

  constructor(private ctx: Ctx) {
    this.court = new Court(ctx);
    ctx.scene.add(this.court.group, this.court.frame);
    this.fx = new CourtFx(ctx.renderer, this.court.frame, ctx.quality.shadows);
    this.me = new Athlete(SERVE_SPOT.x, SERVE_SPOT.z, Math.PI);
    this.me.speed = VISITOR_SPEED;
    this.partner = new Athlete(-2, -4.5, Math.PI);
    this.stand = new Athlete(2, -4.5, Math.PI);
    this.locals = [new Athlete(-2, 4.5, 0), new Athlete(2, 4.5, 0)];
    for (const l of this.locals) l.speed = 5.6;
    try {
      this.best = Number(JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}').best) || 0;
    } catch {
      /* storage unavailable */
    }
    this.hud = this.buildHud();
    const canvas = ctx.renderer.domElement;
    canvas.addEventListener('pointermove', (e) => {
      if (!this.active || e.pointerType !== 'mouse') return;
      this.pointerAim = true;
      this.aimAtPointer(e);
    });
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active || (e.pointerType === 'mouse' && e.button !== 0)) return;
      const onCourt = this.aimAtPointer(e);
      // a tap on the court while aiming only moves the target; anywhere else (and every click) plays
      if (e.pointerType !== 'mouse' && this.phase === 'aim' && onCourt) return;
      this.action();
    });
  }

  /**
   * Gives the players and fans their bodies (the game plays without them). The island's people are
   * a set of their own, loaded on the first trip rather than at the start: until people.isSetLoaded
   * ('island') the court waits (checked every frame, asleep or not), and the visitor's arrival asks
   * for the set if nobody has yet (setAwake). `visitor` is the visitor's look, or a function giving
   * it as it is now: a changed look is worn from the next round on (see start).
   */
  setPeople(factory: PeopleFactory, visitor: Look | (() => Look)) {
    this.people = { factory, visitor: typeof visitor === 'function' ? visitor : () => visitor };
    this.dressed = 0;
    if (factory.isSetLoaded('island')) {
      this.dressPlayers();
      this.dressFans();
    } else if (this.awake) this.askForPeople();
  }

  private people: { factory: PeopleFactory; visitor: () => Look } | null = null;
  /**
   * How far the dressing has got: 0 nobody, 1 the players, 2 the fans and the umpire too. When the
   * set arrives mid-game (the visitor in the air) it takes two frames, the players then the fans,
   * so neither costs the frame more than about 15 ms.
   */
  private dressed = 0;
  /** The avatars on the court (and the visitor's), so no fan is a player's double. */
  private onCourt: ReadonlySet<string> = new Set();
  /** The visitor's look their body was built from (lookKey). */
  private visitorKey = '';

  /** The island's people are wanted now: load their set (once; the factory shares a load already under way). */
  private askForPeople() {
    const people = this.people;
    if (!people || this.dressed === 2) return;
    people.factory.loadSet('island').catch((e: unknown) => console.warn('volley: the island people failed to load', e));
  }

  private get shadows() {
    const q = this.ctx.quality;
    return q.shadows && q.tier !== 'low' && q.tier !== 'lowest';
  }

  /** The five on the court, once the island's people are in. */
  private dressPlayers() {
    const factory = this.people!.factory;
    this.dressed = 1;
    const shadows = this.shadows;
    const f = this.court.frame;
    const visitor = this.people!.visitor();
    this.visitorKey = lookKey(visitor);
    this.me.attach(factory.create(visitorBeachLook(visitor)), f, shadows);
    this.me.rig!.root.visible = this.awake && this.active;
    const cast = playerLooks(factory, visitor.avatar);
    this.partner.attach(factory.create(cast.partner), f, shadows);
    this.stand.attach(factory.create(cast.stand), f, shadows);
    this.locals.forEach((l, i) => l.attach(factory.create(cast.locals[i]), f, shadows));
    for (const a of this.everyone) a.rig!.setGlow(this.night);
    this.onCourt = cast.used;
  }

  /** The fans on the bleachers' lowest rows (fewer on modest hardware), and the umpire on the stand. */
  private dressFans() {
    const factory = this.people!.factory;
    this.dressed = 2;
    const q = this.ctx.quality;
    const count = { high: 5, medium: 3, low: 1, lowest: 0 }[q.tier];
    const seats: { x: number; y: number; z: number; yaw: number }[] = [];
    const spots = [
      [0, -4.6],
      [1, -2.4],
      [0, 1.6],
      [1, 3.9],
      [2, -0.4 - BLEACHER.half + 3],
    ];
    for (let i = 0; i < count; i++) {
      const [row, z] = spots[i];
      seats.push({ x: BLEACHER.x0 + row * BLEACHER.step + 0.38, y: 0.42 + row * BLEACHER.rise + 0.03, z, yaw: Math.PI / 2 });
    }
    this.fans?.dispose();
    this.fans = new Fans(factory, this.court.frame, seats, q.tier === 'lowest' ? null : { x: UMPIRE.x, y: UMPIRE.y, z: UMPIRE.z, yaw: Math.PI / 2 }, this.shadows, this.onCourt);
    this.fans.setGlow(this.night);
    this.fans.setVisible(this.awake);
  }

  /** The visitor in their look as it is now (they may have been to the changing room since): the same model re-dyed, or a new one. */
  private redressVisitor() {
    const people = this.people;
    const rig = this.me.rig;
    if (!people || !rig) return;
    const visitor = people.visitor();
    const key = lookKey(visitor);
    if (key === this.visitorKey) return;
    this.visitorKey = key;
    const look = visitorBeachLook(visitor);
    if (!rig.applyLook(look)) this.me.attach(people.factory.create(look), this.court.frame, this.shadows);
    this.me.rig!.setGlow(this.night);
  }

  /** Whether the visitor is on the island: away, nothing moves and the players aren't drawn. */
  setAwake(on: boolean) {
    this.awake = on;
    if (on) this.askForPeople();
    for (const a of this.everyone) if (a.rig) a.rig.root.visible = on && (a !== this.me || this.active);
    this.fans?.setVisible(on);
    if (!on) this.fx.showBall(null, 0);
  }

  setNight(k: number) {
    this.night = k;
    this.court.setNight(k);
    this.fans?.setGlow(k);
    for (const a of this.everyone) a.rig?.setGlow(k);
  }

  private get everyone() {
    return [this.me, this.partner, this.stand, ...this.locals];
  }

  /** The visitor, their partner, the regular and the two locals (read-only use: the preview). */
  get athletes(): readonly Athlete[] {
    return this.everyone;
  }

  /** The two players on side `s` (the visitor's side is −1). */
  private team(s: Side): [Athlete, Athlete] {
    return s > 0 ? this.locals : [this.partner, this.active ? this.me : this.stand];
  }

  /** The last serve is played (the last look at the court): leaving now is no early exit. */
  get finished(): boolean {
    return this.active && this.phase === 'over';
  }

  /** Where the visitor stands to play (the serve spot behind the near baseline), facing the far court (east). */
  get standSpot() {
    const w = toWorld(SERVE_SPOT.x, 0, SERVE_SPOT.z);
    return { x: w.x, z: w.z, heading: -Math.PI / 2 };
  }

  /** The timing moment the visitor is in, if any, and how long until its perfect instant (negative: past it). */
  get cue(): { kind: Timing['kind']; toPerfect: number } | null {
    return this.timing ? { kind: this.timing.kind, toPerfect: this.timing.perfect - this.b.t } : null;
  }

  /** Aims at a spot on the far court (court frame) or at a coconut (its index), as the pointer would. */
  aimAt(to: { x: number; z: number } | number) {
    this.pointerAim = true;
    if (typeof to === 'number') {
      this.coconut = this.court.targets[to] ? to : -1;
      return;
    }
    this.coconut = -1;
    this.target.set(THREE.MathUtils.clamp(to.x, -HALF_W - 0.8, HALF_W + 0.8), SAND_Y, THREE.MathUtils.clamp(to.z, AIM_NEAR, HALF_L + 0.9));
  }

  /** The court's middle on the ground (for the shadows). */
  get focus() {
    return this.focusV.copy(COURT_ORIGIN);
  }

  // ---------------------------------------------------------------------------------------------
  // The round

  start() {
    this.active = true;
    this.final = null;
    this.stats = { score: 0, aces: 0, coconuts: 0, streak: 0, bestStreak: 0, attacks: 0, onTarget: 0, served: 0, lost: 0 };
    this.court.resetCoconuts();
    this.camInit = false;
    this.cam = 'player';
    // the regular steps off to the bench and the visitor takes their place
    this.stand.warp(-8.9, -9.2, -Math.PI / 2);
    this.stand.arms('loose');
    this.redressVisitor();
    if (this.me.rig) this.me.rig.root.visible = true;
    this.hud.hidden = false;
    $('vb-cam').textContent = CAM_LABEL[this.cam];
    $('vb-keys').innerHTML = this.ctx.mobile
      ? ''
      : 'Aim <kbd>mouse</kbd>/<kbd>WASD</kbd> · play <kbd>E</kbd>/<kbd>Space</kbd>/click · <kbd>C</kbd> camera';
    const shown = this.ctx.ui.setIntro('volley-intro', 'Beach Volley', this.introHtml(), { accent: PALETTE.orange });
    this.introTimer = shown ? 9 : 0;
    this.ctx.sfx.chime();
    this.newServe();
  }

  private introHtml() {
    const keys = this.ctx.mobile
      ? 'Tap the far court to aim, then the action button: once to toss, again to strike.'
      : 'Aim with the <strong>mouse</strong> (or <kbd>WASD</kbd>), then <kbd>E</kbd> / <kbd>Space</kbd> / click once to toss and again to strike.';
    return `<p class="eyebrow">Beach Volley · ${SERVES} serves</p><h2>Serve, spike, smash a coconut! 🏐</h2><p>${keys} Strike when the marker crosses the red: perfect timing is a hard topspin, early hits the net, late goes long.</p><p>If the locals dig it back, time your dig as it reaches you, and your partner sets you up to <strong>spike</strong>.</p><ul class="tags"><li>Rings · 1–3 pts</li><li>Ace · +1</li><li>🥥 Coconut · 5 pts</li></ul>`;
  }

  /** The next serve: rings out, everyone to their places, the ball in the visitor's hand. */
  private newServe() {
    this.phase = 'aim';
    this.phaseT = 0;
    this.flying = false;
    this.contact = null;
    this.timing = null;
    this.timers = [];
    this.dead = null;
    this.exchanges = 0;
    this.coconutsThisRally = 0;
    this.serveInPlay = false;
    this.touchedByLocals = false;
    this.shanked = false;
    this.blocked = false;
    this.lastTouch = -1;
    this.rings = placeRings(this.rnd);
    this.fx.setRings(this.rings);
    if (this.court.coconutsUp === 0) this.court.resetCoconuts();
    if (this.coconut >= 0 && !this.court.targets[this.coconut]) this.leaveCoconut();
    this.me.warp(SERVE_SPOT.x, SERVE_SPOT.z, Math.PI);
    this.me.arms('loose');
    this.partner.warp(-2.1, -1.4, Math.PI);
    this.partner.arms('ready');
    this.locals[0].warp(-2.2, 5.4, 0);
    this.locals[1].warp(2.2, 5.1, 0);
    for (const l of this.locals) {
      l.arms('ready');
      l.faceTo(SERVE_SPOT.x, SERVE_SPOT.z);
    }
    this.holdBall();
    this.ctx.sfx.whistle();
    this.setHint(this.ctx.mobile ? 'Tap the far court to aim · action button to toss' : 'Aim at a ring or a coconut · <kbd>E</kbd> to toss');
    this.showMeter(null);
    this.boardUpdate();
  }

  /** The ball resting in the server's hand. */
  private holdBall() {
    this.b.x = this.me.pos.x - 0.28;
    this.b.y = 1.12;
    this.b.z = this.me.pos.z + 0.42;
    this.b.vx = this.b.vy = this.b.vz = 0;
    this.b.t = 0;
  }

  /** E / Space / a click / a tap: toss, strike, dig or spike, whichever the moment calls for. */
  action() {
    if (!this.active) return;
    if (this.phase === 'aim') return this.toss();
    if (this.timing) return this.press();
    if (this.phase === 'point' && this.phaseT > 0.8 && this.stats.served < SERVES) return this.newServe();
  }

  private toss() {
    this.phase = 'toss';
    // up and a little forward, so the server steps in and jumps under it
    this.b = ball(this.me.pos.x - 0.28, 1.45, this.me.pos.z + 0.4, 0, 6.3, 0.75, 'soft');
    this.flying = true;
    this.opts = { noNet: true };
    const perfect = this.timeThrough(STRIKE_Y);
    const late = this.timeThrough(1.35);
    this.timing = { kind: 'serve', t0: 0, perfect, t1: late, scale: 1 };
    this.me.goTo(this.b.x + 0.26, this.b.z + this.b.vz * perfect - 0.32);
    this.me.arms('cock');
    this.me.jump(perfect - this.me.jumpPeak, 0.6);
    this.ctx.sfx.swish();
    this.setHint('Strike as the marker crosses the red!');
  }

  /** When (on the ball's clock) the current flight comes down through height y. */
  private timeThrough(y: number) {
    copyBall(this.b, this.probe);
    for (let i = 0; i < 2400; i++) {
      const py = this.probe.y;
      stepBall(this.probe);
      if (this.probe.vy < 0 && py >= y && this.probe.y < y) return this.probe.t;
    }
    return this.probe.t;
  }

  /** The visitor pressed during a timing window. */
  private press() {
    const tm = this.timing!;
    const err = this.b.t - tm.perfect;
    const g = grade(err, tm.scale);
    this.timing = null;
    this.showGrade(g, err);
    this.showMeter(null, err);
    if (tm.kind === 'serve') return this.strikeServe(g, err);
    if (tm.kind === 'dig') return this.visitorDig(g, err);
    return this.spike(g, err);
  }

  private strikeServe(g: Grade, err: number) {
    this.phase = 'play';
    this.stats.served++;
    this.serveInPlay = true;
    this.me.arms('swing');
    const ball = this.aimedShot(g, err, 'serve');
    this.ctx.sfx.ballHit(Math.min(1, speedOf(ball) / 24));
    this.launch(ball, -1, true, true);
    this.setHint('');
  }

  /** The visitor's serve or spike from where the ball is now, at the target, as the timing allows. */
  private aimedShot(g: Grade, err: number, kind: 'serve' | 'spike') {
    const from = this.b;
    const s = shot(g, err, this.target.x, this.target.z, kind, this.rnd);
    const phase = this.rnd() * 6;
    this.stats.attacks++;
    if (this.coconut >= 0 && g !== 'miss') {
      const c = COCONUTS[this.coconut];
      const wobble = g === 'perfect' ? 0.05 : g === 'good' ? 0.18 : 0.4;
      return attackThrough(from.x, from.y, from.z, c.x + (this.rnd() - 0.5) * wobble, c.y + (this.rnd() - 0.5) * wobble, SHY_Z, 'top', ELEVS.coconut, 0.12, phase);
    }
    if (s.ty !== null) return attackThrough(from.x, from.y, from.z, s.x, s.ty, s.z, s.spin, s.elevs, -9, phase);
    return attack(from.x, from.y, from.z, s.x, s.z, s.spin, s.elevs, s.margin, phase);
  }

  // ---------------------------------------------------------------------------------------------
  // The rally

  /**
   * A ball struck over the net by side `by` (−1 the visitor's): it flies, and the other side
   * reads it. The locals judge from the prediction whether they can dig it; for the visitor's side
   * the timing meter comes up (or, in the warm-up, the partner and the regular play it).
   * `aimed`: the visitor's own serve or spike, which counts towards their accuracy.
   */
  private launch(b: Ball, by: Side, serve: boolean, aimed = false) {
    this.b = b;
    this.flying = true;
    this.contact = null;
    this.timing = null;
    this.dead = null;
    this.lastTouch = by;
    this.shanked = false;
    this.fx.spinFor(b);
    this.opts = by < 0 && this.active ? { targets: this.court.targets } : {};
    const pr = predict(b, this.opts);
    const at = pr.at;
    const lands = pr.hit?.kind === 'land';
    const inside = lands && inCourt(at.x, at.z, -by);
    if (aimed && (inside || pr.hit?.kind === 'target')) this.stats.onTarget++;
    if (!serve) this.exchanges++;
    if (!inside) {
      // into the net, wide or out: everyone watches it go
      for (const a of this.team(-by as Side)) a.faceTo(at.x, at.z);
      return;
    }
    if (-by < 0 && this.active) this.visitorReceive();
    else this.defend(-by as Side, serve);
  }

  /** Side `s` reads the ball coming over and sends its nearest player to it, to dig it or to try. */
  private defend(s: Side, serve: boolean) {
    const pr = predict(this.b, { ...this.opts, catchY: DIG_Y });
    if (pr.hit?.kind !== 'height') return;
    const cx = pr.at.x;
    const cz = pr.at.z;
    const t = pr.at.t - this.b.t;
    const pace = speedOf(pr.at);
    const ambient = !this.active;
    let best: Athlete | null = null;
    let plan = reach(99, t, 1, 1);
    for (const a of this.team(s)) {
      const r = reach(Math.hypot(cx - a.pos.x, cz - a.pos.z), t, a.speed, ambient ? 0.1 : 0.26 + this.rnd() * 0.12);
      if (!best || r.spare > plan.spare) {
        best = a;
        plan = r;
      }
    }
    const digger = best!;
    const other = this.team(s)[0] === digger ? this.team(s)[1] : this.team(s)[0];
    // stand a step behind where it comes down, facing where it came from
    const dx = this.b.x - cx;
    const dz = this.b.z - cz;
    const dl = Math.hypot(dx, dz) || 1;
    const sx = cx + (dx / dl) * 0.42;
    const sz = cz + (dz / dl) * 0.42;
    digger.faceTo(this.b.x, this.b.z);
    other.goTo(s * 0.4 + other.pos.x * 0.3, s * 1.9);
    if (plan.how === 'none') {
      // too far: a lunge that won't get there
      digger.goTo(sx, sz);
      this.contact = { t: pr.at.t - 0.25, run: () => digger.dive(cx - digger.pos.x, cz - digger.pos.z) };
      return;
    }
    digger.goTo(sx, sz);
    digger.arms('ready');
    const p = ambient ? 0.9 : digChance(pace, plan.how, serve ? LOCAL_SKILL - 0.04 : LOCAL_SKILL, this.exchanges);
    const ok = this.rnd() < p;
    if (plan.how === 'dive') this.later(t - 0.4, () => digger.dive(cx - digger.pos.x, cz - digger.pos.z));
    this.later(t - 0.3, () => digger.arms('dig'));
    this.contact = {
      t: pr.at.t,
      run: () => (ok ? this.aiDig(s, digger, other) : this.shank(s, digger)),
    };
  }

  /**
   * A small cue (an arm raised, a jump) `dt` seconds of play from now, beside the next contact.
   * It runs on the rally's own clock, not the ball's, since a touch starts the ball's clock afresh.
   */
  private later(dt: number, fn: () => void) {
    this.timers.push({ t: this.clock + Math.max(0, dt), fn });
  }
  private timers: { t: number; fn: () => void }[] = [];
  private clock = 0;

  /** A clean dig: up to the partner at the net. */
  private aiDig(s: Side, digger: Athlete, setter: Athlete) {
    if (s > 0) this.touchedByLocals = true;
    this.lastTouch = s;
    const from = this.v1.set(this.b.x, this.b.y, this.b.z);
    const to = this.v2.set(THREE.MathUtils.clamp(from.x * 0.3, -1.5, 1.5), SET_Y, s * 1.7);
    const { b, t } = lob(from, to, 4.2 + this.rnd() * 0.8);
    this.ctx.sfx.ballHit(0.25);
    this.fx.sand(digger.pos.x, digger.pos.z, 0.5);
    this.flyLob(b, true);
    setter.goTo(to.x, to.z + s * 0.25);
    setter.faceTo(0, 0);
    this.later(t - 0.5, () => setter.arms('set'));
    digger.arms('loose');
    this.contact = { t, run: () => this.aiSet(s, setter, digger) };
  }

  /** A dig that goes wrong: off the arms and away. */
  private shank(s: Side, digger: Athlete) {
    this.lastTouch = s;
    this.shanked = true;
    if (s > 0) this.touchedByLocals = true;
    const side = this.rnd() < 0.5 ? -1 : 1;
    const b = ball(this.b.x, this.b.y, this.b.z, side * (2.5 + this.rnd() * 2.5), 2.5 + this.rnd() * 2, s * (1.5 + this.rnd() * 2.5), 'soft');
    this.ctx.sfx.ballHit(0.3);
    this.flyLob(b, true);
    digger.arms('loose');
  }

  /** The set: high to the attacker coming in from the back. */
  private aiSet(s: Side, setter: Athlete, attacker: Athlete) {
    this.lastTouch = s;
    const from = this.v1.set(this.b.x, this.b.y, this.b.z);
    const ax = (setter.pos.x > 0 ? -1 : 1) * (1.6 + this.rnd() * 1.2);
    const to = this.v2.set(ax, 3.0, s * 1.15);
    const { b, t } = lob(from, to, 5.2 + this.rnd() * 0.6);
    this.ctx.sfx.ballHit(0.15);
    this.flyLob(b, true);
    setter.arms('loose');
    // the attacker comes in from behind: the run-up, the jump, the arm drawn back
    attacker.goTo(ax + (s > 0 ? -0.25 : 0.25), s * 1.55);
    attacker.faceTo(0, -s * 6);
    attacker.jump(Math.max(0, t - attacker.jumpPeak), 0.55);
    this.later(t - 0.55, () => attacker.arms('cock'));
    // the other side's net player goes up to block
    const [blocker] = this.team(-s as Side).slice().sort((a, b2) => Math.abs(a.pos.z) - Math.abs(b2.pos.z));
    if (!(this.active && -s < 0 && blocker === this.me)) {
      blocker.goTo(ax * 0.85, -s * 0.55);
      blocker.faceTo(ax, s * 2);
      this.later(t - blocker.jumpPeak + 0.06, () => {
        blocker.jump(0, 0.5);
        blocker.arms('block');
      });
      this.later(t + 0.8, () => blocker.arms('ready'));
    }
    this.contact = { t, run: () => this.aiAttack(s, attacker) };
  }

  /** The locals' (or the warm-up's) attack over the net: a spike, a cut shot, or now and then an error. */
  private aiAttack(s: Side, attacker: Athlete) {
    attacker.arms('swing');
    this.later(0.5, () => attacker.arms('ready'));
    const from = this.b;
    let b: Ball;
    if (!this.active) {
      // the warm-up: soft attacks to wherever the other two can play them
      const tx = (this.rnd() - 0.5) * 5;
      const tz = -s * (2.5 + this.rnd() * 4);
      b = attack(from.x, from.y, from.z, tx, tz, 'soft', [0.2, 0.35, 0.5, 0.65], 0.3);
      this.ctx.sfx.ballHit(0.3);
    } else {
      const error = this.rnd() < 0.07 + this.exchanges * 0.02;
      const hard = this.rnd() < 0.62 - this.exchanges * 0.08;
      let tx = (this.rnd() - 0.5) * 6.4;
      let tz = -(1.5 + this.rnd() * 5.8);
      if (error) {
        if (this.rnd() < 0.5) tz = -(HALF_L + 0.8 + this.rnd() * 1.5);
        else tx = (this.rnd() < 0.5 ? -1 : 1) * (HALF_W + 0.6 + this.rnd());
      }
      b = attack(from.x, from.y, from.z, tx, tz, hard ? 'top' : 'soft', hard ? [-0.45, -0.35, -0.25, -0.15, -0.05, 0.05] : [0.35, 0.5, 0.65], error && this.rnd() < 0.3 ? -9 : 0.2);
      this.ctx.sfx.ballHit(hard ? 0.85 : 0.35);
    }
    this.launch(b, s, false);
  }

  /** The ball is coming at the visitor: run them to it and bring up the dig meter. */
  private visitorReceive() {
    const pr = predict(this.b, { catchY: DIG_Y });
    if (pr.hit?.kind !== 'height') return;
    const land = predict(this.b, {});
    const cx = pr.at.x;
    const cz = pr.at.z;
    const t = pr.at.t - this.b.t;
    const r = reach(Math.hypot(cx - this.me.pos.x, cz - this.me.pos.z), t, this.me.speed, 0.05, 0.6);
    const dx = this.b.x - cx;
    const dz = this.b.z - cz;
    const dl = Math.hypot(dx, dz) || 1;
    this.me.goTo(cx + (dx / dl) * 0.42, cz + (dz / dl) * 0.42);
    this.me.faceTo(this.b.x, this.b.z);
    this.me.arms('ready');
    if (r.how === 'dive') this.later(t - 0.4, () => this.me.dive(cx - this.me.pos.x, cz - this.me.pos.z));
    this.partner.goTo(-0.8, -1.8);
    this.partner.faceTo(0, -6);
    this.timing = { kind: 'dig', t0: this.b.t, perfect: pr.at.t, t1: (land.hit ? land.at.t : pr.at.t + 0.3) + 0.02, scale: r.how === 'set' ? 1 : r.how === 'dive' ? 0.65 : 0.4 };
    this.setHint(r.how === 'set' ? 'Dig it! Play as the ball reaches you' : 'Dive for it!');
  }

  /** The visitor's dig, as well as it was timed. */
  private visitorDig(g: Grade, err: number) {
    this.me.arms('dig');
    this.later(0.5, () => this.me.arms('ready'));
    if (g === 'miss') {
      // a swing at nothing (or at a ball already past): it goes on to the sand
      this.setHint(err < 0 ? 'Too early!' : 'Too late!');
      return;
    }
    this.lastTouch = -1;
    this.ctx.sfx.ballHit(0.3);
    this.fx.sand(this.me.pos.x, this.me.pos.z, 0.6);
    const from = this.v1.set(this.b.x, this.b.y, this.b.z);
    if (g === 'ok') {
      // a scrappy dig: the partner chases it and can only bump a free ball over
      const to = this.v2.set(THREE.MathUtils.clamp(from.x + (this.rnd() - 0.5) * 4, -3.5, 3.5), DIG_Y + 0.1, -2.8 - this.rnd() * 2);
      const { b, t } = lob(from, to, 3.4 + this.rnd());
      this.flyLob(b, true);
      this.partner.goTo(to.x, to.z - 0.4);
      this.partner.faceTo(0, 6);
      this.later(t - 0.3, () => this.partner.arms('dig'));
      this.contact = { t, run: () => this.freeBall(this.partner) };
      this.setHint('Scrappy dig: your partner bumps it over');
      return;
    }
    const to = this.v2.set(-0.7, SET_Y, -1.7);
    const { b, t } = lob(from, to, g === 'perfect' ? 4 : 4.6);
    this.flyLob(b, true);
    this.partner.goTo(to.x, to.z - 0.25);
    this.partner.faceTo(0, 0);
    this.later(t - 0.5, () => this.partner.arms('set'));
    this.contact = { t, run: () => this.partnerSet(g) };
    this.setHint('Nice dig! Get ready to spike');
  }

  /** The partner bumps a free ball over the net (an easy one for the locals). */
  private freeBall(from: Athlete) {
    from.arms('ready');
    this.ctx.sfx.ballHit(0.2);
    const to = this.v2.set((this.rnd() - 0.5) * 5, DIG_Y, 3 + this.rnd() * 3.5);
    const { b } = lob(this.v1.set(this.b.x, this.b.y, this.b.z), to, 4.8);
    this.launch(b, -1, false);
  }

  /** The partner sets the visitor up: up comes the spike meter, and the target. */
  private partnerSet(dig: Grade) {
    this.partner.arms('loose');
    this.ctx.sfx.ballHit(0.15);
    const from = this.v1.set(this.b.x, this.b.y, this.b.z);
    const ax = 1.7;
    const to = this.v2.set(ax, STRIKE_Y, -1.05);
    const { b } = lob(from, to, dig === 'perfect' ? 5.1 : 5.5);
    this.flyLob(b, true);
    const perfect = this.timeThrough(STRIKE_Y);
    const late = this.timeThrough(1.8);
    this.me.goTo(ax + 0.26, -1.05 - 0.36);
    this.me.faceTo(ax, 6);
    this.me.jump(Math.max(0, perfect - this.me.jumpPeak), 0.62);
    this.later(perfect - 0.55, () => this.me.arms('cock'));
    this.timing = { kind: 'spike', t0: this.b.t, perfect, t1: late, scale: 1 };
    this.setHint('SPIKE! Aim, and strike at the top of your jump');
    // a local goes up to block, the other drops back to dig
    const [blocker, back] = Math.abs(this.locals[0].pos.x - ax) < Math.abs(this.locals[1].pos.x - ax) ? this.locals : [this.locals[1], this.locals[0]];
    blocker.goTo(ax * 0.9, 0.55);
    blocker.faceTo(ax, -3);
    this.later(perfect - blocker.jumpPeak + 0.05, () => {
      blocker.jump(0, 0.52);
      blocker.arms('block');
    });
    this.later(perfect + 0.9, () => blocker.arms('ready'));
    back.goTo(-ax * 0.6, 5.5);
    back.faceTo(ax, -1);
    back.arms('ready');
  }

  /** The visitor's spike (or roll shot), and the block that may stop it. */
  private spike(g: Grade, err: number) {
    this.me.arms('swing');
    this.later(0.5, () => this.me.arms('ready'));
    if (g === 'miss' && err < 0 && this.b.y < 2.2) {
      // swung far too early: the ball drops past
      this.setHint('Too early!');
      return;
    }
    const b = this.aimedShot(g, err, 'spike');
    const stuff = g === 'good' ? 0.14 : g === 'ok' ? 0.04 : 0;
    this.ctx.sfx.ballHit(g === 'ok' ? 0.4 : 0.95);
    this.fx.sand(this.me.pos.x, this.me.pos.z, 0.5);
    if (this.rnd() < stuff) {
      // stuffed: the block sends it straight back down on the visitor's side
      this.blocked = true;
      this.lastTouch = 1;
      const back = ball(this.b.x, this.b.y + 0.1, 0.25, (this.rnd() - 0.5) * 2, -1.5, -4 - this.rnd() * 2, 'soft');
      this.flying = true;
      this.b = back;
      this.opts = { noNet: true };
      this.contact = null;
      this.dead = { won: false, how: 'blocked' };
      this.court.shakeNet(this.b.x, 2.6, 0.3);
      this.setHint('');
      return;
    }
    this.launch(b, -1, false, true);
    this.setHint('');
  }

  /** A soft ball in play (a dig, a set) that doesn't cross the net: it flies with the net out of the way. */
  private flyLob(b: Ball, noNet: boolean) {
    this.b = b;
    this.flying = true;
    this.opts = { noNet };
    this.fx.spinFor(b);
  }

  /** Something happened to the ball in flight. */
  private onHit(h: Hit) {
    const b = this.b;
    if (h.kind === 'net') {
      this.court.shakeNet(b.x, b.y, 1);
      this.ctx.sfx.thunk(3);
      b.vz *= -0.15;
      b.vx *= 0.3;
      b.vy = Math.min(b.vy, 0) * 0.2;
      this.opts = { noNet: true };
      this.dead ??= this.lastTouch < 0 ? { won: false, how: 'net' } : { won: true, how: 'error', ring: 0, coconuts: 0 };
      this.contact = null;
      this.timing = null;
      return;
    }
    if (h.kind === 'wide') {
      this.opts = { ...this.opts, noNet: true };
      this.dead ??= this.lastTouch < 0 ? { won: false, how: 'out' } : { won: true, how: 'error', ring: 0, coconuts: 0 };
      this.contact = null;
      return;
    }
    if (h.kind === 'target') {
      const i = h.index;
      this.court.knock(i, b.vx, b.vy, b.vz);
      this.ctx.sfx.coconutThunk();
      this.coconutsThisRally++;
      b.vz *= -0.3;
      b.vx *= 0.5;
      b.vy = Math.abs(b.vy) * 0.3 + 0.5;
      this.dead = { won: true, how: 'coconut', ring: 0, coconuts: this.coconutsThisRally };
      this.contact = null;
      if (this.coconut === i) this.leaveCoconut();
      this.toast('🥥 COCONUT!', `+${this.coconutsThisRally * 5} bonus`, true);
      return;
    }
    if (h.kind === 'land') {
      const pace = speedOf(b);
      this.ctx.sfx.thunk(Math.min(6, 1 + pace * 0.25));
      this.fx.sand(b.x, b.z, Math.min(1.5, 0.3 + pace * 0.05), { x: b.vx / (pace || 1), z: b.vz / (pace || 1) });
      this.flying = false;
      this.contact = null;
      this.timing = null;
      if (!this.active) return this.ambientDrop();
      this.endRally(this.dead ?? this.judge(b.x, b.z));
    }
  }

  /** Where the ball came down decides the rally (when nothing decided it in the air). */
  private judge(x: number, z: number): Outcome {
    const far = z > 0;
    const ringV = ringAt(this.rings, x, z);
    const inside = inCourt(x, z, far ? 1 : -1);
    if (far) {
      if (this.lastTouch < 0) {
        if (!inside) return { won: false, how: 'out' };
        return { won: true, how: this.serveInPlay && !this.touchedByLocals ? 'ace' : 'kill', ring: ringV, coconuts: 0 };
      }
      return { won: true, how: this.shanked ? 'shank' : 'error', ring: 0, coconuts: 0 };
    }
    if (this.blocked) return { won: false, how: 'blocked' };
    if (this.lastTouch > 0) return inside ? { won: false, how: 'missed' } : { won: true, how: 'error', ring: 0, coconuts: 0 };
    return inside ? { won: false, how: 'missed' } : { won: false, how: 'out' };
  }

  /** The rally is over: points, the streak, the scoreboard, a cheer (or a groan), then the next serve. */
  private endRally(o: Outcome) {
    const s = this.stats;
    const pts = points(o, this.exchanges);
    if (o.won) {
      s.score += pts;
      s.streak++;
      s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (o.how === 'ace') s.aces++;
      s.coconuts += o.coconuts;
      if (o.ring) this.fx.flashRing(this.rings.findIndex((r) => r.value === o.ring));
      this.ctx.sfx.cheer(Math.min(1, 0.3 + pts * 0.15));
      this.fans?.cheer(Math.min(1, pts / 4));
      this.me.celebrate();
      this.partner.celebrate();
    } else {
      s.streak = 0;
      s.lost++;
      this.ctx.sfx.murmur(0.35);
    }
    const ring = o.won && 'ring' in o && o.ring ? ` · in the ${o.ring} ring` : '';
    const title: Record<Outcome['how'], string> = {
      ace: 'ACE! 🏐',
      kill: 'KILL! 💥',
      error: 'Their error',
      shank: 'Shanked it!',
      coconut: '🥥 COCONUT!',
      net: 'Into the net',
      out: 'Out!',
      fault: 'Dropped the toss',
      dug: 'Dug',
      missed: 'They scored',
      blocked: 'Stuffed by the block!',
    };
    const sub = o.won ? `+${pts}${ring}${s.streak > 1 ? ` · streak ${s.streak}` : ''}` : s.served >= SERVES ? 'That was the last serve' : 'Next serve coming up';
    this.toast(title[o.how], sub, o.won);
    this.phase = 'point';
    this.phaseT = 0;
    this.timing = null;
    this.showMeter(null);
    this.setHint('');
    this.boardUpdate();
    // the ball bounces on and rolls to a stop
    this.b.vy = Math.abs(this.b.vy) * 0.35;
    this.b.vx *= 0.5;
    this.b.vz *= 0.5;
    if (s.served >= SERVES) {
      this.phase = 'over';
      this.final = this.measure();
      if (s.score > this.best) {
        this.best = s.score;
        try {
          localStorage.setItem(STORE_KEY, JSON.stringify({ best: this.best }));
        } catch {
          /* storage unavailable */
        }
      }
    }
  }

  private boardUpdate() {
    const s = this.stats;
    this.court.setScoreboard({
      title: 'BEACH VOLLEY',
      home: s.score,
      away: s.lost,
      line: this.active ? `Serve ${Math.min(SERVES, s.served + (this.serveInPlay ? 0 : 1))} of ${SERVES}${this.best ? ` · best ${this.best}` : ''}` : 'Palm Cay Open · warm-up',
    });
  }

  // ---------------------------------------------------------------------------------------------
  // The warm-up between rounds

  /** A dropped ball in the warm-up: a moment, then whoever's nearest serves a soft one over. */
  private ambientDrop() {
    this.ambientT = 1.2 + this.rnd();
  }

  private ambientServe() {
    const s: Side = this.rnd() < 0.5 ? 1 : -1;
    const [a] = this.team(s);
    const from = a.contactPoint('set', this.v1);
    const to = this.v2.set((this.rnd() - 0.5) * 4, DIG_Y, -s * (3 + this.rnd() * 3));
    const { b } = lob(from, to, 4.6);
    a.arms('set');
    this.later(0.4, () => a.arms('ready'));
    this.launch(b, s, false);
  }

  // ---------------------------------------------------------------------------------------------
  // Aiming

  /** Aims at the court (or a coconut) under the pointer; true when it was over the far court or the shy. */
  private aimAtPointer(e: PointerEvent) {
    if (!(this.phase === 'aim' || this.timing?.kind === 'spike' || this.phase === 'toss')) return false;
    const r = this.ctx.renderer.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.ctx.camera);
    // a coconut close to the ray takes the aim
    let nearest = -1;
    let nd = 0.5;
    COCONUTS.forEach((c, i) => {
      if (!this.court.targets[i]) return;
      const d = this.ray.ray.distanceToPoint(toWorld(c.x, c.y, SHY_Z, this.v3));
      if (d < nd) {
        nd = d;
        nearest = i;
      }
    });
    if (nearest >= 0) {
      this.coconut = nearest;
      return true;
    }
    // else the sand of the far court, in the court's frame
    const o = toLocal(this.ray.ray.origin, this.v1);
    const p = toLocal(this.v3.copy(this.ray.ray.origin).add(this.ray.ray.direction), this.v2).sub(o);
    if (p.y >= -1e-4) return false;
    const k = (SAND_Y - o.y) / p.y;
    const x = o.x + p.x * k;
    const z = o.z + p.z * k;
    if (z < 0.3 || z > 12 || Math.abs(x) > HALF_W + 2) return false;
    if (z > HALF_L + 1.6) {
      this.coconut = this.nearestCoconut(x);
      return this.coconut >= 0;
    }
    this.coconut = -1;
    this.target.set(THREE.MathUtils.clamp(x, -HALF_W - 0.8, HALF_W + 0.8), SAND_Y, THREE.MathUtils.clamp(z, AIM_NEAR, HALF_L + 0.9));
    return true;
  }

  private nearestCoconut(x: number) {
    let best = -1;
    let d = Infinity;
    COCONUTS.forEach((c, i) => {
      if (this.court.targets[i] && Math.abs(c.x - x) < d) {
        d = Math.abs(c.x - x);
        best = i;
      }
    });
    return best;
  }

  private leaveCoconut() {
    const c = COCONUTS[Math.max(0, this.coconut)];
    this.coconut = -1;
    this.target.set(c.x, SAND_Y, HALF_L - 0.6);
  }

  /** The keys or the joystick move the target (steer is positive to the left: the court's +x). */
  private steerAim(dt: number) {
    const inp = this.input;
    if (!inp) return;
    const sx = inp.steer;
    const sz = inp.throttle;
    if (Math.abs(sx) < 0.05 && Math.abs(sz) < 0.05) return;
    this.pointerAim = false;
    if (this.coconut >= 0) {
      this.aimStepT -= dt;
      if (sz < -0.5) return this.leaveCoconut();
      if (Math.abs(sx) > 0.5 && this.aimStepT <= 0) {
        this.aimStepT = 0.22;
        const dir = sx > 0 ? -1 : 1;
        for (let i = this.coconut + dir; i >= 0 && i < COCONUTS.length; i += dir)
          if (this.court.targets[i]) {
            this.coconut = i;
            break;
          }
      }
      return;
    }
    this.target.x = THREE.MathUtils.clamp(this.target.x + sx * 5 * dt, -HALF_W - 0.8, HALF_W + 0.8);
    this.target.z = this.target.z + sz * 5 * dt;
    if (this.target.z > HALF_L + 1.2) {
      this.coconut = this.nearestCoconut(this.target.x);
      this.target.z = HALF_L + 0.9;
      this.aimStepT = 0.3;
      if (this.coconut < 0) this.target.z = HALF_L + 0.9;
    }
    this.target.z = THREE.MathUtils.clamp(this.target.z, AIM_NEAR, HALF_L + 0.9);
  }

  /** The reticle, the arrow and the dotted preview while the visitor is aiming. */
  private updateAim(dt: number) {
    const aiming = this.phase === 'aim' || this.phase === 'toss' || this.timing?.kind === 'spike';
    if (!aiming) {
      this.fx.aim(null, null, false, null);
      return;
    }
    if (!this.pointerAim || this.ctx.mobile) this.steerAim(dt);
    const to = this.coconut >= 0 ? this.v3.set(COCONUTS[this.coconut].x, COCONUTS[this.coconut].y, SHY_Z - 0.02) : this.v3.copy(this.target);
    const from = this.v2.set(this.me.pos.x, 0, this.me.pos.z);
    // the preview: the perfect strike from where the ball will be met, refreshed a few times a second
    this.previewT -= dt;
    let preview: Ball | null = null;
    if (this.phase === 'aim') {
      if (this.previewT <= 0) {
        this.previewT = 0.12;
        const cx = this.me.pos.x - 0.28;
        const cz = this.me.pos.z + 0.4 + 0.75 * 0.95;
        this.aimPreview =
          this.coconut >= 0
            ? attackThrough(cx, STRIKE_Y, cz, to.x, to.y, SHY_Z, 'top', ELEVS.coconut, 0.12)
            : attack(cx, STRIKE_Y, cz, to.x, to.z, 'top', ELEVS.jumpServe, 0.08);
      }
      preview = this.aimPreview;
    }
    this.fx.aim(from, to, this.coconut >= 0, preview);
  }
  private aimPreview: Ball | null = null;

  // ---------------------------------------------------------------------------------------------

  exit() {
    if (!this.active) return;
    this.active = false;
    this.phase = 'idle';
    this.final ??= this.measure();
    this.hud.hidden = true;
    this.timing = null;
    this.contact = null;
    this.timers = [];
    this.flying = false;
    this.fx.setRings([]);
    this.fx.aim(null, null, false, null);
    this.ctx.ui.countdown(null);
    if (this.me.rig) this.me.rig.root.visible = false;
    this.stand.warp(2, -4.5, Math.PI);
    this.ambientT = 1.5;
    this.boardUpdate();
    this.onFinish?.();
  }

  roundStats(): Record<string, number> {
    return this.final ?? this.measure();
  }

  private measure() {
    const s = this.stats;
    return { score: s.score, aces: s.aces, coconutsHit: s.coconuts, bestStreak: s.bestStreak, accuracy: s.attacks ? Math.round((s.onTarget / s.attacks) * 100) : 0 };
  }

  cycleCamera() {
    const order: Cam[] = ['player', 'tv', 'beach'];
    this.cam = order[(order.indexOf(this.cam) + 1) % order.length];
    $('vb-cam').textContent = CAM_LABEL[this.cam];
    this.ctx.sfx.pop();
  }

  update(dt: number, t: number) {
    // (the island's people load on the first trip: the players get their bodies once they're in)
    if (this.people && this.dressed < 2 && this.people.factory.isSetLoaded('island')) {
      if (this.dressed === 0) this.dressPlayers();
      else this.dressFans();
    }
    if (!this.awake && !this.active) return;
    const camDist = this.ctx.camera.position.distanceTo(COURT_ORIGIN);
    const cam = toLocal(this.ctx.camera.position, this.camLocal);
    const near = this.active || camDist < 260;
    this.court.update(dt, t, this.ctx.camera);
    if (!near) return;
    this.fx.update(dt, t);
    if (this.introTimer > 0 && (this.introTimer -= dt) <= 0 && this.ctx.ui.panelOpenKey === 'volley-intro') this.ctx.ui.hidePanel();
    this.phaseT += dt;
    if (this.active) this.updateRound();
    else this.updateAmbient(dt);
    // the ball: stepped at a fixed rate, with the contacts and the timers on its clock
    if (this.flying) {
      this.acc += Math.min(dt, 0.1);
      while (this.acc >= STEP && this.flying) {
        this.acc -= STEP;
        this.stepBall();
      }
    } else if (this.phase === 'point' || this.phase === 'over' || (!this.active && this.ambientT > 0)) this.rollBall(dt);
    else if (this.phase === 'aim') this.holdBall();
    for (const a of this.everyone) {
      if (a.rig) a.rig.root.visible = this.awake && camDist < 170 && (a !== this.me || this.active);
      a.update(dt, cam);
    }
    this.fans?.update(dt, camDist, cam);
    const showBall = this.active || camDist < 170;
    this.fx.showBall(showBall ? this.b : null, dt);
    this.updateAim(dt);
    if (this.active) this.updateHud(dt);
  }

  private stepBall() {
    const b = this.b;
    if (this.contact && b.t + STEP >= this.contact.t) {
      const c = this.contact;
      this.contact = null;
      c.run();
      return;
    }
    this.clock += STEP;
    for (let i = this.timers.length - 1; i >= 0; i--)
      if (this.clock >= this.timers[i].t) {
        const fn = this.timers[i].fn;
        this.timers.splice(i, 1);
        fn();
      }
    if (this.timing && b.t > this.timing.t1) {
      // the moment passed without a press
      const kind = this.timing.kind;
      this.timing = null;
      this.showMeter(null);
      this.showGrade('miss', 1);
      if (kind === 'serve') {
        this.phase = 'play';
        this.stats.served++;
        this.stats.attacks++;
        this.serveInPlay = true;
        this.dead = { won: false, how: 'fault' };
      }
    }
    const hit = stepCheck(b, this.opts);
    this.walls(b);
    if (hit) this.onHit(hit);
  }

  /** The shy's back board and the catch nets stop a ball dead. */
  private walls(b: Ball) {
    const back = Math.abs(b.x) < 4.5 && b.y < 2.95 && b.z > SHY_BACK_Z - 0.1 - BALL_R;
    const net = Math.abs(b.z) > CATCH_Z - BALL_R && Math.abs(b.x) < 9.5 && b.y < 4.3;
    if (!back && !net) return;
    if (back) b.z = SHY_BACK_Z - 0.1 - BALL_R;
    else b.z = Math.sign(b.z) * (CATCH_Z - BALL_R);
    if (Math.sign(b.vz) === Math.sign(b.z)) b.vz *= -0.2;
    b.vx *= 0.5;
    b.vy *= 0.4;
    this.ctx.sfx.thunk(back ? 2.5 : 1);
  }

  /** A dead ball bouncing and rolling to a stop on the sand. */
  private rollBall(dt: number) {
    const b = this.b;
    if (b.y <= SAND_Y + BALL_R + 0.001 && Math.abs(b.vy) < 0.3 && Math.hypot(b.vx, b.vz) < 0.05) return;
    b.spin = 'soft';
    b.vy -= 9.81 * dt;
    b.vx *= 1 - dt * 1.4;
    b.vz *= 1 - dt * 1.4;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.y < SAND_Y + BALL_R) {
      b.y = SAND_Y + BALL_R;
      b.vy = b.vy < -0.8 ? -b.vy * 0.32 : 0;
    }
    this.walls(b);
  }

  private updateRound() {
    if (this.phase === 'point' && this.phaseT > BETWEEN) this.newServe();
    else if (this.phase === 'over' && this.phaseT > LAST_LOOK) {
      this.phase = 'idle';
      this.onComplete?.();
    }
    if (this.phase === 'aim') this.me.faceTo(this.coconut >= 0 ? COCONUTS[this.coconut].x : this.target.x, 8, true);
  }

  /** Between rounds: the warm-up rally, while the camera is near enough to see it. */
  private updateAmbient(dt: number) {
    if (this.flying) return;
    if (this.ambientT > 0) {
      this.ambientT -= dt;
      if (this.ambientT <= 0) {
        // back to places, and a fresh ball in play
        this.partner.goTo(-2, -4);
        this.stand.goTo(2, -4.8);
        this.locals[0].goTo(-2, 4.4);
        this.locals[1].goTo(2, 4.8);
        this.ambientServe();
      }
    } else this.ambientT = 0.5;
  }

  // ---------------------------------------------------------------------------------------------
  // The camera

  updateCamera(cam: THREE.PerspectiveCamera, dt: number) {
    cam.up.set(0, 1, 0);
    const k = this.camInit ? 1 - Math.exp(-dt * 3.2) : 1;
    const b = this.b;
    const pos = this.v1;
    const look = this.v2;
    if (this.cam === 'player') {
      // behind the visitor, looking down the court past the ball
      // (higher and further back at the net, so a spike's jump and the ball above it stay in view)
      const atNet = THREE.MathUtils.smoothstep(this.me.pos.z, -6, -2);
      const mx = this.me.pos.x * 0.55;
      const mz = Math.max(-13.6, this.me.pos.z - 4.6 - atNet * 1.6);
      pos.set(mx + 0.8, 2.75 + atNet * 1.2 + Math.max(0, b.y - 4) * 0.15, mz);
      look.set(THREE.MathUtils.lerp(mx, b.x, 0.35) * 0.6, 1.5 + atNet * 1.1, Math.max(mz + 6, THREE.MathUtils.lerp(4, b.z, 0.3)));
      if (this.phase === 'aim' && this.coconut < 0) look.x = THREE.MathUtils.lerp(look.x, this.target.x * 0.4, 0.6);
    } else if (this.cam === 'tv') {
      // courtside, high on the beach side with the bleachers behind the play, panning with the ball
      pos.set(-12.5, 6.4, THREE.MathUtils.clamp(b.z * 0.35, -4, 4) - 1.5);
      look.set(0.8, 0.9, THREE.MathUtils.clamp(b.z * 0.55, -6, 6));
    } else {
      // low from the beach end, behind the visitor's corner, across the court to the shy
      pos.set(-6.5, 1.7, -14);
      look.set(THREE.MathUtils.clamp(b.x * 0.4, -2, 2), 1.6, THREE.MathUtils.clamp(b.z * 0.6, -2, 6) + 3);
    }
    toWorld(pos.x, pos.y, pos.z, pos);
    toWorld(look.x, look.y, look.z, look);
    if (!this.camInit) {
      this.camPos.copy(this.ctx.camera.position);
      this.camLook.copy(look);
      this.camInit = true;
    }
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    cam.position.copy(this.camPos);
    cam.lookAt(this.camLook);
  }

  // ---------------------------------------------------------------------------------------------
  // The HUD

  private buildHud() {
    const el = document.createElement('div');
    el.id = 'vb-hud';
    el.className = 'vb-hud';
    el.hidden = true;
    el.innerHTML = `
      <div class="vb-top">
        <div><span>Serve</span><b id="vb-serve">1/${SERVES}</b></div>
        <div class="vb-score"><span>Score</span><b id="vb-score">0</b></div>
        <div id="vb-streak-box"><span>Streak</span><b id="vb-streak">0</b></div>
        <div><span>Aces</span><b id="vb-aces">0</b></div>
        <div><span>🥥</span><b id="vb-nuts">0</b></div>
      </div>
      <p class="vb-hint" id="vb-hint"></p>
      <p class="vb-grade" id="vb-grade" hidden></p>
      <div class="vb-meter" id="vb-meter" hidden>
        <p><span id="vb-meter-label">Serve</span><b id="vb-meter-tip">Strike!</b></p>
        <div class="vb-bar"><i class="vb-ok" id="vb-ok"></i><i class="vb-good" id="vb-good"></i><i class="vb-perfect" id="vb-perfect"></i><em id="vb-marker"></em></div>
      </div>
      <p class="vb-toast" id="vb-toast" hidden></p>
      <p class="vb-keys" id="vb-keys"></p>
      <p class="vb-cam" id="vb-cam"></p>`;
    const hud = document.getElementById('hud');
    const panel = document.getElementById('panel');
    if (hud && panel && panel.parentElement === hud) hud.insertBefore(el, panel);
    else (hud ?? document.body).appendChild(el);
    return el;
  }

  private setHint(html: string) {
    $('vb-hint').innerHTML = html;
  }

  private toast(title: string, sub: string, won: boolean) {
    const el = $('vb-toast');
    el.hidden = false;
    el.className = `vb-toast${won ? '' : ' is-lost'}`;
    el.innerHTML = `${title}<small>${sub}</small>`;
    // restart the pop animation
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastT = 2.4;
  }

  private showGrade(g: Grade, err: number) {
    const el = $('vb-grade');
    const words: Record<Grade, string> = { perfect: 'PERFECT!', good: 'Good', ok: err < 0 ? 'A bit early' : 'A bit late', miss: err < 0 ? 'Too early' : 'Too late' };
    el.textContent = words[g];
    el.className = `vb-grade is-${g}`;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.gradeT = 1.1;
  }

  /** The meter for a timing window (null hides it; `frozen` leaves the marker where the press was). */
  private showMeter(tm: Timing | null, frozen?: number) {
    const m = $('vb-meter');
    if (!tm) {
      if (frozen !== undefined) {
        m.classList.add('is-done');
        this.meterHold = 0.5;
      } else if (this.meterHold <= 0) m.hidden = true;
      return;
    }
    m.hidden = false;
    m.classList.remove('is-done');
    const span = tm.t1 - tm.t0;
    const at = (tm.perfect - tm.t0) / span;
    const band = (id: string, tol: number) => {
      const w = ((tol * 2 * tm.scale) / span) * 100;
      const el = $(id);
      el.style.left = `${at * 100 - w / 2}%`;
      el.style.width = `${w}%`;
    };
    band('vb-ok', TOLERANCE.ok);
    band('vb-good', TOLERANCE.good);
    band('vb-perfect', TOLERANCE.perfect);
    $('vb-meter-label').textContent = tm.kind === 'serve' ? 'Serve' : tm.kind === 'dig' ? 'Dig' : 'Spike';
    $('vb-meter-tip').textContent = tm.kind === 'serve' ? 'Hit it at the top!' : tm.kind === 'dig' ? 'Get under it!' : 'Swing!';
  }
  private meterHold = 0;
  private meterFor: Timing | null = null;

  private updateHud(dt: number) {
    const s = this.stats;
    const key = `${s.served}|${s.score}|${s.streak}|${s.aces}|${s.coconuts}|${this.serveInPlay}`;
    if (key !== this.hudKey) {
      this.hudKey = key;
      $('vb-serve').textContent = `${Math.min(SERVES, s.served + (this.serveInPlay ? 0 : 1))}/${SERVES}`;
      $('vb-score').textContent = String(s.score);
      $('vb-streak').textContent = String(s.streak);
      $('vb-streak-box').className = s.streak >= 3 ? 'vb-hot' : '';
      $('vb-aces').textContent = String(s.aces);
      $('vb-nuts').textContent = String(s.coconuts);
    }
    const tm = this.timing;
    if (tm !== this.meterFor) {
      this.meterFor = tm;
      if (tm) this.showMeter(tm);
    }
    if (tm) {
      const u = THREE.MathUtils.clamp((this.b.t - tm.t0) / (tm.t1 - tm.t0), 0, 1);
      $('vb-marker').style.left = `${u * 100}%`;
    } else if (this.meterHold > 0 && (this.meterHold -= dt) <= 0) $('vb-meter').hidden = true;
    if (this.toastT > 0 && (this.toastT -= dt) <= 0) $('vb-toast').hidden = true;
    if (this.gradeT > 0 && (this.gradeT -= dt) <= 0) $('vb-grade').hidden = true;
  }
}
