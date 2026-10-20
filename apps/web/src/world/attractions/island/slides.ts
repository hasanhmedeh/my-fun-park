// Splash Tower: Palm Cay's water-slide tower. Three slides of very different character leave a
// 24 m deck: the Kamikaze, a 52° free-fall drop into a splash lane; the Typhoon, an enclosed body
// tube that corkscrews down a double helix with clear sections; and the Lazy Loop, a wide family
// ring slide round a big open loop. A round: the visitor climbs the tower (a crane shot up the
// stairs), picks a slide at the top, waits for the dispatcher's green light, rides it, and splashes
// into the pool. When nobody is riding, guests keep going down all three slides.
//
// The physics is a bead on the flume's cross-section (slides-path.ts): gravity along the
// centreline, water friction from the wall's push, and the rider swinging up the walls in the
// curves. On the slide the visitor can tuck (W: arms in, heels together, faster) or sit up and
// spread out (S: slower), and lean (A/D) to climb a wall or keep off it.

import * as THREE from 'three';
import type { Attraction, Ctx } from '../../context';
import type { Input } from '../../input';
import { ISLAND_SPOTS } from '../../geo';
import { glowTexture, PALETTE } from '../../textures';
import { G, POOL, SLIDES, TOWER, buildSlide, frame, sampleSlide, sectionAt, simulate, stepRider, type RiderState, type Run, type Section, type SlidePath } from './slides-path';
import { LOOKS, buildSplashTower, riderGeometry, stairPath, towerPeople, type Look, type Pose, type SlideMaterials, type SplashTowerBuild } from './slides-build';
import './slides.css';

/** The attraction's anchor (world): every mesh is local to it. */
const ANCHOR = new THREE.Vector3(ISLAND_SPOTS.slides.x, 0, ISLAND_SPOTS.slides.z);
/** The zone ring in front of the entrance arch (world), facing the tower (west). */
export const SLIDES_RING = { x: ANCHOR.x + 45, z: ANCHOR.z + 2, heading: Math.PI / 2 };

type Phase = 'idle' | 'climb' | 'pick' | 'ready' | 'ride' | 'fly' | 'float' | 'done';
type CamMode = 'pov' | 'chase' | 'drone';
const CAM_LABEL: Record<CamMode, string> = { pov: 'Rider', chase: 'Chase', drone: 'Drone' };

/** The crane shot up the tower, the shortest wait at the gate, and how long you bob in the pool. */
const CLIMB_T = 7.5;
const READY_MIN = 1.6;
const FLOAT_T = 3.6;
/** How far down the slide the guest ahead must be before the dispatcher sends the next (fraction). */
const CLEAR: Record<string, number> = { kamikaze: 0.97, typhoon: 0.42, lazy: 0.4 };
/** Where the visitor's eye is in each pose (rider's local frame: +Y off the surface, −Z feet first). */
const EYE: Record<Pose, THREE.Vector3> = { lie: new THREE.Vector3(0, 0.44, 0.6), ring: new THREE.Vector3(0, 0.86, 0.24), stand: new THREE.Vector3(0, 1.62, 0) };
/** Fixed cameras round the plot (local) for the drone view: the nearest one watches. */
const DRONES = [
  new THREE.Vector3(32, 16, -6),
  new THREE.Vector3(-36, 15, -20),
  new THREE.Vector3(-38, 6, 16),
  new THREE.Vector3(30, 6, 24),
  new THREE.Vector3(2, 10, 18),
  new THREE.Vector3(16, 30, -62),
  new THREE.Vector3(-6, 4, 66),
];
const STORE = 'fair-slides';

/** What the picker says about each slide. */
const ABOUT: Record<string, { what: string; thrill: number; pose: Pose; toast: Partial<Record<Section, string>> }> = {
  kamikaze: { what: 'Body slide · a 52° free-fall drop · splash lane', thrill: 5, pose: 'lie', toast: { lane: 'Splash lane! 🌊' } },
  typhoon: { what: 'Enclosed body tube · double helix · clear sections', thrill: 3, pose: 'lie', toast: { tube: 'Into the tube 🌀', clear: 'Daylight! 👀' } },
  lazy: { what: 'Family ring slide · one big open loop', thrill: 1, pose: 'ring', toast: {} },
};

interface Records {
  [id: string]: { bestS?: number; topKmh?: number };
}

/** A guest (or the visitor) on a slide, in the air off its lip, or bobbing in the pool. */
interface Body {
  mesh: THREE.Mesh;
  path: SlidePath;
  state: 'wait' | 'ride' | 'fly' | 'float';
  /** Time in the state, and (waiting) the time until the next go. */
  t: number;
  wait: number;
  s: number;
  phi: number;
  v: number;
  spin: number;
  /** In the air and in the pool: where (local), how fast, which way they face. */
  p: THREE.Vector3;
  vel: THREE.Vector3;
  fwd: THREE.Vector3;
  run: Run;
}

const $ = (id: string) => document.getElementById(id)!;
const fmtS = (t: number) => `${t.toFixed(1)} s`;

/** Spray: droplets (one points cloud) and expanding rings on the water (one instanced mesh). */
class Splashes {
  readonly points: THREE.Points;
  readonly rings: THREE.InstancedMesh;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private next = 0;
  private ring: { t: number; max: number; x: number; z: number; r: number; k: number }[] = [];
  private nextRing = 0;
  private live = 0;
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private static N = 520;
  private static RINGS = 10;

  constructor() {
    const n = Splashes.N;
    this.pos = new Float32Array(n * 3).fill(-50);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n).fill(1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 10, 0), 120);
    this.points = new THREE.Points(
      g,
      new THREE.PointsMaterial({ map: glowTexture('#ffffff'), size: 0.32, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, vertexColors: true }),
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
    const ringGeo = new THREE.RingGeometry(0.88, 1, 40).rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), Splashes.RINGS);
    for (let i = 0; i < Splashes.RINGS; i++) {
      this.rings.setMatrixAt(i, this.m.makeScale(0.001, 0.001, 0.001));
      this.rings.setColorAt(i, this.c.setRGB(0, 0, 0));
      this.ring.push({ t: 1, max: 1, x: 0, z: 0, r: 1, k: 0 });
    }
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 5;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number) {
    const i = this.next;
    this.next = (this.next + 1) % Splashes.N;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.life[i] = life;
    this.max[i] = life;
    this.live = Math.max(this.live, 2.5);
  }

  /** Someone hitting the water: a crown of drops and two rings; `power` ~0.3 (a ghost far off) .. 1.5. */
  splash(at: THREE.Vector3, dir: THREE.Vector3, power: number) {
    const n = Math.round(70 * power);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const out = 0.8 + Math.random() * 2.6 * power;
      const up = 2.2 + Math.random() * 4.5 * power;
      this.emit(at.x, at.y + 0.1, at.z, Math.cos(a) * out + dir.x * 2.4 * power, up, Math.sin(a) * out + dir.z * 2.4 * power, 0.7 + Math.random() * 0.8);
    }
    this.addRing(at.x, at.z, 3.2 * power + 1, 1.6, 0.7);
    this.addRing(at.x + dir.x, at.z + dir.z, 2 * power + 0.6, 1.1, 0.5);
  }

  /** A rooster tail of spray behind a rider ploughing through the splash lane. */
  spray(at: THREE.Vector3, dir: THREE.Vector3, speed: number) {
    const n = Math.min(4, Math.round(speed / 4));
    for (let i = 0; i < n; i++) {
      const a = (Math.random() - 0.5) * 1.6;
      const side = Math.sin(a);
      this.emit(at.x, at.y, at.z, -dir.x * speed * 0.15 + dir.z * side * 1.5, 1 + Math.random() * speed * 0.18, -dir.z * speed * 0.15 - dir.x * side * 1.5, 0.45 + Math.random() * 0.35);
    }
  }

  private addRing(x: number, z: number, r: number, max: number, k: number) {
    // a ring stops at the pool walls rather than spreading over the coping
    const room = Math.min(x - POOL.x0, POOL.x1 - x, z - POOL.z0, POOL.z1 - z) - 0.25;
    if (room < 0.4) return;
    this.ring[this.nextRing] = { t: 0, max, x, z, r: Math.min(r, room), k };
    this.nextRing = (this.nextRing + 1) % Splashes.RINGS;
    this.live = Math.max(this.live, max);
  }

  update(dt: number) {
    if (this.live <= 0) return;
    this.live -= dt;
    const p = this.pos;
    const v = this.vel;
    for (let i = 0; i < Splashes.N; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      v[j + 1] -= G * dt;
      p[j] += v[j] * dt;
      p[j + 1] += v[j + 1] * dt;
      p[j + 2] += v[j + 2] * dt;
      const k = this.life[i] <= 0 || p[j + 1] < POOL.water - 0.05 ? 0 : Math.min(1, this.life[i] / this.max[i] + 0.2) * 0.75;
      if (k === 0) this.life[i] = 0;
      this.col[j] = this.col[j + 1] = this.col[j + 2] = k;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
    for (let i = 0; i < Splashes.RINGS; i++) {
      const r = this.ring[i];
      if (r.t >= r.max) continue;
      r.t += dt;
      const f = Math.min(1, r.t / r.max);
      const s = r.r * (0.3 + 0.7 * Math.sqrt(f));
      this.m.makeScale(s, 1, s).setPosition(r.x, POOL.water + 0.03, r.z);
      this.rings.setMatrixAt(i, this.m);
      const k = r.k * (1 - f) * (1 - f);
      this.rings.setColorAt(i, this.c.setRGB(k, k, k));
    }
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
  }
}

export class Slides implements Attraction {
  readonly group: THREE.Group;
  private paths: SlidePath[];
  private build: SplashTowerBuild;
  private mats: SlideMaterials;
  private splashes = new Splashes();
  private ghosts: Body[] = [];
  private me: { lie: THREE.Mesh; ring: THREE.Mesh; stand: THREE.Mesh };
  private body: Body | null = null;
  private st: RiderState = { s: 0, v: 0, phi: 0, omega: 0, normal: G };
  private stair: THREE.Vector3[];
  private stairLen: number[] = [];
  private phase: Phase = 'idle';
  private phaseT = 0;
  private choice = 0;
  private picked: SlidePath | null = null;
  private camMode: CamMode = 'pov';
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private camDir = new THREE.Vector3();
  private camUp = new THREE.Vector3(0, 1, 0);
  private camReset = true;
  private saved = { fov: 42, near: 0.5 };
  private awake = true;
  private night = 0;
  private introTimer = 0;
  private toastTimer = 0;
  private hudTimer = 0;
  private lastSec: Section | null = null;
  private dropped = false;
  private looped = false;
  private gSmooth = 1;
  private stats = { top: 0, maxG: 1, rideT: 0, y0: 0, yMin: 0, rode: false };
  private final: Record<string, number> | null = null;
  private records: Records = {};
  private steerWas = 0;
  private underwater = false;
  private hud: HTMLElement;
  private pickEl: HTMLElement;
  private underEl: HTMLElement;
  // scratch
  private f = frame();
  private f2 = frame();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private bx = new THREE.Vector3();
  private bn = new THREE.Vector3();
  private bt = new THREE.Vector3();
  private focusV = new THREE.Vector3();
  private posV = new THREE.Vector3();
  private lampC = new THREE.Color();
  input: Input | null = null;
  active = false;
  onFinish: (() => void) | null = null;
  /** The visitor has splashed down and bobbed back up: the round is over (fired once). */
  onComplete: (() => void) | null = null;

  constructor(private ctx: Ctx) {
    this.paths = SLIDES.map(buildSlide);
    this.build = buildSplashTower(ctx, ANCHOR, this.paths);
    this.group = this.build.group;
    this.mats = this.build.mats;
    this.group.add(this.splashes.points, this.splashes.rings);
    const people = new THREE.Mesh(towerPeople(), this.mats.rider);
    people.castShadow = ctx.quality.shadows;
    this.group.add(people);
    const mk = (pose: Pose, look: Look) => {
      const m = new THREE.Mesh(riderGeometry(pose, look), this.mats.rider);
      m.matrixAutoUpdate = false;
      m.castShadow = ctx.quality.shadows;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    const mine: Look = { skin: '#e3a57a', suit: PALETTE.mustard, hair: '#4a2e18', onePiece: false, ring: '#2ec4b6' };
    this.me = { lie: mk('lie', mine), ring: mk('ring', mine), stand: mk('stand', mine) };
    this.paths.forEach((path, k) => {
      const pose = ABOUT[path.spec.id].pose;
      this.ghosts.push({
        mesh: mk(pose, LOOKS[[1, 5, 2][k]]),
        path,
        state: 'wait',
        t: 0,
        wait: 1 + k * 3,
        s: 0,
        phi: 0,
        v: 0,
        spin: 0,
        p: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        fwd: new THREE.Vector3(),
        run: simulate(path, null),
      });
    });
    this.stair = stairPath();
    let acc = 0;
    this.stairLen = this.stair.map((p, i) => (acc += i ? p.distanceTo(this.stair[i - 1]) : 0));
    ctx.scene.add(this.group);
    try {
      this.records = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Records;
    } catch {
      /* storage unavailable */
    }
    ({ hud: this.hud, pick: this.pickEl, under: this.underEl } = this.makeDom());
    window.addEventListener('keydown', (e) => {
      if (!this.active || this.phase !== 'pick' || e.repeat || this.input?.paused) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.closest?.('dialog, .shop'))) return;
      const n = ({ Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 } as Record<string, number>)[e.code];
      if (n === undefined) return;
      e.preventDefault();
      this.go(n);
    });
  }

  // ------------------------------------------------------------------ DOM

  private makeDom() {
    const host = document.getElementById('hud') ?? document.body;
    const before = document.getElementById('panel');
    const add = (html: string) => {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      const el = t.content.firstElementChild as HTMLElement;
      if (before && before.parentElement === host) host.insertBefore(el, before);
      else host.appendChild(el);
      return el;
    };
    const under = add('<div id="sl-under" class="sl-under" aria-hidden="true"></div>');
    const hud = add(`<div id="sl-hud" class="ride-hud sl-hud" hidden>
      <div class="rh-top">
        <p class="rh-speed"><b id="sl-speed">0</b><span>km/h</span></p>
        <p class="rh-g"><b id="sl-g">1.0</b><span>G</span></p>
      </div>
      <div class="rh-bar" aria-hidden="true"><i id="sl-tuck"></i></div>
      <dl class="rh-stats">
        <div><dt>Slide</dt><dd id="sl-name">—</dd></div>
        <div><dt>Time</dt><dd id="sl-time">0.0 s</dd></div>
        <div><dt>Best</dt><dd id="sl-best">—</dd></div>
      </dl>
      <p class="rh-keys" id="sl-keys"></p>
      <p class="rh-toast" id="sl-toast" hidden></p>
    </div>`);
    const pick = add(`<div id="sl-pick" class="sl-pick" hidden>
      <p class="sl-eyebrow">Splash Tower · ${TOWER.deck} m up</p>
      <h2>Pick your slide</h2>
      <div class="sl-cards" id="sl-cards"></div>
      <p class="sl-hint"><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> or click · <kbd>A</kbd> <kbd>D</kbd> choose · <kbd>E</kbd> go</p>
    </div>`);
    pick.addEventListener('click', (e) => {
      const card = (e.target as HTMLElement).closest<HTMLElement>('[data-slide]');
      if (!card) return;
      card.blur();
      this.go(Number(card.dataset.slide));
    });
    return { hud, pick, under };
  }

  private cardsHtml() {
    return this.paths
      .map((p, k) => {
        const a = ABOUT[p.spec.id];
        const run = this.ghosts[k].run;
        const rec = this.records[p.spec.id];
        const best = rec?.bestS ? `Your best ${fmtS(rec.bestS)} · ${Math.round(rec.topKmh ?? 0)} km/h` : 'Not ridden yet';
        return `<button class="sl-card${k === this.choice ? ' is-on' : ''}" data-slide="${k}" style="--c:${p.spec.colour}" type="button">
          <span class="sl-name"><b>${p.spec.n}</b>${p.spec.name}</span>
          <span class="sl-what">${a.what}</span>
          <span class="sl-thrill">Thrill <i>${'●'.repeat(a.thrill)}${'○'.repeat(5 - a.thrill)}</i></span>
          <span class="sl-what">${Math.round(p.length)} m · up to ${Math.round((run.topSpeed * 3.6) / 5) * 5} km/h · ${Math.round(run.duration)} s</span>
          <span class="sl-best">${best}</span>
        </button>`;
      })
      .join('');
  }

  private highlight(k: number) {
    this.choice = (k + 3) % 3;
    this.pickEl.querySelectorAll<HTMLElement>('[data-slide]').forEach((el) => el.classList.toggle('is-on', Number(el.dataset.slide) === this.choice));
    this.ctx.sfx.pop();
  }

  private toast(text: string) {
    const el = $('sl-toast');
    el.textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    this.toastTimer = 2.6;
  }

  // ------------------------------------------------------------------ the round

  /** The zone ring's spot (world): in front of the entrance arch, facing the tower. */
  get standSpot() {
    return SLIDES_RING;
  }

  /** The integrator calls this by region: the island's attractions sleep while the visitor is elsewhere. */
  setAwake(on: boolean) {
    this.awake = on;
  }

  /** 0 by day .. 1 at night: LED strips, the boards, the pool's underwater lights, the tubes' glow. */
  setNight(k: number) {
    this.night = k;
    this.mats.led.color.setScalar(0.45 + k * 3.2);
    this.mats.sign.emissiveIntensity = 0.06 + k * 0.85;
    this.mats.pool.emissiveIntensity = k * 0.9;
    this.mats.uGlow.value = 0.32 * (1 - k) + 0.5 * k;
  }

  start() {
    this.active = true;
    this.phase = 'climb';
    this.phaseT = 0;
    this.final = null;
    this.picked = null;
    this.body = null;
    this.stats = { top: 0, maxG: 1, rideT: 0, y0: 0, yMin: 0, rode: false };
    this.camMode = 'pov';
    this.camReset = true;
    this.saved = { fov: this.ctx.camera.fov, near: this.ctx.camera.near };
    this.me.stand.visible = true;
    this.hud.hidden = true;
    this.pickEl.hidden = true;
    document.body.classList.add('is-sliding');
    $('sl-keys').innerHTML = this.ctx.mobile
      ? 'Stick: up tuck (faster) · down sit up · sideways lean'
      : '<kbd>W</kbd> tuck · <kbd>S</kbd> sit up · <kbd>A</kbd><kbd>D</kbd> lean · <kbd>C</kbd> camera';
    this.ctx.ui.score(this.ctx.mobile ? '🪜 Climbing the tower · tap E to skip' : '🪜 Climbing the tower · E to skip');
    const shown = this.ctx.ui.setIntro('slides-intro', 'Splash Tower', this.introHtml(), { accent: PALETTE.teal });
    this.introTimer = shown ? 8 : 0;
    this.ctx.sfx.chime();
  }

  private introHtml() {
    const keys = this.ctx.mobile
      ? 'Tap a slide at the top. On the way down, push the stick up to tuck in and go faster, down to sit up and slow down, sideways to lean.'
      : 'Pick a slide at the top with <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd>. On the way down: <kbd>W</kbd> tuck in (faster), <kbd>S</kbd> sit up (slower), <kbd>A</kbd>/<kbd>D</kbd> lean, <kbd>C</kbd> camera.';
    return `<p class="eyebrow">Splash Tower · three slides · ${TOWER.deck} m</p><h2>Climb, pick, splash! 💦</h2><p>${keys}</p><ul class="tags"><li>Kamikaze</li><li>Typhoon</li><li>Lazy Loop</li></ul>`;
  }

  /** E / Space / tap: skip the climb, go down the highlighted slide, or get out of the pool. */
  action() {
    if (!this.active) return;
    if (this.phase === 'climb') this.toTop();
    else if (this.phase === 'pick') this.go(this.choice);
    else if (this.phase === 'float' && this.phaseT > 0.8) this.complete();
  }

  private toTop() {
    this.phase = 'pick';
    this.phaseT = 0;
    this.me.stand.visible = false;
    this.camReset = true;
    this.ctx.ui.score(null);
    $('sl-cards').innerHTML = this.cardsHtml();
    this.pickEl.hidden = false;
  }

  /** Picks slide k: sit down at its start and wait for the green light. */
  private go(k: number) {
    if (this.phase !== 'pick') return;
    this.choice = k;
    const path = this.paths[k];
    this.picked = path;
    this.pickEl.hidden = true;
    this.phase = 'ready';
    this.phaseT = 0;
    const pose = ABOUT[path.spec.id].pose;
    const mesh = pose === 'ring' ? this.me.ring : this.me.lie;
    this.st = { s: 0.3, v: 0, phi: 0, omega: 0, normal: G };
    this.body = { mesh, path, state: 'ride', t: 0, wait: 0, s: 0.3, phi: 0, v: 0, spin: 0, p: new THREE.Vector3(), vel: new THREE.Vector3(), fwd: new THREE.Vector3(), run: this.ghosts[k].run };
    mesh.visible = true;
    this.placeOnSlide(mesh, path, 0.3, 0, 0);
    $('sl-name').textContent = path.spec.name;
    const rec = this.records[path.spec.id];
    $('sl-best').textContent = rec?.bestS ? fmtS(rec.bestS) : '—';
    $('sl-time').textContent = fmtS(0);
    $('sl-toast').hidden = true;
    this.hud.hidden = false;
    this.camReset = true;
    this.ctx.ui.countdown('Wait for green…');
    this.ctx.sfx.pop();
  }

  private push() {
    this.phase = 'ride';
    this.phaseT = 0;
    this.lastSec = null;
    this.dropped = false;
    this.looped = false;
    this.gSmooth = 1;
    this.st.v = 1.6;
    sampleSlide(this.picked!, this.st.s, this.f);
    this.stats = { top: 0, maxG: 1, rideT: 0, y0: this.f.p.y, yMin: this.f.p.y, rode: true };
    this.ctx.ui.countdown('GO!');
    this.ctx.sfx.whoosh(0.8);
  }

  private complete() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.final = this.measure();
    this.onComplete?.();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    if (!this.final) this.final = this.measure();
    this.phase = 'idle';
    this.hud.hidden = true;
    this.pickEl.hidden = true;
    this.underEl.style.opacity = '0';
    this.underwater = false;
    this.me.lie.visible = this.me.ring.visible = this.me.stand.visible = false;
    this.body = null;
    document.body.classList.remove('is-sliding');
    const cam = this.ctx.camera;
    cam.fov = this.saved.fov;
    cam.near = this.saved.near;
    cam.updateProjectionMatrix();
    this.ctx.ui.countdown(null);
    this.ctx.ui.score(null);
    this.onFinish?.();
  }

  /** This round's numbers (see account/stats.ts): nothing until a slide has been picked and ridden. */
  roundStats(): Record<string, number> {
    return this.final ?? this.measure();
  }

  private measure(): Record<string, number> {
    if (!this.picked || !this.stats.rode) return {};
    return {
      slide: this.picked.spec.n,
      topSpeedKmh: this.stats.top * 3.6,
      maxG: this.stats.maxG,
      dropM: this.stats.y0 - this.stats.yMin,
      durationS: this.stats.rideT,
    };
  }

  cycleCamera() {
    const order: CamMode[] = ['pov', 'chase', 'drone'];
    this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length];
    this.camReset = true;
    this.toast(`${CAM_LABEL[this.camMode]} camera`);
    this.ctx.sfx.pop();
  }

  // ------------------------------------------------------------------ placing riders

  /** Puts a rider on the flume at arc length s, swung phi up the wall; `spin` turns a ring about its axis. */
  private placeOnSlide(mesh: THREE.Mesh, path: SlidePath, s: number, phi: number, spin: number) {
    const f = sampleSlide(path, s, this.f2);
    const R = path.spec.radius - 0.015;
    // from the axis to the wall under the rider
    this.v1.copy(f.r).multiplyScalar(Math.sin(phi)).addScaledVector(f.u, -Math.cos(phi));
    this.v2.copy(f.p).addScaledVector(this.v1, R);
    // a rider in the splash lane sits down in its standing water
    this.bn.copy(this.v1).negate();
    this.bt.copy(f.t).addScaledVector(this.bn, -f.t.dot(this.bn)).normalize();
    this.setBasis(mesh, this.v2, this.bn, this.bt, spin);
  }

  /** A rider in the air or in the pool: at p, `n` up off their back, facing `fwd`. */
  private setBasis(mesh: THREE.Mesh, p: THREE.Vector3, n: THREE.Vector3, fwd: THREE.Vector3, spin: number) {
    this.bt.copy(fwd);
    if (spin) this.bt.applyAxisAngle(n, spin);
    this.bx.crossVectors(this.bt, n).normalize();
    this.v3.copy(this.bt).negate();
    mesh.matrix.makeBasis(this.bx, n, this.v3).setPosition(p);
    mesh.matrixWorldNeedsUpdate = true;
  }

  /** Off the end of the flume: the rider flies from its lip in the direction of travel. */
  private launch(b: Body, v: number) {
    const f = sampleSlide(b.path, b.path.length, this.f2);
    b.p.copy(f.p).addScaledVector(f.u, -(b.path.spec.radius - 0.03));
    b.vel.copy(f.t).multiplyScalar(Math.max(v, 1.5));
    b.fwd.set(f.t.x, 0, f.t.z).normalize();
    b.state = 'fly';
    b.t = 0;
  }

  /** In the air: gravity until the water; then the splash. Returns true on the splash. */
  private fly(b: Body, dt: number) {
    b.vel.y -= G * dt;
    b.p.addScaledVector(b.vel, dt);
    this.v1.set(0, 1, 0).lerp(this.v2.copy(b.fwd).negate(), 0.2).normalize();
    this.setBasis(b.mesh, b.p, this.v1, b.fwd, b.spin);
    if (b.p.y > POOL.water - 0.05) return false;
    b.p.y = POOL.water - 0.05;
    b.state = 'float';
    b.t = 0;
    b.vel.y = 0;
    return true;
  }

  /** Bobbing in the pool: plunged under, back up, drifting to a stop. */
  private float(b: Body, dt: number) {
    b.t += dt;
    b.vel.multiplyScalar(Math.exp(-2.2 * dt));
    b.p.addScaledVector(b.vel, dt);
    b.p.x = THREE.MathUtils.clamp(b.p.x, POOL.x0 + 0.8, POOL.x1 - 0.8);
    b.p.z = THREE.MathUtils.clamp(b.p.z, POOL.z0 + 0.8, POOL.z1 - 0.8);
    const dip = 0.85 * Math.sin(Math.min(1, b.t / 0.95) * Math.PI) * Math.exp(-b.t);
    const ring = b.mesh === this.me.ring || ABOUT[b.path.spec.id].pose === 'ring';
    b.p.y = POOL.water - (ring ? 0.12 : 0.2) - dip + Math.sin(b.t * 2.4) * 0.03;
    // a body slider floats on their back, feet up a little; a ring floats flat
    this.v1.set(0, 1, 0);
    if (!ring) this.v1.addScaledVector(b.fwd, -0.25).normalize();
    b.spin += dt * (ring ? 0.5 : 0) * Math.exp(-b.t * 0.3);
    this.setBasis(b.mesh, b.p, this.v1, b.fwd, b.spin);
  }

  // ------------------------------------------------------------------ every frame

  update(dt: number, t: number) {
    if (!this.awake && !this.active) return;
    // nothing to animate for a camera kilometres away (the island seen from the flight)
    const cam = this.ctx.camera.position;
    const far = Math.hypot(cam.x - ANCHOR.x, cam.z - ANCHOR.z) > 900;
    if (far && !this.active) return;
    this.mats.uTime.value = t;
    const ripple = this.mats.pool.map;
    if (ripple) ripple.offset.set(t * 0.012, t * 0.007);
    this.updateGhosts(dt);
    this.splashes.update(dt);
    this.updateLamps(t);
    if (!this.active) return;

    if (this.introTimer > 0 && (this.introTimer -= dt) <= 0 && this.ctx.ui.panelOpenKey === 'slides-intro') this.ctx.ui.hidePanel();
    this.phaseT += dt;
    if (this.toastTimer > 0 && (this.toastTimer -= dt) <= 0) $('sl-toast').hidden = true;
    switch (this.phase) {
      case 'climb':
        this.climb();
        if (this.phaseT >= CLIMB_T) this.toTop();
        break;
      case 'pick': {
        // A / D (or the stick) step the highlight; 1 2 3, a click or E go
        const s = this.input?.steer ?? 0;
        const dir = s > 0.5 ? -1 : s < -0.5 ? 1 : 0;
        if (dir && dir !== this.steerWas) this.highlight(this.choice + dir);
        this.steerWas = dir;
        break;
      }
      case 'ready':
        if (this.phaseT >= READY_MIN && this.clear(this.choice)) {
          this.push();
        }
        break;
      case 'ride':
        this.ride(dt);
        break;
      case 'fly': {
        const b = this.body!;
        this.stats.yMin = Math.min(this.stats.yMin, b.p.y);
        if (this.fly(b, dt)) this.splashDown(b);
        break;
      }
      case 'float':
        this.float(this.body!, dt);
        if (this.phaseT > 1.2) this.ctx.ui.countdown(null);
        if (this.phaseT >= FLOAT_T) this.complete();
        break;
      default:
        break;
    }
    if (this.phase === 'ride' || this.phase === 'fly') this.stats.rideT += dt;
    this.updateHud(dt);
  }

  /** The guest ahead on slide k is far enough down (or not riding at all). */
  private clear(k: number) {
    const g = this.ghosts[k];
    return g.state !== 'ride' || g.s / g.path.length >= CLEAR[g.path.spec.id];
  }

  private climb() {
    // the avatar walks the stair's polyline (the crane shot follows it)
    const k = THREE.MathUtils.smoothstep(this.phaseT / CLIMB_T, 0, 1);
    const L = this.stairLen[this.stairLen.length - 1];
    const d = k * L;
    let i = 1;
    while (i < this.stair.length - 1 && this.stairLen[i] < d) i++;
    const a = this.stair[i - 1];
    const b = this.stair[i];
    const f = (d - this.stairLen[i - 1]) / Math.max(1e-6, this.stairLen[i] - this.stairLen[i - 1]);
    this.posV.copy(a).lerp(b, f);
    this.v1.set(b.x - a.x, 0, b.z - a.z);
    if (this.v1.lengthSq() < 1e-6) this.v1.set(0, 0, -1);
    this.v1.normalize();
    this.setBasis(this.me.stand, this.posV, this.v2.set(0, 1, 0), this.v1, 0);
  }

  private ride(dt: number) {
    const path = this.picked!;
    const b = this.body!;
    const inp = this.input ? { tuck: this.input.throttle, lean: -this.input.steer } : null;
    const n = Math.min(8, Math.max(1, Math.ceil(dt * 160)));
    const h = dt / n;
    let going = true;
    for (let i = 0; i < n && going; i++) going = stepRider(path, this.st, inp, h);
    const st = this.st;
    this.gSmooth += (st.normal / G - this.gSmooth) * Math.min(1, dt * 8);
    this.stats.top = Math.max(this.stats.top, st.v);
    this.stats.maxG = Math.max(this.stats.maxG, this.gSmooth);
    b.s = Math.min(st.s, path.length);
    b.phi = st.phi;
    b.v = st.v;
    this.placeOnSlide(b.mesh, path, b.s, b.phi, 0);
    sampleSlide(path, b.s, this.f);
    this.stats.yMin = Math.min(this.stats.yMin, this.f.p.y - path.spec.radius);
    // beats along the way
    const sec = sectionAt(path, b.s);
    if (sec !== this.lastSec) {
      const say = ABOUT[path.spec.id].toast[sec];
      if (say && this.lastSec !== null) this.toast(say);
      if (sec === 'tube' || sec === 'clear') this.ctx.sfx.whoosh(st.v / 10);
      this.lastSec = sec;
    }
    if (!this.dropped && this.f.t.y < -0.6) {
      this.dropped = true;
      this.toast('Free fall! 😱');
      this.ctx.sfx.whoosh(2);
    }
    const piece = path.spec.pieces[path.piece[Math.min(path.piece.length - 1, Math.round(b.s / 0.25))]];
    if (!this.looped && piece.t === 'turn' && Math.abs(piece.angle) >= 300) {
      this.looped = true;
      if (path.spec.id === 'lazy') this.toast('Round the big loop! 🔄');
      else this.toast('Down the helix! 🌪️');
    }
    // ploughing through the splash lane throws up a rooster tail
    if (sec === 'lane' && st.v > 4) {
      this.v1.setFromMatrixPosition(b.mesh.matrix).addScaledVector(this.f.u, 0.15);
      this.splashes.spray(this.v1, this.f.t, st.v);
    }
    if (!going) {
      this.launch(b, st.v);
      this.phase = 'fly';
      this.phaseT = 0;
    }
  }

  private splashDown(b: Body) {
    this.phase = 'float';
    this.phaseT = 0;
    this.splashes.splash(b.p, b.fwd, 1.5);
    this.ctx.sfx.splash(2);
    const id = b.path.spec.id;
    const kmh = this.stats.top * 3.6;
    const rec = (this.records[id] ??= {});
    const fastest = !rec.bestS || this.stats.rideT < rec.bestS;
    const quickest = !rec.topKmh || kmh > rec.topKmh;
    if (fastest) rec.bestS = this.stats.rideT;
    if (quickest) rec.topKmh = kmh;
    try {
      localStorage.setItem(STORE, JSON.stringify(this.records));
    } catch {
      /* storage unavailable */
    }
    this.toast(fastest ? `New best ${fmtS(this.stats.rideT)} 🏆` : `Splashdown! 💦 ${Math.round(kmh)} km/h`);
    if (fastest || quickest) this.ctx.sfx.cheer(0.5);
    $('sl-best').textContent = fmtS(rec.bestS ?? this.stats.rideT);
    this.ctx.ui.countdown('SPLASH! 💦');
  }

  private updateGhosts(dt: number) {
    const holdAll = this.active && (this.phase === 'climb' || this.phase === 'pick');
    const mine = this.active && this.picked ? this.paths.indexOf(this.picked) : -1;
    const cam = this.ctx.camera.position;
    this.ghosts.forEach((g, k) => {
      if (g.state === 'wait') {
        g.mesh.visible = false;
        if (holdAll || k === mine) return;
        g.wait -= dt;
        if (g.wait > 0) return;
        g.state = 'ride';
        g.t = 0;
        g.spin = Math.random() * Math.PI * 2;
        g.mesh.visible = true;
      }
      if (g.state === 'ride') {
        g.t += dt;
        const run = g.run.samples;
        const x = g.t * 30;
        const i = Math.min(run.length - 2, Math.floor(x));
        const f = Math.min(1, x - i);
        const a = run[i];
        const c = run[i + 1];
        g.s = a.s + (c.s - a.s) * f;
        g.phi = a.phi + (c.phi - a.phi) * f;
        g.v = a.v + (c.v - a.v) * f;
        if (ABOUT[g.path.spec.id].pose === 'ring') g.spin += dt * 0.35;
        this.placeOnSlide(g.mesh, g.path, g.s, g.phi, ABOUT[g.path.spec.id].pose === 'ring' ? g.spin : 0);
        if (g.t >= g.run.duration) this.launch(g, g.run.exitSpeed);
        return;
      }
      if (g.state === 'fly') {
        if (this.fly(g, dt)) {
          const d = cam.distanceTo(this.v1.copy(g.p).add(ANCHOR));
          this.splashes.splash(g.p, g.fwd, d < 120 ? 1.1 : 0.5);
          if (d < 70) this.ctx.sfx.splash(Math.max(0.15, 1.6 * (1 - d / 70)));
        }
        return;
      }
      this.float(g, dt);
      if (g.t > 3.2) {
        g.state = 'wait';
        g.wait = 4 + Math.random() * 9;
        g.mesh.visible = false;
      }
    });
  }

  /** Each gate's light: green while its rider pushes off (and for you once the slide is clear), red otherwise. */
  private updateLamps(t: number) {
    const lamps = this.build.lamps;
    const k = 1 + this.night * 2.5;
    this.paths.forEach((path, i) => {
      const g = this.ghosts[i];
      const mineWaiting = this.active && this.picked === path && this.phase === 'ready';
      const mineGoing = this.active && this.picked === path && this.phase === 'ride' && this.phaseT < 1.5;
      const green = mineGoing || (!mineWaiting && g.state === 'ride' && g.t < 1.2) || (mineWaiting && this.phaseT >= READY_MIN && this.clear(i));
      const blink = mineWaiting && !green ? 0.75 + 0.25 * Math.sin(t * 6) : 1;
      lamps.setColorAt(i * 2, this.lampC.set(green ? '#3a1210' : '#ff3b30').multiplyScalar(green ? 1 : k * blink));
      lamps.setColorAt(i * 2 + 1, this.lampC.set(green ? '#39ff6a' : '#163120').multiplyScalar(green ? k : 1));
    });
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  }

  private updateHud(dt: number) {
    if (this.hud.hidden) return;
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.08;
    const v = this.phase === 'ride' ? this.st.v : this.phase === 'fly' && this.body ? this.body.vel.length() : 0;
    $('sl-speed').textContent = String(Math.round(v * 3.6));
    const gEl = $('sl-g');
    const gs = this.phase === 'ride' ? this.gSmooth : 1;
    gEl.textContent = gs.toFixed(1);
    gEl.parentElement!.classList.toggle('hot', gs > 2.5);
    gEl.parentElement!.classList.toggle('float', gs < 0.4);
    $('sl-time').textContent = fmtS(this.stats.rideT);
    const tuck = this.phase === 'ride' ? (this.input?.throttle ?? 0) : 0;
    const bar = $('sl-tuck');
    bar.style.left = tuck >= 0 ? '50%' : `${50 + tuck * 50}%`;
    bar.style.width = `${Math.abs(tuck) * 50}%`;
    bar.className = tuck < 0 ? 'brake' : tuck > 0 ? 'turbo' : '';
  }

  // ------------------------------------------------------------------ the camera

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const k = this.camReset ? 1 : 1 - Math.exp(-dt * 6);
    const wide = camera.aspect < 0.8 ? 14 : 0;
    let fov = 55;
    let near = 0.3;
    let under = false;
    camera.up.set(0, 1, 0);
    if (this.phase === 'climb') {
      // a crane shot circling the tower as the avatar climbs, looking at them through the frame
      const a = this.phaseT / CLIMB_T;
      const ang = Math.PI * 0.25 + a * Math.PI * 1.55;
      const r = 23 - a * 7;
      this.v1.set(TOWER.x + Math.cos(ang) * r, 0, TOWER.z + Math.sin(ang) * r);
      this.v1.y = Math.max(2.2, this.posV.y + 3 + a * 4);
      this.v2.copy(this.posV).setY(this.posV.y + 1.3);
      this.camPos.lerp(this.v1, k);
      this.camLook.lerp(this.v2, this.camReset ? 1 : 1 - Math.exp(-dt * 8));
      camera.position.copy(this.camPos).add(ANCHOR);
      camera.lookAt(this.v3.copy(this.camLook).add(ANCHOR));
    } else if (this.phase === 'pick') {
      // on the deck at eye height, looking out along the highlighted slide
      const gate = this.build.gates[this.choice];
      this.v1.set(TOWER.x - gate.out.x * 1.2, TOWER.deck + 1.65, TOWER.z - gate.out.z * 1.2);
      this.v2.set(gate.x, TOWER.deck - 1.5, gate.z).addScaledVector(gate.out, 7);
      this.camPos.lerp(this.v1, k);
      this.camLook.lerp(this.v2, this.camReset ? 1 : 1 - Math.exp(-dt * 5));
      camera.position.copy(this.camPos).add(ANCHOR);
      camera.lookAt(this.v3.copy(this.camLook).add(ANCHOR));
      fov = 62;
    } else if (this.body) {
      const b = this.body;
      const path = b.path;
      const pose = b.mesh === this.me.ring ? 'ring' : 'lie';
      const mode: CamMode = this.phase === 'ready' && this.camMode === 'drone' ? 'chase' : this.camMode;
      // from the rider's eye your own folded arms would fill the frame
      b.mesh.visible = mode !== 'pov';
      if (mode === 'pov') {
        // the rider's eye, looking down the flume past their feet; the horizon rolls with the swing
        this.v1.copy(EYE[pose]).applyMatrix4(b.mesh.matrix);
        this.bn.setFromMatrixColumn(b.mesh.matrix, 1);
        if (this.phase === 'ready' || this.phase === 'ride') {
          sampleSlide(path, Math.min(path.length, b.s + 7), this.f);
          this.v2.copy(this.f.p).addScaledVector(this.f.u, -path.spec.radius * 0.35).sub(this.v1).normalize();
        } else {
          this.v2.setFromMatrixColumn(b.mesh.matrix, 2).negate().setY(this.phase === 'fly' ? -0.5 : 0.05).normalize();
        }
        if (this.camReset) {
          this.camDir.copy(this.v2);
          this.camUp.copy(this.bn);
        }
        this.camDir.lerp(this.v2, 1 - Math.exp(-dt * 10)).normalize();
        this.camUp.lerp(this.bn, 1 - Math.exp(-dt * 8)).normalize();
        camera.position.copy(this.v1).add(ANCHOR);
        camera.up.copy(this.camUp);
        camera.lookAt(this.v3.copy(this.v1).add(this.camDir).add(ANCHOR));
        fov = 76;
        near = 0.06;
        under = this.v1.y < POOL.water;
      } else if (mode === 'chase') {
        // behind the rider along the flume (inside the tube in the tubes), or over the pool after
        this.v3.setFromMatrixPosition(b.mesh.matrix);
        if (this.phase === 'ready' || this.phase === 'ride') {
          const s = Math.max(0, b.s - 3.4);
          sampleSlide(path, s, this.f);
          const closed = sectionAt(path, s) === 'tube' || sectionAt(path, s) === 'clear';
          this.v1.copy(this.f.p).addScaledVector(this.f.u, closed ? 0.12 : path.spec.radius * 0.6 + 0.9);
          if (s === 0) this.v1.addScaledVector(this.f.t, -1.5).setY(this.v1.y + 0.6);
          this.v2.copy(this.v3).addScaledVector(this.f.u, 0.3);
          if (closed) this.bn.copy(this.f.u);
          else this.bn.set(0, 1, 0);
        } else {
          this.v1.copy(b.p).addScaledVector(b.fwd, -5).setY(POOL.water + 3.2);
          this.v2.copy(b.p).setY(POOL.water + 0.3);
          this.bn.set(0, 1, 0);
        }
        this.camPos.lerp(this.v1, this.camReset ? 1 : 1 - Math.exp(-dt * 9));
        this.camLook.lerp(this.v2, this.camReset ? 1 : 1 - Math.exp(-dt * 12));
        this.camUp.lerp(this.bn, this.camReset ? 1 : 1 - Math.exp(-dt * 5)).normalize();
        camera.position.copy(this.camPos).add(ANCHOR);
        camera.up.copy(this.camUp);
        camera.lookAt(this.v3.copy(this.camLook).add(ANCHOR));
        fov = 64;
        near = 0.08;
        under = this.camPos.y < POOL.water;
      } else {
        this.v3.setFromMatrixPosition(b.mesh.matrix);
        let best = DRONES[0];
        for (const p of DRONES) if (p.distanceToSquared(this.v3) < best.distanceToSquared(this.v3)) best = p;
        if (!this.camPos.equals(best)) this.camReset = true;
        this.camPos.copy(best);
        this.camLook.lerp(this.v3, this.camReset ? 1 : 1 - Math.exp(-dt * 8));
        camera.position.copy(this.camPos).add(ANCHOR);
        camera.lookAt(this.v2.copy(this.camLook).add(ANCHOR));
        fov = 46;
      }
    }
    this.camReset = false;
    if (camera.fov !== fov + wide || camera.near !== near) {
      camera.fov = fov + wide;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    if (under !== this.underwater) {
      this.underwater = under;
      this.underEl.style.opacity = under ? '1' : '0';
    }
  }

  // ------------------------------------------------------------------ for Game

  /** A ground point for the shadows and the grass (world). */
  get focus() {
    this.focusV.copy(this.riderLocal()).add(ANCHOR).setY(0);
    return this.focusV;
  }

  /** Where the visitor is (world), for the minimap. */
  get position() {
    return this.posV.copy(this.riderLocal()).add(ANCHOR);
  }

  get yaw() {
    const b = this.body;
    if (!b) return Math.PI / 2;
    this.v1.setFromMatrixColumn(b.mesh.matrix, 2);
    return Math.atan2(this.v1.x, this.v1.z);
  }

  get altitude() {
    return this.riderLocal().y;
  }

  /** The visitor's speed (m/s) while sliding, for the water rush (Game's coaster-audio voice). */
  get speed() {
    return this.active && this.phase === 'ride' ? this.st.v : 0;
  }

  /** Where the round is (climb, pick, ready, ride, fly, float, done; idle when not riding). */
  get stage(): Phase {
    return this.phase;
  }

  /** How far down the picked slide the visitor is, 0..1 (1 from the lip on). */
  get progress() {
    if (!this.picked || this.phase === 'pick' || this.phase === 'climb') return 0;
    return this.phase === 'ride' || this.phase === 'ready' ? this.st.s / this.picked.length : 1;
  }

  private riderLocal() {
    if (this.body && this.phase !== 'climb' && this.phase !== 'pick') return this.v3.setFromMatrixPosition(this.body.mesh.matrix);
    if (this.phase === 'climb') return this.v3.setFromMatrixPosition(this.me.stand.matrix);
    return this.v3.set(TOWER.x, this.phase === 'pick' ? TOWER.deck : 0, TOWER.z);
  }
}
