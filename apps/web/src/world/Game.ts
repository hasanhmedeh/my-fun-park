import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Sfx } from './audio';
import { Player } from './player';
import { Crowd } from './crowd/crowd';
import { GUEST_ANIMS_URL, GUESTS_URL, PeopleFactory, VISITOR_LOOK } from './crowd/people';
import { DOG_URLS, DogFactory } from './crowd/pets';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Ctx } from './context';
import { Environment } from './environment';
import { Input } from './input';
import { DISTRICTS, FALCON_STATION, FOOTPRINTS, LAYOUT, PLAZAS, setPlotTitle, ZONES, type ZoneId } from './layout';
import { NAME_COLORS, physicsWord } from './letters';
import { PALETTE } from './textures';
import { escapeHtml, UI } from './ui';
import { Zones } from './zones';
import { Wayfinding } from './wayfinding';
import { perks } from './perks';
import { Shop, VENDOR_LOOK } from './shop';
import { Ideas } from './ideas';
import { Gallery } from './gallery';
import { Wardrobe } from './souvenirs';
import { Minimap, setPlotPlace } from './minimap';
import { WorldMap } from './world-map';
import { Trackside } from './trackside';
import { TimeControl } from './time-control';
import { Post } from './post';
import { AdaptiveResolution, detectQuality, type Quality } from './quality';
import { GraphicsMenu } from './graphics-menu';
import { wind } from './wind';
import { Coaster } from './attractions/coaster';
import { Mountain } from './mountain';
import { FALCON_TRACK, nearTrack, STACK_TRACK, TRACK_DS } from './rides';
import { PHYS } from './attractions/track';
import { FALCON_PHYS } from './attractions/falcon-track';
import { Rocket } from './attractions/rocket';
import { Crates, CRATES_ROUND } from './attractions/crates';
import { Striker } from './attractions/striker';
import { Ducks, DUCKS_ROUND } from './attractions/ducks';
import { Arch, Booth, Carousel } from './attractions/landmarks';
import { IdeaKiosk } from './attractions/idea-kiosk';
import { Museum, STOPS } from './attractions/museum';
import { GiantWheel } from './attractions/giant-wheel';
import { Drone } from './attractions/drone';
import { SkyFlip } from './attractions/sky-flip';
import { Ship } from './attractions/ship';
import { Speedway } from './attractions/speedway';
import { Trail } from './attractions/trail';
import { boardListHtml, leaderboard, resetClock, resetIn, trailTime } from '../account/leaderboard';
import {
  api,
  ApiError,
  ATTRACTION_IDS,
  isAttraction,
  isGame,
  isPlot,
  NotEnoughTicketsError,
  ParkClosedError,
  PLOT_IDS,
  plotNumber,
  RideClosedError,
  type AttractionId,
  type CreationDetail,
  type PlotId,
} from '../account/api';
import { everyHours, formatWait, session } from '../account/session';
import { authDialog, type AuthMode } from '../account/auth-dialog';
import { AccountMenu } from '../account/account-menu';
import { results, type ResultsChoice, type RoundResult } from '../account/results';
import { leaveEarly } from '../account/leave-early';
import { cleanStats } from '../account/stats';
import { STATUSES } from '../account/ideas';
import { accountButtons, legalLinksHtml, packText, ticketsText, waitHtml } from './ticket-counter';
import { Valley } from '../workshop/valley';
import { Yard, YARD_LAYER } from '../workshop/yard';
import { Builder } from '../workshop/builder';

/** The clock slider / pause / local-time panel. Off for now: the park stays at 16:00. */
const TIME_CONTROLS = false;
/** How many guests walk the park, by graphics tier. */
const CROWD_SIZE = { high: 80, medium: 56, low: 32, lowest: 14 } as const;

type Mode = 'drive' | 'coaster' | 'rocket' | 'striker' | 'ducks' | 'wheel' | 'drone' | 'flip' | 'ship' | 'race' | 'trail' | 'shop' | 'ideas' | 'museum' | 'workshop';

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** What the "Press E" prompt offers at an attraction: its price, or why it can't be played right now. */
function zoneAction(id: AttractionId) {
  const z = ZONES[id];
  const price = `${session.cost(id)} 🎟️`;
  const closed = !session.parkOpen || session.maintenance(id) !== undefined;
  if (closed && session.isStaff) return `🎩 Staff test · ${price}`;
  if (!session.parkOpen) return '🚧 The park is closed';
  if (closed) return '🚧 Under maintenance';
  return `${session.user ? z.action : 'Sign up for tickets'} · ${price}`;
}

/** Something with a round to report (see account/stats.ts). */
interface Measured {
  roundStats(): Record<string, number>;
}

export class Game {
  private ctx!: Ctx;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(42, 1, 0.5, 2400);
  private world = new CANNON.World();
  private timer = new THREE.Timer();
  private debugCam: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;
  private input!: Input;
  private ui!: UI;
  private sfx = new Sfx();
  private env!: Environment;
  private player!: Player;
  private crowd: Crowd | null = null;
  private zones!: Zones;
  private minimap!: Minimap;
  private worldMap!: WorldMap;
  private stack!: Coaster;
  private falcon!: Coaster;
  /** The coaster currently being ridden (valid while mode === 'coaster'). */
  private ride!: Coaster;
  private mountain!: Mountain;
  private rocket!: Rocket;
  private crates!: Crates;
  private striker!: Striker;
  private ducks!: Ducks;
  /** The Duck Shoot's HUD badge, as last drawn. */
  private ducksBadge = '';
  private wheel!: GiantWheel;
  private booth!: Booth;
  private ideaKiosk!: IdeaKiosk;
  private museum!: Museum;
  private drone!: Drone;
  private flip!: SkyFlip;
  private ship!: Ship;
  private speedway!: Speedway;
  private trail!: Trail;
  /** Creators' Valley: its plots, and the coasters members built running on them. */
  private valley!: Valley;
  /** A round on one of Creators' Valley's coasters: its plot, and the coaster (which creation, its name) it boarded. */
  private plotRound: { plot: PlotId; creation: string; name: string; coaster: Coaster } | null = null;
  /** The train ran out of speed this round: how far it got (metres), for the results. */
  private stalledAt: number | null = null;
  /** The Coaster Workshop's Builder's Yard (drawn on its own layer) and its sheet. */
  private yard!: Yard;
  private workshop: Builder | null = null;
  /** A free test ride from the yard is on (no round, no tickets), and where its train stalled. */
  private testRide = false;
  private testStall: number | null = null;
  /** The office's "test-ride in the game" link (?coaster=<id>) has been followed. */
  private inspected = false;
  private updatables: { update(dt: number, t: number): void }[] = [];
  private mode: Mode = 'drive';
  private camTarget = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private zoom = 1;
  /** Drive-camera orbit, set by dragging the view: yaw 0 looks north, pitch is the angle above the visitor. */
  private camYaw = 0;
  private camPitch = 0.2;
  private panelZone: ZoneId | null = null;
  /** The crates card auto-opens in its ring; once closed it stays closed until you leave. */
  private cratesDismissed = false;
  /** The same for the Rally Trail's card (today's leaderboard). */
  private trailDismissed = false;
  /** The attraction whose round is being paid for (the board request is in flight). */
  private boarding: AttractionId | null = null;
  /** The round being played: the server's id for it, the attraction, and what it cost. */
  private round: { id: string; ride: AttractionId; tickets: number } | null = null;
  /** The attraction is on its way out (fading); `leaveCompleted` says whether its round ran to the end. */
  private leaving = false;
  /** The round's attraction (or the park) closed while it was played: it ends with the sign and a refund, not the results. */
  private lockedOut = false;
  /** In the fair (entered from the intro), rather than at the intro card. */
  private inFair = false;
  private welcomed = false;
  /** The park went under maintenance (and this visitor isn't staff): main.ts brings the intro back. */
  onShutOut: (() => void) | null = null;
  private leaveCompleted = false;
  /** The Ticket Booth's counter: a purchase in flight, and how the last one went. */
  /** The Ticket Booth's counter: Rosa and her shop (set up once the people are loaded). */
  private shop: Shop | null = null;
  /** The Idea Box on the entrance plaza: suggestions for the park, and staff's answers. */
  private ideas: Ideas | null = null;
  /** Staff answered an idea while the visitor was busy (on a ride, a card open): the news waits for them. */
  private ideaNews = false;
  /** The Career Museum's guided tour: the sheet beside each frame. */
  private gallery: Gallery | null = null;
  /** The museum's frame whose viewing spot the visitor is standing on (-1: none). */
  private museumStop = -1;
  /** What the visitor wears from the shop. */
  private wardrobe: Wardrobe | null = null;
  /** The crates round's HUD badge, as last drawn. */
  private cratesBadge = '';
  /** Whose account the open cards were drawn for, so they redraw when someone signs in or out. */
  private sessionUser: string | null = null;
  private running = false;
  private mobile = matchMedia('(pointer: coarse)').matches;
  private fadeEl!: HTMLDivElement;
  private time = { t: 0 };
  private quality!: Quality;
  private post!: Post;
  private adaptive!: AdaptiveResolution;
  private focus = new THREE.Vector3();
  private timeControl: TimeControl | null = null;
  /** The "park is closed" strip; once dismissed it stays away until the park opens again. */
  private parkBanner = document.getElementById('park-banner')!;
  private parkBannerDismissed = false;

  constructor(private container: HTMLElement) {}

  /** Builds the whole fair in small steps so the progress bar can update. */
  async build(onProgress: (p: number) => void) {
    // the people (visitor and guests) and the dogs download while the world is being built
    const loader = new GLTFLoader();
    const peopleModels = Promise.all([loader.loadAsync(GUESTS_URL), loader.loadAsync(GUEST_ANIMS_URL)]);
    const dogModels = Promise.all([loader.loadAsync(DOG_URLS.shiba), loader.loadAsync(DOG_URLS.husky)]).catch(() => null);
    const steps: [number, () => void | Promise<void>][] = [];
    const step = (w: number, fn: () => void | Promise<void>) => steps.push([w, fn]);

    step(1, () => this.setupRenderer());
    step(1, () => this.setupPhysics());
    step(3, () => {
      this.env = new Environment(this.ctx, this.quality);
    });
    step(1, () => {
      // Bruno-style physical letters in front of the spawn point.
      physicsWord(this.ctx, 'FUNFAIR', new THREE.Vector3(LAYOUT.letters.x, 0, LAYOUT.letters.z), 2.4, NAME_COLORS);
      this.updatables.push(new Arch(this.ctx));
    });
    step(1, () => {
      this.updatables.push(new Carousel(this.ctx));
      this.booth = new Booth(this.ctx);
      this.updatables.push(this.booth);
      this.ideaKiosk = new IdeaKiosk(this.ctx);
      this.updatables.push(this.ideaKiosk);
    });
    step(1, () => {
      this.museum = new Museum(this.ctx);
      this.updatables.push(this.museum);
    });
    step(3, () => {
      this.stack = new Coaster(this.ctx, {
        id: 'stack',
        name: 'Thunder Loop',
        track: STACK_TRACK,
        phys: PHYS,
        station: { title: 'THUNDER LOOP', sub: 'Drive it yourself · launch · loop · roll', side: -1 },
        colors: { rail: PALETTE.candy, spine: PALETTE.mustard, cars: [PALETTE.mustard, PALETTE.candy, PALETTE.teal] },
        cars: 3,
        // (from the head of the station, wherever the layout puts it)
        trackside: [
          [-24, 3, 44], // loop
          [-40, 4, 12], // banked turn + camelback
          [-40, 6, -34], // high turn + roll
          [12, 9, -28], // helix
          [10, 4, 18], // station
        ].map(([x, y, z]) => new THREE.Vector3(LAYOUT.coaster.x + x, y, LAYOUT.coaster.z + z)),
        intro: (touch) =>
          `<p class="eyebrow">Thunder Loop · You're the driver</p><h2>Hold on tight!</h2><p>${
            touch
              ? 'Push the joystick <strong>up</strong> for power, <strong>down</strong> to brake. Tap <kbd>E</kbd> to switch camera.'
              : 'Hold <kbd>W</kbd> for power, <kbd>S</kbd> to brake, <kbd>Shift</kbd> for turbo, <kbd>C</kbd> to switch camera.'
          } The launch fires automatically — brake too hard before the loop and you'll roll back!</p>`,
      });
      this.ride = this.stack;
      this.updatables.push(this.stack);
    });
    step(4, () => {
      this.mountain = new Mountain(this.ctx);
      const ground = (x: number, z: number) => this.mountain.sample(x, z);
      // the attractions and plazas a support column must never land on (but its own station)
      const keep: [number, number, number][] = [...FOOTPRINTS.filter((f) => f !== FALCON_STATION), ...PLAZAS.map(([x, z, r]): [number, number, number] => [x, z, r + 1])];
      // the giant hill's crest stands on its own lattice tower
      const crest = FALCON_TRACK.pos[Trackside.hillCrest()];
      keep.push([crest.x, crest.z, 14]);
      const keepOut = (x: number, z: number) => keep.some(([kx, kz, r]) => Math.hypot(x - kx, z - kz) < r) || nearTrack(x, z, 3.5, Infinity, 'stack');
      const f = FALCON_TRACK;
      const at = (zone: string, offset: [number, number, number]) => {
        const p = f.pos[Math.max(0, f.zone.indexOf(zone as never))];
        const x = p.x + offset[0];
        const z = p.z + offset[2];
        return new THREE.Vector3(x, Math.max(p.y * 0.4, ground(x, z)) + offset[1], z);
      };
      // a camera beside the track at arc length s (metres from the station)
      const atS = (s: number, offset: [number, number, number], y?: number) => {
        const p = f.pos[Math.round(s / TRACK_DS) % f.pos.length];
        const x = p.x + offset[0];
        const z = p.z + offset[2];
        return new THREE.Vector3(x, y ?? Math.max(p.y * 0.4, ground(x, z)) + offset[1], z);
      };
      this.falcon = new Coaster(this.ctx, {
        id: 'falcon',
        name: 'Sky Falcon',
        track: FALCON_TRACK,
        phys: FALCON_PHYS,
        // platform on the park side, so the queue reaches it without crossing the track
        station: { title: 'SKY FALCON', sub: '4.25 km · 158 m drop at 90° · 250 km/h', side: -1 },
        colors: { rail: PALETTE.teal, spine: '#e6c08a', cars: ['#e6c08a', PALETTE.teal, '#e6c08a', PALETTE.teal] },
        cars: 4,
        leadRows: 1, // 2 + 4 + 4 + 4 = 14 riders, like the real Exa trains
        tunnel: 'rock',
        tunnelClip: this.mountain.tunnelPlanes,
        trackside: [
          new THREE.Vector3(LAYOUT.falcon.x - 16, 6, LAYOUT.falcon.z + 12), // station
          atS(110, [0, 8, 45]), // the LSM lift hill
          atS(250, [-45, 6, 0]), // twisted drop + airtime hills
          at('launch', [-38, 8, -60]), // the launch up the cliff
          at('brake', [-60, 30, 40]), // the plateau rim
          (() => {
            // hovering over the run-out (always open air: the track sits in a cutting), looking back
            // up the cliff as the train comes off the drop at full speed
            const i = f.zone.lastIndexOf('boost') + 320;
            const p = f.pos[i];
            return new THREE.Vector3(p.x, Math.max(p.y + 14, ground(p.x, p.z) + 6), p.z);
          })(),
          atS(2120, [95, 0, 0], 75), // beside the 163 m hill and its lattice tower
          atS(2560, [-45, 22, 35]), // the overbanked turn above the park's corner
          atS(3900, [0, 6, -32]), // speed turns along the park's edge
        ],
        ground,
        keepOut,
        beats: {
          lift: ['LSM lift hill · 39 km/h ⚙️', 'The clifftop… 190 m up ⛰️'],
          launch: 'LAUNCH → 160 km/h up the cliff 🚀',
          brake: ['The edge. Look down. 😱', 'Final brake run'],
          tunnel: 'Into the tunnel… 🕳️',
          boost: 'LSM LAUNCH → 250 km/h 🦅',
          trim: ['The 163 m hill — trims bite 😮‍💨', 'Down into the park! 🎢'],
          station: 'Welcome back to the fair!',
        },
        intro: (touch) =>
          `<p class="eyebrow">Sky Falcon · tribute to Falcons Flight, Six Flags Qiddiya City</p><h2>The world's tallest, fastest, longest</h2><p>An LSM lift and a twisted drop, airtime hills and an overbanked turn, then a <strong>160 km/h launch</strong> up the cliff. Crawl to the edge… drop <strong>158 m at 90°</strong> into a tunnel, launch out of it to <strong>250 km/h</strong>, crest the <strong>163 m hill</strong> beside the park and weave back to the station: 4.25 km, no inversions.</p><p>${
            touch ? 'Joystick <strong>up</strong> = power, <strong>down</strong> = brake, <kbd>E</kbd> = camera.' : '<kbd>W</kbd> power · <kbd>S</kbd> brake · <kbd>Shift</kbd> turbo · <kbd>C</kbd> camera.'
          } Or just hold on — the lift and launches do the work.</p>`,
      });
      this.updatables.push(this.falcon);
      new Trackside(this.ctx, ground);
    });
    step(2, () => {
      this.wheel = new GiantWheel(this.ctx, (x, z) => this.mountain.sample(x, z));
      this.updatables.push(this.wheel);
    });
    step(1, () => {
      this.drone = new Drone(this.ctx, (x, z) => this.mountain.sample(x, z));
      this.updatables.push(this.drone);
    });
    step(1, () => {
      this.flip = new SkyFlip(this.ctx);
      this.updatables.push(this.flip);
    });
    step(1, () => {
      this.ship = new Ship(this.ctx);
      this.updatables.push(this.ship);
    });
    step(2, () => {
      this.speedway = new Speedway(this.ctx);
      this.updatables.push(this.speedway);
    });
    step(2, () => {
      this.trail = new Trail(this.ctx);
      this.updatables.push(this.trail);
    });
    step(1, () => {
      // Creators' Valley, out of the west gate (its coasters arrive with the park's state)
      this.valley = new Valley(this.ctx);
      this.updatables.push(this.valley);
      // the Builder's Yard: its own layer, with the park's sky and far hills
      this.yard = new Yard(this.ctx);
      this.updatables.push(this.yard);
      this.env.shareLayer(YARD_LAYER);
    });
    step(2, () => {
      this.rocket = new Rocket(this.ctx, this.env);
      this.updatables.push(this.rocket);
    });
    step(1, () => {
      this.crates = new Crates(this.ctx);
      this.striker = new Striker(this.ctx);
      this.ducks = new Ducks(this.ctx);
      this.updatables.push(this.crates, this.striker, this.ducks);
    });
    step(1, () => {
      // the districts' signs and the fingerposts (once everything they keep clear of is standing)
      new Wayfinding(this.ctx);
    });
    step(1, async () => {
      this.zones = new Zones(this.ctx);
      const [guests, anims] = await peopleModels;
      const people = new PeopleFactory(guests, anims);
      this.player = new Player(this.ctx, people.create(VISITOR_LOOK));
      // Rosa behind the booth's counter, and what the visitor wears from her shop
      this.booth.setVendor(people.create(VENDOR_LOOK));
      this.wardrobe = new Wardrobe(this.player.rig, this.scene);
      this.wire();
      // the crowd: queues, riders, families, kids and dogs (fewer on modest hardware)
      const dogs = await dogModels;
      const crowd = new Crowd(this.ctx, people, dogs && new DogFactory({ shiba: dogs[0], husky: dogs[1] }), [this.stack, this.falcon], this.striker, {
        count: CROWD_SIZE[this.quality.tier],
        shadows: this.quality.shadows && this.quality.tier !== 'low',
      });
      crowd.setPlayer(this.player);
      this.player.onWave = () => crowd.waveBack(this.player.position);
      this.player.onKick = () => crowd.shove(this.player.position, this.player.forward);
      this.updatables.push(crowd); // after the coasters, so riders sit where their seats are now
      this.crowd = crowd;
    });
    step(2, () => {
      // warm up: upload textures/compile shaders before the user enters
      this.post = new Post(this.renderer, this.scene, this.camera, this.quality);
      this.resize();
      this.updateDriveCamera(1, true);
      this.renderer.compile(this.scene, this.camera);
      this.post.render(0);
    });

    const total = steps.reduce((a, [w]) => a + w, 0);
    let done = 0;
    for (const [w, fn] of steps) {
      await fn();
      done += w;
      onProgress(done / total);
      await nextFrame();
    }
    this.timer.connect(document);
    this.timer.reset();
    this.setupDebug();
    this.running = true;
    this.renderer.setAnimationLoop(() => this.tick());
  }

  private setupRenderer() {
    // AA, tone mapping and colour output all happen in the post pipeline (see post.ts).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, stencil: false, powerPreference: 'high-performance' });
    this.quality = detectQuality(this.renderer, this.mobile);
    this.adaptive = new AdaptiveResolution(this.quality.minScale);
    this.renderer.setPixelRatio(this.quality.dpr);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.container.appendChild(this.renderer.domElement);
    window.addEventListener('resize', () => this.resize());
    this.container.addEventListener(
      'wheel',
      (e) => {
        if (this.mode === 'drone') return this.drone.zoomBy(e.deltaY);
        if (this.mode !== 'drive') return;
        this.zoom = THREE.MathUtils.clamp(this.zoom + e.deltaY * 0.001, 0.55, 1.7);
      },
      { passive: true },
    );
    // drag the view (mouse or finger) to look around the visitor
    const canvas = this.renderer.domElement;
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if ((this.mode !== 'drive' && this.mode !== 'drone') || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = 4 / Math.max(1, canvas.clientHeight);
      if (this.mode === 'drone') this.drone.look((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
      else {
        this.camYaw -= (e.clientX - drag.x) * k;
        this.camPitch = THREE.MathUtils.clamp(this.camPitch + (e.clientY - drag.y) * k, 0.04, 1.1);
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
    });
    const endDrag = (e: PointerEvent) => {
      if (drag && e.pointerId === drag.id) drag = null;
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    this.resize();
  }

  private setupPhysics() {
    const w = this.world;
    w.gravity.set(0, -20, 0);
    w.broadphase = new CANNON.SAPBroadphase(w);
    w.allowSleep = true;
    (w.solver as CANNON.GSSolver).iterations = 8;
    const ground = new CANNON.Material('ground');
    const player = new CANNON.Material('player');
    const prop = new CANNON.Material('prop');
    w.addContactMaterial(new CANNON.ContactMaterial(ground, player, { friction: 0, restitution: 0 }));
    w.addContactMaterial(new CANNON.ContactMaterial(ground, prop, { friction: 0.45, restitution: 0.15 }));
    w.addContactMaterial(new CANNON.ContactMaterial(player, prop, { friction: 0.05, restitution: 0.25 }));
    w.addContactMaterial(new CANNON.ContactMaterial(prop, prop, { friction: 0.4, restitution: 0.1 }));

    this.ui = new UI(this.mobile);
    this.fadeEl = document.createElement('div');
    this.fadeEl.className = 'fade';
    document.body.appendChild(this.fadeEl);

    this.ctx = {
      scene: this.scene,
      world: w,
      renderer: this.renderer,
      camera: this.camera,
      sfx: this.sfx,
      ui: this.ui,
      mobile: this.mobile,
      mats: { ground, player, prop },
      quality: this.quality,
      dynamics: [],
      time: this.time,
    };
  }

  private wire() {
    this.input = new Input({
      stick: document.getElementById('stick')!,
      knob: document.getElementById('stick-knob')!,
      action: document.getElementById('touch-action')!,
      lift: document.getElementById('touch-lift')!,
    });
    this.input.on('action', () => this.onAction());
    this.input.on('escape', () => this.onEscape());
    this.input.on('info', () => this.ui.toggleInfo());
    this.input.on('reset', () => {
      if (this.mode === 'drive') this.teleport('entrance');
      else if (this.mode === 'race') this.speedway.rescue();
      else if (this.mode === 'trail') this.trail.rescue();
    });
    this.input.on('restart', () => this.mode === 'trail' && this.trail.restart());
    this.input.on('honk', () => {
      if (this.mode === 'drive') this.player.wave();
      else if (this.mode === 'drone') this.drone.flyHome();
    });
    // Space rolls on foot, climbs in the drone and drifts a kart or the buggy; on rides and the striker it keeps working as the action key
    this.input.on('roll', () => {
      if (this.mode === 'drive') this.player.roll();
      else if (this.mode !== 'drone' && this.mode !== 'race' && this.mode !== 'trail') this.onAction();
    });
    this.input.on('kick', () => this.mode === 'drive' && this.player.kick());
    this.input.on('camera', () => {
      if (this.mode === 'coaster') this.ride.cycleCamera();
      else if (this.mode === 'wheel') this.wheel.cycleCamera();
      else if (this.mode === 'drone') this.drone.cycleCamera();
      else if (this.mode === 'flip') this.flip.cycleCamera();
      else if (this.mode === 'ship') this.ship.cycleCamera();
      else if (this.mode === 'race') this.speedway.cycleCamera();
      else if (this.mode === 'trail') this.trail.cycleCamera();
    });
    this.wheel.input = this.input;
    this.flip.input = this.input;
    this.ship.input = this.input;
    this.speedway.input = this.input;
    this.trail.input = this.input;
    // the trail HUD's ↺ button: another go from the grid (the focus goes back to the game)
    document.getElementById('tr-restart')!.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement).blur();
      if (this.mode === 'trail') this.trail.restart();
    });
    this.stack.input = this.input;
    this.falcon.input = this.input;
    this.drone.input = this.input;
    this.ducks.input = this.input;
    this.ui.onPromptClick = () => this.onAction();
    this.ui.onRideExit = () => this.onEscape();
    this.ui.onPanelClose = () => {
      if (this.zones.active === 'crates') this.cratesDismissed = true;
      if (this.zones.active === 'trail') this.trailDismissed = true;
      this.panelZone = null;
    };
    // the cards' buttons: sign up / log in (from an attraction's gate, boarding it after), pay for a
    // round (or retry), buy tickets, head to the booth, stop the crates round
    this.ui.panelElement.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-auth], [data-board], [data-goto], [data-stop]');
      if (!b) return;
      const ride = isAttraction(b.dataset.ride) ? b.dataset.ride : null;
      if (b.dataset.auth) void this.signIn(b.dataset.auth as AuthMode, ride);
      else if (b.dataset.goto === 'booth') this.goToBooth();
      else if (b.dataset.goto === 'ideas') this.goToIdeas();
      else if (b.hasAttribute('data-stop')) this.askToLeave();
      else if (ride) this.board(ride);
    });
    // closing the tab (or leaving the page) mid-round: the browser asks first, as the tickets aren't given back
    addEventListener('beforeunload', (e) => {
      if (!this.round || this.lockedOut) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // and once the page really goes, the round is closed as left early
    addEventListener('pagehide', () => {
      const round = this.round;
      if (!round || this.lockedOut) return;
      this.round = null;
      // a trail run already over the line ran to its end (its time still counts)
      const done = round.ride === 'trail' && this.trail.crossedLine;
      session.finishOnExit(round.id, done, this.measuredStats(round.ride));
    });
    // the sign-up form, the results screen and "leave early?" have the keyboard while they're open
    for (const dialog of [authDialog, results, leaveEarly]) {
      let pausedBefore = false;
      dialog.onToggle((open) => {
        if (open) pausedBefore = this.input.paused;
        this.input.paused = open || pausedBefore;
      });
    }
    new AccountMenu((title, text) => this.notice(title, text));
    // the countdowns to the next pack of tickets tick while their card is open
    setInterval(() => this.tickCountdowns(), 1000);
    // the booth's shop, and the treats' perks at the top of the screen
    perks.mount(document.getElementById('perks')!);
    this.shop = new Shop({
      root: document.getElementById('shop')!,
      booth: this.booth,
      player: this.player,
      sfx: this.sfx,
      mobile: this.mobile,
      onAuth: (mode) => void this.signIn(mode, null),
      onLeave: () => this.leaveShop(),
    });
    this.ideas = new Ideas({
      root: document.getElementById('ideas')!,
      kiosk: this.ideaKiosk,
      sfx: this.sfx,
      onAuth: (mode) => void this.signIn(mode, null),
      onLeave: () => this.leaveIdeas(),
    });
    this.workshop = new Builder({
      root: document.getElementById('workshop')!,
      yard: this.yard,
      sfx: this.sfx,
      mobile: this.mobile,
      onLeave: () => this.leaveWorkshop(),
      onTestRide: () => this.testRideYard(),
      onAuth: (mode) => void this.signIn(mode, null),
    });
    this.gallery = new Gallery({
      root: document.getElementById('museum')!,
      sfx: this.sfx,
      onGo: () => this.sfx.whoosh(),
      onLeave: () => this.leaveMuseum(),
    });
    // staff answered one of the member's ideas: a card says so, once they're free to read it
    let unread = session.suggestions?.unread ?? 0;
    session.onSuggestions(() => {
      const now = session.suggestions?.unread ?? 0;
      if (now > unread && this.mode !== 'ideas') this.ideaNews = true;
      if (!now) this.ideaNews = false;
      unread = now;
    });
    // what the member wears follows their souvenirs (bought, put on, taken off, or another account)
    const dress = () => this.wardrobe?.set(session.wearing);
    session.onChange(dress);
    dress();
    this.sessionUser = session.user?.id ?? null;
    session.onChange(() => this.onSessionChange());
    // the gates: a closed park gets its banner, an attraction under maintenance its red ring, roadworks and map badges
    session.onPark(() => this.onParkChange());
    this.parkBanner.querySelector('.park-banner-close')!.addEventListener('click', () => {
      this.parkBannerDismissed = true;
      this.parkBanner.hidden = true;
    });
    this.minimap = new Minimap(document.getElementById('minimap')!);
    if (TIME_CONTROLS) this.timeControl = new TimeControl(this.env);
    else document.getElementById('clock')?.remove();
    this.worldMap = new WorldMap(document.getElementById('world-map')!);
    this.worldMap.canOpen = () => this.inFair && this.mode === 'drive' && !authDialog.isOpen && !results.isOpen;
    this.worldMap.onToggle = (open) => {
      this.input.paused = open;
      if (this.mode === 'drive') this.player.enabled = !open;
    };
    this.worldMap.onTravel = (id) => this.teleport(id);
    this.minimap.onOpen = () => this.worldMap.open();
    // Creators' Valley's coasters come and go with the park's state: released, replaced, taken out
    for (const id of PLOT_IDS) this.zones.setZone(id, false);
    this.valley.onChange = (plot) => this.onPlotChange(plot);
    session.onCreations(() => this.valley.sync(session.creations));
    this.valley.sync(session.creations);
    new GraphicsMenu(this.quality);

    this.stack.onFinish = () => this.endRide();
    this.falcon.onFinish = () => this.endRide();
    this.rocket.onFinish = () => this.endRide();
    this.wheel.onFinish = () => this.endRide();
    this.striker.onFinish = () => this.endRide();
    this.ducks.onFinish = () => this.endRide();
    // the first shot puts the Duck Shoot's card (how to play) away, out of the line of fire
    this.ducks.onShot = () => {
      if (this.ui.panelOpenKey === 'ducks-play') this.ui.hidePanel();
    };
    this.drone.onFinish = () => this.endRide();
    this.flip.onFinish = () => this.endRide();
    this.ship.onFinish = () => this.endRide();
    this.speedway.onFinish = () => this.endRide();
    this.trail.onFinish = () => this.endRide();
    // each attraction ends on its own after one round: back to walking, with the results
    for (const a of [this.stack, this.falcon, this.rocket, this.wheel, this.flip, this.ship, this.speedway, this.trail, this.striker, this.crates, this.ducks]) a.onComplete = () => this.leave(true);
    // the Rally Trail's leaderboard: on its boards and its HUD, and on its card while that's open
    leaderboard.onChange((board) => {
      this.trail.setBoard(board);
      if (this.mode === 'drive' && this.panelZone === 'trail' && this.ui.panelOpenKey.startsWith('trail-board')) this.showZonePanel('trail');
    });
    void leaderboard.load();
    this.drone.onLanded = () => this.leave(true);
    // (the round's badge with the clock and the score is drawn in updateZones)
    this.crates.onScore = (n, total) => {
      if (this.panelZone === 'crates') this.ui.panel(`crates-${n}`, this.crates.panelHtml(this.cratesExtraHtml()), { accent: PALETTE.teal });
      if (n === total) this.sfx.ding();
      else this.sfx.pop();
    };

    const sound = document.getElementById('sound-toggle')!;
    const syncSound = () => {
      sound.textContent = this.sfx.muted ? '🔇' : '🔊';
      sound.setAttribute('aria-pressed', String(!this.sfx.muted));
      sound.setAttribute('aria-label', this.sfx.muted ? 'Unmute sound' : 'Mute sound');
    };
    sound.addEventListener('click', () => {
      this.sfx.setMuted(!this.sfx.muted);
      syncSound();
    });
    syncSound();
    if (this.mobile) document.getElementById('touch')!.hidden = false;
  }

  /** Called when the visitor presses "Enter the fair". */
  enter() {
    this.sfx.unlock();
    this.inFair = true;
    session.setInFair(true);
    this.ui.hud.hidden = false;
    if (this.mode === 'drive') this.player.enabled = true;
    session.watchPark();
    this.onParkChange();
    // the office's "test-ride in the game" link: that coaster, in the Builder's Yard
    const inspect = new URLSearchParams(location.search).get('coaster');
    if (inspect && !this.inspected) {
      this.inspected = true;
      void this.openInspect(inspect);
    }
    // back in after the park's maintenance: no second welcome
    if (this.welcomed) return;
    this.welcomed = true;
    // the guide opens by itself on a first visit; after that it's behind the ℹ️ (rendered fresh each time: prices, maintenance)
    this.ui.setGuide('welcome', 'the fair', () => this.guideHtml(), { accent: PALETTE.candy });
  }

  /** The park's guide: how it works, every ride and game with its price, and the controls. */
  private guideHtml() {
    const user = session.user;
    const cost = (id: AttractionId) =>
      session.maintenance(id) === undefined ? `<span class="cost">${session.cost(id)} 🎟️</span>` : '<span class="cost cost-closed">🚧 Under maintenance</span>';
    // one line per place, listed district by district (the order and the districts are the map's)
    const line: Partial<Record<ZoneId, string>> = {
      booth: "🎟️ <strong>Ticket Booth</strong> — Rosa's counter: your free tickets, treats with perks, and souvenirs to wear",
      ideas: "💡 <strong>Idea Box</strong> — on the entrance plaza: tell us what you'd love to see in the fair, and follow what becomes of it",
      crates: `🥫 <strong>Crate Smash</strong> — ${CRATES_ROUND} seconds to knock down as many crates as you can ${cost('crates')}`,
      striker: `🔔 <strong>High Striker</strong> — three swings to ring the bell ${cost('striker')}`,
      ducks: `🦆 <strong>Duck Shoot</strong> — ${DUCKS_ROUND} seconds with a cork gun to knock down the tin ducks (and the golden one) ${cost('ducks')}`,
      falcon: `🦅 <strong>Sky Falcon</strong> — a 4.25 km cliff coaster: 158 m drop at 90°, 250 km/h ${cost('falcon')}`,
      museum: "🏛️ <strong>Career Museum</strong> — at the end of the East Avenue: Hasan Hmedeh's work from 2019 to today, one framed picture at a time. Free, no ticket",
      rocket: `🚀 <strong>Rocket Ride</strong> — fire six stages all the way to orbit ${cost('rocket')}`,
      ship: `🛸 <strong>Nebula 360</strong> — a pendulum ship that loops right round and hangs you upside down ${cost('ship')}`,
      drone: `🚁 <strong>Drone Flights</strong> — rent a camera drone and fly over the whole park ${cost('drone')}`,
      ferris: `🎡 <strong>Giant Wheel</strong> — out of the north gate: ride the tallest wheel on Earth, 250 m up ${cost('ferris')}`,
      coaster: `🎢 <strong>Thunder Loop</strong> — drive the coaster yourself: launch, loop and roll ${cost('coaster')}`,
      flip: `🌀 <strong>Sky Flip</strong> — swing 125 m up, right over the top, flipping head over heels ${cost('flip')}`,
      speedway: `🏎️ <strong>Turbo Speedway</strong> — race three rivals round a kart circuit full of obstacles ${cost('speedway')}`,
      trail: `🚙 <strong>Rally Trail</strong> — a buggy time trial with jumps, mud and crates: beat today's fastest on the leaderboard ${cost('trail')}`,
      workshop:
        "🛠️ <strong>Coaster Workshop</strong> — out of the west gate: build your own coaster from parts, ride it for free, and send it to staff. Released ones open here, and you earn tickets each time someone rides them",
    };
    for (const r of this.valley.coasters)
      line[r.plot] = `🎢 <strong>${escapeHtml(r.creation.name)}</strong> — a coaster by @${escapeHtml(r.creation.creator)}, built in the Coaster Workshop ${cost(r.plot)}`;
    const districts = Object.values(DISTRICTS)
      .map((d) => {
        const items = d.zones.flatMap((z) => (line[z] ? [`<li>${line[z]}</li>`] : []));
        return items.length ? `<h3><span class="guide-district" style="--district: ${d.color}">${d.icon} ${escapeHtml(d.name)}</span></h3><ul>${items.join('')}</ul>` : '';
      })
      .join('');
    return `<p class="eyebrow">${user ? `Welcome back, ${escapeHtml(user.username)}` : 'Welcome to the fair'}</p><h2>Step right up! 🎪</h2><p>Walk around the park and try everything. Every ride and game takes tickets (prices below). Each payment buys one round, then you're back on your feet.</p><p class="booth-account">🎟️ Tickets are free: pick up <strong>${packText()}</strong>${
      user ? '' : ' with a free account'
    }. Leftover tickets carry over.</p><p>The park is laid out like a wheel: the carousel on the Hub in the middle, four avenues out from it, and the Promenade looping round past every district. Signposts point the way, and the ${
      this.mobile ? 'minimap opens' : '<kbd>M</kbd> key opens'
    } the park map, where you can fast travel.</p>${districts}${
      user ? '<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-goto="booth">Take me to the Ticket Booth 🎟️</button></p>' : accountButtons()
    }<p>${this.mobile ? 'Use the joystick to walk (push it all the way to run) and the <kbd>E</kbd> button to play.' : 'Walk with <kbd>WASD</kbd> or arrows, hold <kbd>Shift</kbd> to run, <kbd>Space</kbd> to roll, <kbd>F</kbd> to kick, <kbd>H</kbd> to wave and <kbd>E</kbd> to play. Try kicking the big letters over!'}</p><p class="sub">Open this again any time with the ℹ️ button (top right) or <kbd>I</kbd>.</p>`;
  }

  private onAction() {
    if (!this.running || this.ui.hud.hidden) return;
    if (this.mode === 'rocket') return this.rocket.action();
    if (this.mode === 'striker') return this.striker.action();
    if (this.mode === 'ducks') return this.ducks.shoot();
    if (this.mode === 'coaster') return this.ride.cycleCamera();
    if (this.mode === 'wheel') return this.wheel.cycleCamera();
    if (this.mode === 'drone') return this.drone.cycleCamera();
    if (this.mode === 'flip') return this.flip.cycleCamera();
    if (this.mode === 'ship') return this.ship.cycleCamera();
    if (this.mode === 'race') return this.speedway.cycleCamera();
    if (this.mode === 'trail') return this.trail.cycleCamera();
    if (this.mode === 'museum') return this.gallery?.step(1);
    if (this.mode !== 'drive') return;
    const z = this.zones.active;
    // inside the museum, at a frame: a closer look (the tour, from there)
    if (!z) return this.museumStop >= 0 ? this.enterMuseum(this.museumStop) : undefined;
    if (z === 'museum') {
      this.enterMuseum(0);
    } else if (z === 'booth') {
      this.enterShop();
    } else if (z === 'ideas') {
      this.enterIdeas();
    } else if (z === 'workshop') {
      this.enterWorkshop();
    } else if (z === 'drone') {
      // E at the counter shows the offer; E again (or its button) takes off
      if (this.panelZone === 'drone' && this.ui.panelOpenKey.startsWith('drone-offer')) this.board('drone');
      else {
        this.player.interact();
        this.showZonePanel(z);
        this.sfx.chime();
      }
    } else if (isAttraction(z)) this.board(z);
  }

  /**
   * Every attraction costs tickets. Guests get the members-only card, members short of tickets the
   * way to the booth; otherwise the server takes the tickets and opens a round, and the attraction
   * starts. The drone's gate is here too, at take-off rather than at its offer.
   */
  private board(ride: AttractionId) {
    // one round at a time, and none while one is starting (the visitor is frozen then)
    if (this.mode !== 'drive' || this.boarding || this.round || this.leaving || !this.player.enabled) return;
    // a Creators' Valley plot with nothing running on it (its ring is off, but the results' "again" can land here)
    if (isPlot(ride) && !this.valley.on(ride)) return;
    // staff ride through closed gates: that's how they test an attraction before it reopens
    if (!session.isStaff && !session.parkOpen) return this.showClosed(ride);
    if (!session.isStaff && session.maintenance(ride) !== undefined) return this.showMaintenance(ride);
    if (!session.user) return this.showGate(ride);
    const cost = session.cost(ride);
    const balance = session.balance;
    if (balance !== null && balance < cost) return this.showShort(ride, cost, balance);
    this.boarding = ride;
    session.board(ride).then(
      ({ round }) => {
        this.boarding = null;
        this.begin(ride, round.id, round.ticketsSpent);
      },
      (err: unknown) => {
        this.boarding = null;
        this.boardFailed(ride, err);
      },
    );
  }

  /** The round is paid for (the tickets are spent): on with the attraction. */
  private begin(ride: AttractionId, id: string, tickets: number) {
    if (this.mode !== 'drive' || this.round) {
      // can't happen in normal play; the round is closed rather than left open
      void session.finish(id, false, {}).catch(() => {});
      return;
    }
    // the map (or an old results screen) may have opened while the ticket printed
    this.worldMap.close();
    results.close(null);
    this.round = { id, ride, tickets };
    // a member's coaster: the one running on its plot now (taken out while the ticket printed: none)
    const run = isPlot(ride) ? this.valley.on(ride) : null;
    this.plotRound = run && { plot: run.plot, creation: run.creation.id, name: run.creation.name, coaster: run.coaster };
    this.stalledAt = null;
    // closed while the ticket printed: the round ends before it starts, and the tickets come back
    if (session.shutOut || (isPlot(ride) && !run) || (!session.isStaff && (!session.parkOpen || session.maintenance(ride) !== undefined))) {
      this.lockedOut = true;
      return this.finishRound(false);
    }
    this.launch(ride);
  }

  /** Starts the attraction the visitor has paid a round of. */
  private launch(ride: AttractionId) {
    switch (ride) {
      case 'coaster':
      case 'falcon': {
        const c = ride === 'falcon' ? this.falcon : this.stack;
        this.startRide('coaster', () => {
          this.ride = c;
          c.start();
        });
        break;
      }
      case 'rocket':
        this.startRide('rocket', () => this.rocket.start());
        break;
      case 'ferris':
        this.startRide('wheel', () => this.wheel.start());
        break;
      case 'flip':
        this.startRide('flip', () => this.flip.start());
        break;
      case 'ship':
        this.startRide('ship', () => this.ship.start());
        break;
      case 'speedway':
        this.startRide('race', () => this.speedway.start());
        break;
      case 'trail':
        // the trail's card (today's board) gives way to the run's own HUD
        this.ui.hidePanel();
        this.panelZone = null;
        this.startRide('trail', () => this.trail.start());
        break;
      case 'drone':
        this.launchDrone();
        break;
      case 'striker':
        this.player.interact();
        this.mode = 'striker';
        this.player.enabled = false;
        this.ui.rideExit(true);
        this.ui.prompt('', '', '');
        this.striker.start();
        this.panelZone = 'striker';
        break;
      case 'ducks': {
        // the visitor steps up to the counter and takes the gun (the camera is their eyes)
        this.player.interact();
        const spot = this.ducks.standSpot;
        this.player.reset(spot.x, spot.z, spot.heading);
        this.mode = 'ducks';
        this.player.enabled = false;
        this.player.group.visible = false;
        this.ui.rideExit(true);
        this.ui.prompt('', '', '');
        this.ducks.start();
        this.ducksBadge = '';
        this.panelZone = 'ducks';
        this.ui.panel('ducks-play', this.ducks.panelHtml(this.mobile), { accent: PALETTE.mustard });
        break;
      }
      case 'crates':
        // a walk-about game: the visitor stays on foot, against the clock
        this.player.interact();
        this.crates.start();
        this.cratesBadge = '';
        this.cratesDismissed = false;
        this.showZonePanel('crates');
        break;
      default:
        if (isPlot(ride)) this.launchPlot();
    }
  }

  /** Boards the coaster a member built (see begin: the one on its plot when the ticket printed). */
  private launchPlot() {
    const c = this.plotRound?.coaster;
    if (!c) return;
    c.input = this.input;
    c.onFinish = () => this.endRide();
    c.onComplete = () => this.leave(true);
    // out of speed on a climb: the round ends there, and the crew tows the train home
    c.onStall = (atM) => {
      this.stalledAt = atM;
      this.leave(false);
    };
    this.startRide('coaster', () => {
      this.ride = c;
      // taken out of the park while ridden, it stays until the rider is off (see endRide)
      this.valley.busy = c;
      c.start();
    });
  }

  /**
   * A plot's coaster opened, changed or closed: its ring, its name on the signs and the maps, and a
   * round on the coaster that just left (taken out, or replaced by a newer version) stops with a refund.
   */
  private onPlotChange(plot: PlotId) {
    const r = this.valley.on(plot);
    setPlotTitle(plot, r ? r.creation.name : null);
    setPlotPlace(plot, r ? { name: r.creation.name, creator: r.creation.creator, track: r.track, color: r.detail.data.colors.rails } : null);
    this.zones.setZone(plot, !!r);
    this.minimap.redraw();
    this.worldMap.refreshPlaces();
    if (this.round?.ride === plot && this.plotRound && r?.creation.id !== this.plotRound.creation) this.lockOut();
    // a card open at that plot is about a coaster that's gone
    if (!r && this.mode === 'drive' && this.panelZone === plot && !this.round) {
      this.ui.hidePanel();
      this.panelZone = null;
    }
  }

  private boardFailed(ride: AttractionId, err: unknown) {
    // under maintenance since we last looked: the session noted it, and the visitor is on the way out
    if (this.mode !== 'drive' || !this.inFair) return;
    // the cookie expired, or the account is gone: carry on as a guest
    if (err instanceof ApiError && err.status === 401) {
      session.expire();
      return this.showGate(ride, true);
    }
    // the wallet was shorter than it looked here (another tab, say): the server has the last word
    if (err instanceof NotEnoughTicketsError) {
      void session.loadTickets();
      return this.showShort(ride, err.needed ?? session.cost(ride), err.balance ?? session.balance ?? 0);
    }
    // closed since we last looked (the session has noted it)
    if (err instanceof ParkClosedError) return this.showClosed(ride);
    if (err instanceof RideClosedError) return this.showMaintenance(ride);
    const z = ZONES[ride];
    const closed = !(err instanceof ApiError) || err.unavailable;
    this.sfx.beep();
    this.panelZone = ride;
    this.ui.panel(
      `ticket-error-${Date.now()}`,
      closed
        ? `<p class="eyebrow">${escapeHtml(z.title)} · Ticket office</p><h2>The ticket office is closed 🚧</h2><p>We can't reach the ticket office right now, and it has to punch your ticket before ${escapeHtml(z.title)} can start. Your tickets are safe: try again in a moment.</p><p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-board data-ride="${ride}">Try again</button></p>`
        : `<p class="eyebrow">${escapeHtml(z.title)} · Ticket office</p><h2>No ticket this time</h2><p>${escapeHtml(err.message)}</p>`,
      { accent: PALETTE.mustard },
    );
  }

  /** The whole park is closed: the sign on the gate. */
  private showClosed(ride: AttractionId) {
    const z = ZONES[ride];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = ride;
    const sign = session.park?.message ?? "The park is closed right now. Come back soon: you're welcome to look around meanwhile.";
    this.ui.panel(
      `closed-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · Park closed</p><h2>🚧 The park is closed</h2><p>${escapeHtml(sign)}</p><p class="sub">No tickets are spent while the park is closed.</p>`,
      { accent: PALETTE.candy },
    );
  }

  /**
   * The park went under maintenance, and this visitor isn't staff: they leave the fair. A round in
   * progress stops (its tickets come back), the HUD and every card close, and main.ts brings the
   * intro back, where the way in stays shut until the maintenance is over.
   */
  private closeFair() {
    if (!this.inFair) return;
    if (this.mode === 'shop') this.leaveShop();
    if (this.mode === 'ideas') this.leaveIdeas();
    if (this.mode === 'museum') this.leaveMuseum(true);
    if (this.mode === 'workshop') this.leaveWorkshop(true);
    this.inFair = false;
    // a test ride from the yard ends (and lands back on foot: see endTestRide)
    if (this.testRide) this.leave(false);
    session.setInFair(false);
    if (this.round) this.lockOut();
    this.ui.hidePanel();
    this.panelZone = null;
    this.worldMap.close();
    results.close(null);
    this.ui.prompt('', '', '');
    this.ui.hud.hidden = true;
    this.parkBanner.hidden = true;
    if (this.mode === 'drive') this.player.enabled = false;
    this.onShutOut?.();
  }

  /** The round's attraction (or the whole park) closed under the player: out they come, with their tickets back. */
  private lockOut() {
    if (this.lockedOut) return;
    this.lockedOut = true;
    // a ride still fading in is stopped by startRide; a ride on its way out ends through endRide
    if (this.mode === 'drive' && this.round?.ride !== 'crates') return;
    this.leave(false);
  }

  /** After a lock-out: the round's tickets go back, and the sign says why it stopped. */
  private async showLockedOut(ride: AttractionId, roundId: string, coaster: string | null = null) {
    const refunded = await session.refund(roundId);
    // open again already, or the server's away: the round is closed as usual, without the results
    if (refunded === null) void session.finish(roundId, false, {}).catch(() => {});
    if (!this.inFair || this.mode !== 'drive' || this.round || this.boarding) return;
    const z = ZONES[ride];
    const parkClosed = !session.parkOpen;
    const back = refunded ? (refunded === 1 ? 'its ticket is back in your wallet' : `its ${refunded} tickets are back in your wallet`) : 'it has been ended';
    // a member's coaster taken out of Creators' Valley (or swapped for a newer version) under the rider
    if (isPlot(ride) && coaster !== null && !parkClosed && session.maintenance(ride) === undefined) {
      const newer = session.creationOn(plotNumber(ride));
      const name = escapeHtml(coaster);
      this.sfx.beep();
      this.panelZone = ride;
      this.ui.panel(
        `taken-${ride}-${Date.now()}`,
        `<p class="eyebrow">${name} · Creators' Valley</p><h2>🚧 ${name} just left the park</h2><p>${
          newer
            ? `Staff swapped it for ${newer.name === coaster ? 'a newer version' : `<strong>${escapeHtml(newer.name)}</strong>`}, opening on this plot in a moment.`
            : "Staff took it out of Creators' Valley."
        }</p><p class="sub">Your round was stopped, and ${back}.</p>`,
        { accent: PALETTE.candy },
      );
      return;
    }
    const sign = parkClosed
      ? (session.park?.message ?? "The park is closed right now. Come back soon: you're welcome to look around meanwhile.")
      : (session.maintenance(ride) ?? `Our crew is giving ${z.title} some care. It will be back soon: try another attraction meanwhile!`);
    this.sfx.beep();
    this.panelZone = ride;
    this.ui.panel(
      `${parkClosed ? 'closed' : 'maintenance'}-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${parkClosed ? 'Park closed' : 'Under maintenance'}</p><h2>🚧 ${parkClosed ? 'The park just closed' : `${escapeHtml(z.title)} just closed`}</h2><p>${escapeHtml(sign)}</p><p class="sub">Your round was stopped, and ${back}.</p>`,
      { accent: PALETTE.candy },
    );
  }

  /** The attraction is closed for maintenance: its sign. */
  private showMaintenance(ride: AttractionId) {
    const z = ZONES[ride];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = ride;
    const sign = session.maintenance(ride) ?? `Our crew is giving ${z.title} some care. It will be back soon: try another attraction meanwhile!`;
    this.ui.panel(
      `maintenance-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · Under maintenance</p><h2>🚧 Under maintenance</h2><p>${escapeHtml(sign)}</p><p class="sub">No tickets were spent.</p>`,
      { accent: PALETTE.candy },
    );
  }

  /** The gates changed (or were first heard of): the banner, the rings, and an open sign that no longer applies. */
  private onParkChange() {
    const open = session.parkOpen;
    if (open) this.parkBannerDismissed = false;
    this.parkBanner.querySelector('.park-banner-text')!.textContent = open
      ? ''
      : (session.park?.message ?? (session.isStaff ? 'Staff can still ride, to test.' : 'Look around as much as you like; the rides and the Ticket Booth are paused.'));
    this.parkBanner.hidden = open || this.parkBannerDismissed || this.ui.hud.hidden;
    const closed = new Map(ATTRACTION_IDS.flatMap((id) => (session.maintenance(id) === undefined ? [] : [[id, session.maintenance(id) ?? null] as const])));
    this.zones?.setClosed(new Set(closed.keys()));
    this.worldMap?.setClosed(closed);
    if (this.minimap) this.minimap.closed = new Set(closed.keys());
    if (this.inFair && session.shutOut) return this.closeFair();
    // a player in a round of an attraction that just closed is shown out (staff ride on, to test it)
    const playing = this.round?.ride;
    if (playing && !session.isStaff && (!open || closed.has(playing))) return this.lockOut();
    // a maintenance or closed sign that's open while the gate reopens is stale
    const key = this.ui.panelOpenKey;
    if (this.mode === 'drive' && (key.startsWith('maintenance-') || key.startsWith('closed-'))) {
      const ride = this.panelZone;
      if (ride && isAttraction(ride) && open && session.maintenance(ride) === undefined) {
        this.ui.hidePanel();
        this.panelZone = null;
      }
    } else if (this.mode === 'drive' && key.startsWith('trail-board') && this.panelZone === 'trail') {
      // the trail's card keeps its leaderboard; only its button follows the gates
      this.showZonePanel('trail');
    } else if (this.mode === 'drive' && /^(gate|short|drone-offer|crates)-/.test(key) && !session.isStaff && !this.boarding && !this.round) {
      // closed while its offer is up (the office pushes it live): the sign replaces the offer
      const ride = this.panelZone;
      if (ride && isAttraction(ride)) {
        if (!open) this.showClosed(ride);
        else if (session.maintenance(ride) !== undefined) this.showMaintenance(ride);
      }
    }
  }

  /** The members-only card a guest gets at an attraction. */
  private showGate(ride: AttractionId, expired = false) {
    const z = ZONES[ride];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = ride;
    this.ui.panel(
      `gate-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${ticketsText(session.cost(ride))}</p><h2>🎟️ Members only</h2><p>${
        expired ? "Your session ran out, so you're back to being a guest. " : ''
      }Every ride and game costs tickets, and tickets come with a free account: pick up ${packText()}. Visiting the booth is always free.</p>${accountButtons(ride)}`,
      { accent: PALETTE.mustard },
    );
  }

  /** A member without enough tickets for this round: how many they're short, and the way to the booth. */
  private showShort(ride: AttractionId, cost: number, balance: number) {
    const z = ZONES[ride];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = ride;
    const wait = session.msUntilPurchase();
    this.ui.panel(
      `short-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${ticketsText(cost)}</p><h2>Not enough tickets</h2><p>${escapeHtml(z.title)} costs <strong>${ticketsText(cost)}</strong> a round, and you have <strong>${balance}</strong>.</p>${
        wait === null ? '' : waitHtml(wait)
      }<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-goto="booth">Go to the Ticket Booth 🎟️</button></p>`,
      { accent: PALETTE.mustard },
    );
    // the countdown needs the wallet: it fills in once it's here
    if (wait === null) void session.loadTickets();
  }

  /** Opens the sign-up / log-in dialog. From an attraction's gate, it boards that one once they're in. */
  private async signIn(mode: AuthMode, ride: AttractionId | null) {
    const title = ride && ZONES[ride].title;
    // a function, so the dialog keeps the pack rules live while it's open
    const lead = title
      ? () =>
          mode === 'signup'
            ? `Sign up to play ${title}: a free account comes with free tickets, ${session.packSize} ${everyHours(session.cooldownHours)}.`
            : `Log in to play ${title}.`
      : undefined;
    const user = await authDialog.open(mode, lead);
    if (!user || !ride) return;
    // the wallet decides what happens next (a brand-new account has to visit the booth first)
    await session.loadTickets();
    if (this.mode === 'drive' && this.zones.active === ride) this.board(ride);
  }

  /** Cards that depend on the account redraw when someone signs in or out (or their wallet changes). */
  private onSessionChange() {
    // no longer staff (or logged out) while the park is under maintenance
    if (this.inFair && session.shutOut) return this.closeFair();
    const user = session.user?.id ?? null;
    const switched = user !== this.sessionUser;
    this.sessionUser = user;
    if (switched && this.mode === 'workshop') this.leaveWorkshop();
    const key = this.ui.panelOpenKey;
    if (!key || this.mode !== 'drive') return;
    if (switched && session.user && key.startsWith('gate-')) {
      this.ui.hidePanel();
      this.panelZone = null;
    } else if (switched && (key.startsWith('drone-offer') || (key.startsWith('crates') && !this.round))) this.showZonePanel(key.startsWith('drone') ? 'drone' : 'crates');
    else if (key.startsWith('trail-board') && this.panelZone === 'trail') this.showZonePanel('trail');
    else if (key.startsWith('short-') && !this.ui.panelElement.querySelector('.ticket-wait')) {
      // the wallet arrived: add the countdown to the next pack
      const wait = session.msUntilPurchase();
      if (wait !== null) this.ui.panelElement.querySelector('.panel-actions')?.insertAdjacentHTML('beforebegin', waitHtml(wait));
    }
  }

  /** Rents the drone and takes off (its round has been paid for). */
  private launchDrone() {
    if (this.mode !== 'drive') return;
    this.player.interact();
    this.ui.hidePanel();
    this.panelZone = null;
    this.startRide('drone', () => {
      this.drone.start();
      // a fizzy soda from the booth: an extra minute in the air
      const bonus = perks.takeDroneBonus();
      if (bonus) this.drone.recharge(bonus);
    });
  }

  private showZonePanel(z: ZoneId) {
    this.panelZone = z;
    if (z === 'drone') {
      const cost = session.cost('drone');
      const gate = session.user
        ? null
        : `<p class="drone-gate">🎟️ A flight costs ${ticketsText(cost)}, and tickets come free with an account. Sign up or log in, and the drone is yours.</p>${accountButtons('drone')}`;
      this.ui.panel(`drone-offer-${Date.now()}`, this.drone.offerHtml(cost, gate), { accent: PALETTE.teal });
      this.ui.panelElement.querySelector('[data-drone-launch]')?.addEventListener('click', () => this.board('drone'));
      return;
    }
    if (z === 'crates') {
      this.ui.panel(`crates-${Date.now()}`, this.crates.panelHtml(this.cratesExtraHtml()), { accent: PALETTE.teal });
      return;
    }
    if (z === 'trail') {
      this.ui.panel(`trail-board-${Date.now()}`, this.trailPanelHtml(), { accent: PALETTE.orange });
      return;
    }
  }

  /** The Rally Trail's card: today's leaderboard, where the member stands, and the way to drive. */
  private trailPanelHtml() {
    const board = leaderboard.board;
    const cost = session.cost('trail');
    const me = board?.me;
    const standing = !session.user
      ? ''
      : me
        ? `<p class="lb-me">You're <strong>#${me.rank}</strong> today with <strong>${trailTime(me.timeMs)}</strong>. Beat it!</p>`
        : '<p class="lb-me">No time from you today yet.</p>';
    const reset = board ? `<p class="sub">A new board starts every day at ${escapeHtml(resetClock(board))}: ${escapeHtml(resetIn(leaderboard.msUntilReset() ?? 0))} to go. Earlier boards are kept.</p>` : '';
    const closed = !session.parkOpen || session.maintenance('trail') !== undefined;
    const drive = !session.user
      ? `<p class="drone-gate">🎟️ A run costs ${ticketsText(cost)}, and tickets come free with an account.</p>${accountButtons('trail')}`
      : closed && !session.isStaff
        ? ''
        : `<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-board data-ride="trail">Drive the trail · ${cost} 🎟️</button></p>`;
    return `<p class="eyebrow">Rally Trail · today's leaderboard</p><h2>Today's fastest 🏁</h2>${boardListHtml(board)}${standing}${reset}${drive}`;
  }

  /**
   * Steps up to the Ticket Booth's counter: the visitor walks up to it (behind a quick fade), the
   * camera moves to Rosa, and the shop opens beside her.
   */
  private enterShop() {
    if (this.mode !== 'drive' || this.round || this.boarding || !this.shop) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    // the shot starts from where the camera is, and glides over
    this.camPos.copy(this.camera.position);
    this.fade(() => {
      const spot = this.shop!.counterSpot;
      this.player.reset(spot.x, spot.z, spot.heading);
      this.mode = 'shop';
      document.body.classList.add('is-shopping');
      this.shop!.open();
      this.resize();
    });
  }

  /** Back from the counter to the fair: the camera returns behind the visitor. */
  private leaveShop() {
    if (this.mode !== 'shop') return;
    this.shop?.close();
    this.mode = 'drive';
    document.body.classList.remove('is-shopping');
    this.player.enabled = this.inFair;
    this.camYaw = 0; // behind the visitor, who faces the booth
    this.resize();
    this.sfx.chime();
  }

  /** Takes the visitor to the Ticket Booth and opens its counter. */
  private goToBooth() {
    if (this.mode !== 'drive' || this.round) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.teleport('booth', () => this.enterShop());
  }

  /**
   * Steps up to the Idea Box: the visitor walks up to its slot (behind a quick fade), the camera
   * moves over their shoulder, and the sheet opens beside it (as at the booth).
   */
  private enterIdeas() {
    if (this.mode !== 'drive' || this.round || this.boarding || !this.ideas) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.ideaNews = false;
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    // the shot starts from where the camera is, and glides over
    this.camPos.copy(this.camera.position);
    this.fade(() => {
      const spot = this.ideas!.standSpot;
      this.player.reset(spot.x, spot.z, spot.heading);
      this.mode = 'ideas';
      document.body.classList.add('is-shopping');
      this.ideas!.open();
      this.resize();
    });
  }

  /** Back from the Idea Box to the fair: the camera returns behind the visitor. */
  private leaveIdeas() {
    if (this.mode !== 'ideas') return;
    this.ideas?.close();
    this.mode = 'drive';
    document.body.classList.remove('is-shopping');
    this.player.enabled = this.inFair;
    this.camYaw = ZONES.ideas.heading; // behind the visitor, who faces the kiosk
    this.resize();
    this.sfx.chime();
  }

  /** Takes the visitor to the Idea Box and opens it. */
  private goToIdeas() {
    if (this.mode !== 'drive' || this.round) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.teleport('ideas', () => this.enterIdeas());
  }

  /** The members-only card at the Coaster Workshop's kiosk. */
  private showWorkshopGate() {
    this.player.interact();
    this.sfx.beep();
    this.panelZone = 'workshop';
    this.ui.panel(
      `gate-workshop-${Date.now()}`,
      `<p class="eyebrow">Coaster Workshop · Creators' Valley</p><h2>🛠️ Members only</h2><p>Build your own coaster here: buy parts with tickets, lay the track piece by piece and ride it for free. Send it to staff, and if they release it in Creators' Valley, your name goes on the station and you earn tickets every time someone rides it.</p><p>It starts with a free account, and a free starter kit.</p>${accountButtons()}`,
      { accent: '#e05aa8' },
    );
  }

  /**
   * Into the Builder's Yard (behind a quick fade): the park makes way for the yard's own layer, and
   * the workshop's sheet opens. With `inspect`, a submitted coaster to look at and ride instead.
   */
  private enterWorkshop(inspect?: CreationDetail) {
    if (this.mode !== 'drive' || this.round || this.boarding || this.leaving || !this.workshop) return;
    if (!session.user && !inspect) return this.showWorkshopGate();
    this.ui.hidePanel();
    this.panelZone = null;
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    this.worldMap.close();
    this.fade(() => {
      this.mode = 'workshop';
      this.player.group.visible = false;
      document.body.classList.add('is-shopping', 'is-workshop');
      this.camera.layers.set(YARD_LAYER);
      this.yard.active = true;
      this.yard.snap();
      if (inspect) this.workshop!.inspect(inspect);
      else this.workshop!.open();
      this.resize();
    });
  }

  /** Back from the yard to the kiosk, on foot. */
  private leaveWorkshop(now = false) {
    if (this.mode !== 'workshop') return;
    this.workshop?.close();
    this.yard.active = false;
    const back = () => {
      this.mode = 'drive';
      this.camera.layers.set(0);
      document.body.classList.remove('is-shopping', 'is-workshop');
      const z = ZONES.workshop;
      this.player.reset(z.x, z.z, z.heading);
      this.player.group.visible = true;
      this.player.enabled = this.inFair;
      this.camYaw = z.heading; // behind the visitor, facing the kiosk
      this.camPitch = 0.2;
      this.resize();
      this.updateDriveCamera(1, true);
    };
    if (now) return back();
    this.fade(back);
    this.sfx.chime();
  }

  /** The office's link to a submitted coaster: into the yard with it, once the fair is open. */
  private async openInspect(id: string) {
    try {
      const c = await api.creation(id);
      if (this.mode === 'drive' && this.inFair) this.enterWorkshop(c);
    } catch (err) {
      this.panelZone = null;
      this.ui.panel(
        `inspect-${Date.now()}`,
        `<p class="eyebrow">Coaster Workshop</p><h2>That coaster isn't here</h2><p>${
          err instanceof ApiError && err.status === 404
            ? 'It may have been taken back, or only its creator and staff can see it: log in with a staff account and try the link again.'
            : escapeHtml(err instanceof Error ? err.message : "Couldn't load it.")
        }</p>`,
        { accent: '#e05aa8' },
      );
    }
  }

  /** A free test ride on the coaster in the yard: no round and no tickets, back to the yard after. */
  private testRideYard() {
    if (this.mode !== 'workshop' || this.leaving || !this.workshop) return;
    const c = this.yard.flush();
    if (!c) return;
    this.workshop.suspend();
    this.yard.active = false;
    this.testRide = true;
    this.testStall = null;
    c.input = this.input;
    c.onFinish = () => this.endTestRide(c);
    c.onComplete = () => this.leave(true);
    c.onStall = (atM) => {
      this.testStall = atM;
      this.leave(false);
    };
    this.startRide('coaster', () => {
      document.body.classList.remove('is-shopping');
      this.ride = c;
      c.start();
      this.resize();
    });
  }

  /** The test ride's over: back in the yard, with how it went. */
  private endTestRide(c: Coaster) {
    const completed = this.leaveCompleted;
    this.leaving = this.leaveCompleted = false;
    this.testRide = false;
    this.camera.up.set(0, 1, 0);
    this.ui.endIntro();
    this.ui.cinematic(false);
    this.ui.rideExit(false);
    this.ui.countdown(null);
    this.mode = 'workshop';
    document.body.classList.add('is-shopping');
    const stalledAt = this.testStall;
    this.testStall = null;
    // out of the fair (or signed out) meanwhile: straight back on foot
    if (!this.inFair || (!session.user && !this.workshop?.inspecting)) return this.leaveWorkshop(true);
    this.yard.active = true;
    this.yard.snap();
    this.workshop?.resume();
    this.workshop?.testDone({ completed, stalledAt, stats: c.roundStats() });
    this.resize();
  }

  /**
   * The Career Museum's tour, at stop `i` (0: the porch, then each frame, then the toolbox): the
   * visitor steps aside (behind a quick fade), the camera glides to the frame, and the sheet with
   * its story opens beside it.
   */
  private enterMuseum(i: number) {
    if (this.mode !== 'drive' || this.round || this.boarding || !this.gallery) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    // the shot starts from where the camera is, and glides over
    this.camPos.copy(this.camera.position);
    this.fade(() => {
      this.mode = 'museum';
      // the camera is the visitor's eyes on the tour
      this.player.group.visible = false;
      document.body.classList.add('is-shopping');
      this.gallery!.open(i);
      this.resize();
    });
  }

  /** Back from the tour: the visitor stands in front of the last frame they looked at, facing it. */
  private leaveMuseum(now = false) {
    if (this.mode !== 'museum' || !this.gallery?.isOpen) return;
    const spot = this.museum.standSpot(this.gallery.index);
    this.gallery.close();
    document.body.classList.remove('is-shopping');
    const back = () => {
      this.mode = 'drive';
      this.player.reset(spot.x, spot.z, spot.heading);
      this.player.group.visible = true;
      this.player.enabled = this.inFair;
      this.camYaw = spot.heading; // behind the visitor, looking where they look
      this.camPitch = 0.2;
      this.resize();
      this.updateDriveCamera(1, true);
    };
    if (now) return back();
    // the camera holds its shot until the fade covers the move
    this.fade(back);
    this.sfx.chime();
  }

  /** What the tour's camera has to fit around: the screen, minus the sheet. */
  private museumFit() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    const off = this.gallery?.viewOffset(w, h) ?? { x: 0, y: 0 };
    return { aspect: this.camera.aspect, fov: this.camera.fov, fx: Math.max(0.3, 1 - (2 * off.x) / w), fy: Math.max(0.3, 1 - (2 * off.y) / h) };
  }

  /** Staff answered an idea: once the visitor is on foot with no card open, one says so. */
  private showIdeaNews() {
    if (!this.ideaNews || this.mode !== 'drive' || this.round || this.boarding || this.ui.panelOpenKey || !session.user) return;
    this.ideaNews = false;
    const n = session.suggestions?.unread ?? 0;
    const latest = session.suggestions?.suggestions.find((s) => s.unread);
    if (!n || !latest) return;
    const said = latest.message.length > 80 ? `${latest.message.slice(0, 79).trimEnd()}…` : latest.message;
    this.ui.panel(
      `ideas-news-${Date.now()}`,
      `<p class="eyebrow">The Idea Box</p><h2>${n === 1 ? 'Staff answered your idea 💡' : `Staff answered ${n} of your ideas 💡`}</h2><p>“${escapeHtml(said)}” is now <strong>${escapeHtml(STATUSES[latest.status].label.toLowerCase())}</strong>${latest.reply ? ', and staff left you a message' : ''}.</p><p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-goto="ideas">Read it at the Idea Box 💡</button></p>`,
      { accent: PALETTE.violet },
    );
    this.sfx.chime();
  }

  /** Ticks the open card's countdowns to the next pack; at zero the booth's button wakes up. */
  private tickCountdowns() {
    if (!this.ui.panelOpenKey) return;
    const clocks = this.ui.panelElement.querySelectorAll<HTMLElement>('[data-countdown]');
    if (!clocks.length) return;
    const wait = session.msUntilPurchase();
    if (wait === null) return;
    if (wait > 0) {
      for (const c of clocks) c.textContent = formatWait(wait);
      return;
    }
    for (const c of clocks) c.closest('.ticket-wait')?.replaceWith(document.createRange().createContextualFragment(waitHtml(0)));
  }

  /** Under the crates card: how to start a round (or stop the one being played). */
  private cratesExtraHtml() {
    const cost = session.cost('crates');
    if (this.round?.ride === 'crates')
      return `<p class="panel-actions"><button class="btn btn-outline btn-small" type="button" data-stop>Stop the round</button></p><p class="sub">${
        this.mobile ? 'Stopping early still uses the ticket.' : '<kbd>Esc</kbd> stops early (the ticket is still used).'
      }</p>`;
    if (!session.user) return `<p class="drone-gate">🎟️ A round costs ${ticketsText(cost)}, and tickets come free with an account.</p>${accountButtons('crates')}`;
    return `<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-board data-ride="crates">Start a round · ${cost} 🎟️</button></p>`;
  }

  /** A note on the game's card (e.g. from the account card, once the account is gone). */
  private notice(title: string, text: string) {
    this.panelZone = null;
    this.ui.panel(`notice-${Date.now()}`, `<p class="eyebrow">Your account</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p>${legalLinksHtml()}`, { accent: PALETTE.violet });
  }

  private startRide(mode: Mode, start: () => void) {
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    this.fade(() => {
      // closed while the ride was fading in: it never starts
      if (this.lockedOut) {
        this.player.enabled = true;
        return this.finishRound(false);
      }
      this.mode = mode;
      this.ui.cinematic(true);
      this.ui.rideExit(true);
      start();
    });
  }

  private onEscape() {
    if (this.mode === 'shop') return this.leaveShop();
    if (this.mode === 'ideas') return this.leaveIdeas();
    if (this.mode === 'museum') return this.leaveMuseum();
    if (this.mode === 'workshop') return this.workshop?.escape();
    // past the line already: the run's done, so this is no early exit
    if (this.mode === 'trail' && this.trail.finished) return this.leave(true);
    if (this.mode !== 'drive' || this.round?.ride === 'crates') return this.askToLeave();
    if (this.zones.active === 'crates') this.cratesDismissed = true;
    if (this.zones.active === 'trail') this.trailDismissed = true;
    this.ui.hidePanel();
    this.panelZone = null;
  }

  /** Esc, the exit button or "Stop the round" mid-round: its tickets aren't given back, so the visitor is asked first. */
  private askToLeave() {
    const round = this.round;
    // nothing to lose (no round, or one already on its way out): straight out as before
    if (!round || this.leaving || this.lockedOut) return this.leave(false);
    if (leaveEarly.isOpen) return;
    void leaveEarly.ask(ZONES[round.ride].title, round.tickets, isGame(round.ride)).then((go) => {
      if (go && this.round === round) this.leave(false);
    });
  }

  /**
   * Ends the attraction in progress: `completed` when its round ran to the end on its own (the
   * attraction's onComplete), not when the visitor bailed out (Esc, the exit button). The round
   * counts as used either way.
   */
  private leave(completed: boolean) {
    if (this.leaving) return;
    // the round ended on its own (or was closed) while "leave early?" was up: the question is moot
    leaveEarly.close(false);
    if (this.mode === 'drive') {
      // the crates are played on foot: stopping the clock is all it takes
      if (this.round?.ride !== 'crates') return;
      this.crates.stop();
      this.ui.score(null);
      this.panelZone = null;
      return this.finishRound(completed);
    }
    this.leaving = true;
    this.leaveCompleted = completed;
    if (this.mode === 'shop') return this.leaveShop();
    if (this.mode === 'ideas') return this.leaveIdeas();
    if (this.mode === 'museum') return this.leaveMuseum();
    if (this.mode === 'workshop') {
      this.leaving = false;
      return this.leaveWorkshop();
    }
    const exit: Record<Exclude<Mode, 'drive' | 'striker' | 'ducks' | 'shop' | 'ideas' | 'museum' | 'workshop'>, () => void> = {
      coaster: () => this.ride.exit(),
      rocket: () => this.rocket.exit(),
      wheel: () => this.wheel.exit(),
      drone: () => this.drone.exit(),
      flip: () => this.flip.exit(),
      ship: () => this.ship.exit(),
      race: () => this.speedway.exit(),
      trail: () => this.trail.exit(),
    };
    // each exit() hands back to endRide() (its onFinish)
    if (this.mode === 'striker') this.striker.exit();
    else if (this.mode === 'ducks') this.ducks.exit();
    else this.fade(exit[this.mode]);
  }

  private endRide() {
    this.camera.up.set(0, 1, 0);
    this.ui.endIntro();
    const wasRide =
      this.mode === 'coaster' || this.mode === 'rocket' || this.mode === 'wheel' || this.mode === 'drone' || this.mode === 'flip' || this.mode === 'ship' || this.mode === 'race' || this.mode === 'trail';
    if (this.mode === 'wheel' || this.mode === 'drone' || this.mode === 'flip') this.env.setHaze(1);
    const from = this.mode;
    if (from === 'ducks') {
      // back on foot at the counter, the camera behind the visitor
      this.player.group.visible = true;
      this.camYaw = ZONES.ducks.heading;
      this.ui.score(null);
    }
    this.mode = 'drive';
    // a ride that ended because the park went under maintenance lands at the intro, not on foot
    this.player.enabled = this.inFair;
    this.ui.cinematic(false);
    this.ui.rideExit(false);
    this.ui.countdown(null);
    const zoneOf: Partial<Record<Mode, ZoneId>> = { striker: 'striker', ducks: 'ducks', drone: 'drone', flip: 'flip', ship: 'ship', race: 'speedway', trail: 'trail', wheel: 'ferris' };
    this.panelZone =
      from === 'coaster' ? (this.ride === this.falcon ? 'falcon' : this.ride === this.stack ? 'coaster' : (this.plotRound?.plot ?? 'coaster')) : (zoneOf[from] ?? 'rocket');
    // a member's coaster taken out of the park while it was ridden can go now
    if (from === 'coaster') this.valley.release();
    if (wasRide) this.updateDriveCamera(1, true);
    const completed = this.leaveCompleted;
    this.leaving = this.leaveCompleted = false;
    this.finishRound(completed);
  }

  /**
   * Closes the round: the results screen opens straight away with what was measured here, and fills
   * in the personal bests and round count once the server has kept the round (or says why it
   * couldn't, e.g. offline).
   */
  private finishRound(completed: boolean) {
    const round = this.round;
    if (!round) return;
    this.round = null;
    leaveEarly.close(false);
    const plotRound = this.plotRound;
    const stalled = this.stalledAt;
    this.stalledAt = null;
    if (this.lockedOut) {
      this.lockedOut = false;
      this.plotRound = null;
      this.ui.hidePanel();
      this.panelZone = null;
      return void this.showLockedOut(round.ride, round.id, plotRound?.name ?? null);
    }
    const stats = this.measuredStats(round.ride);
    this.plotRound = null;
    // the attraction's own card is done with: the results screen takes over
    this.ui.hidePanel();
    this.panelZone = null;
    const result: RoundResult = {
      ride: round.ride,
      title: plotRound?.name ?? ZONES[round.ride].title,
      completed,
      stats,
      ...(stalled === null
        ? {}
        : {
            ending: {
              headline: `Stalled at ${stalled} m`,
              lead: 'Not enough speed to make it over the top: the train rolled to a stop, and the crew towed it back to the station.',
            },
          }),
    };
    void results.open(result).then((choice) => this.afterResults(round.ride, choice));
    session.finish(round.id, completed, stats).then(
      (res) => results.saved(result, res),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) session.expire();
        results.failed(result, err);
      },
    );
  }

  /** What the attraction measured of its round, ready for the server. */
  private measuredStats(ride: AttractionId) {
    // a member's coaster: the one boarded (see begin)
    if (isPlot(ride)) return cleanStats(this.plotRound?.coaster.roundStats() ?? {});
    const measured: Record<Exclude<AttractionId, PlotId>, Measured> = {
      coaster: this.stack,
      falcon: this.falcon,
      rocket: this.rocket,
      ferris: this.wheel,
      flip: this.flip,
      ship: this.ship,
      speedway: this.speedway,
      trail: this.trail,
      drone: this.drone,
      crates: this.crates,
      striker: this.striker,
      ducks: this.ducks,
    };
    return cleanStats(measured[ride].roundStats());
  }

  /** The results screen's buttons: another round, or the way to more tickets. */
  private afterResults(ride: AttractionId, choice: ResultsChoice) {
    if (this.mode !== 'drive') return;
    if (choice === 'again') this.board(ride);
    else if (choice === 'booth') this.goToBooth();
  }

  private fade(mid: () => void) {
    this.fadeEl.classList.add('on');
    setTimeout(() => {
      mid();
      requestAnimationFrame(() => this.fadeEl.classList.remove('on'));
    }, 320);
  }

  /** Fast travel to a zone; `then` runs once the visitor is there (behind the fade). */
  teleport(id: ZoneId, then?: () => void) {
    if (this.mode === 'striker' || this.mode === 'ducks') this.leave(false);
    if (this.mode !== 'drive') return;
    const z = ZONES[id];
    this.fade(() => {
      // park just in front of the trigger ring so the prompt shows up immediately
      this.player.reset(z.x, z.z, z.heading);
      this.camYaw = z.heading; // behind the visitor, facing the attraction
      this.camPitch = 0.2;
      this.updateDriveCamera(1, true);
      then?.();
    });
  }

  private resize() {
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    // portrait screens need a wider view
    this.camera.fov = w / h < 0.8 ? 58 : 42;
    // at the counter, the picture slides aside so Rosa shows beside the shop, not under it
    const off =
      this.mode === 'shop' && this.shop
        ? this.shop.viewOffset(w, h)
        : this.mode === 'ideas' && this.ideas
          ? this.ideas.viewOffset(w, h)
          : this.mode === 'museum' && this.gallery
            ? this.gallery.viewOffset(w, h)
            : this.mode === 'workshop' && this.workshop
              ? this.workshop.viewOffset(w, h)
              : null;
    if (off && (off.x || off.y)) this.camera.setViewOffset(w, h, off.x, off.y, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.renderer?.setSize(w, h);
    this.post?.setSize(w, h);
  }

  private updateDriveCamera(dt: number, snap = false) {
    const p = this.player.position;
    const vel = this.player.body.velocity;
    const portrait = this.camera.aspect < 0.8;
    // a third-person orbit view: low enough that the horizon (and the rides on it) stay in frame
    const dist = 8.5 * this.zoom * (portrait ? 1.25 : 1);
    const cp = Math.cos(this.camPitch);
    const offset = new THREE.Vector3(Math.sin(this.camYaw) * cp, Math.sin(this.camPitch), Math.cos(this.camYaw) * cp).multiplyScalar(dist);
    const target = new THREE.Vector3(p.x + vel.x * 0.3, 1.7, p.z + vel.z * 0.3);
    this.player.camYaw = this.camYaw;
    const goal = target.clone().add(offset);
    // in the museum's hall the camera stays between its walls, under the roof
    if (this.museum.inside(p)) this.museum.clampCamera(target, goal);
    const k = snap ? 1 : 1 - Math.exp(-dt * 4);
    this.camTarget.lerp(target, k);
    this.camPos.lerp(goal, k);
    if (snap) {
      this.camTarget.copy(target);
      this.camPos.copy(goal);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
  }

  private tick() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.time.t += dt;
    const t = this.time.t;

    this.input.update();
    this.player.update(dt, this.input); // player.enabled is false during rides

    this.world.step(1 / 60, dt, 4);
    for (const d of this.ctx.dynamics) {
      d.mesh.position.set(d.body.position.x, d.body.position.y, d.body.position.z);
      d.mesh.quaternion.set(d.body.quaternion.x, d.body.quaternion.y, d.body.quaternion.z, d.body.quaternion.w);
    }
    this.player.sync();

    // the demo buggy's engine is heard from the park, not over the kart you're racing
    this.trail.ambient = this.mode === 'drive';
    for (const u of this.updatables) u.update(dt, t);
    this.wardrobe?.update(dt);
    this.updateCoasterAudio();
    if (this.mode === 'drive' || this.mode === 'drone' || this.mode === 'race' || this.mode === 'trail') this.updateMinimap(dt);
    wind.uTime.value = t;
    wind.uCar.value.copy(this.player.position);

    // camera + shadow focus per mode
    if (this.mode === 'coaster') {
      this.zones.setVisible(false);
      this.ride.updateCamera(this.camera, dt);
      this.env.follow(this.ride.trainPosition.clone().setY(0));
    } else if (this.mode === 'rocket') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.rocket.updateCamera(this.camera, dt);
      this.env.follow(new THREE.Vector3(LAYOUT.rocket.x, 0, LAYOUT.rocket.z));
    } else if (this.mode === 'wheel') {
      this.zones.setVisible(false);
      this.wheel.updateCamera(this.camera, dt);
      this.env.follow(this.wheel.focus);
      this.env.setHaze(1 - 0.3 * THREE.MathUtils.clamp(this.wheel.altitude / 250, 0, 1));
    } else if (this.mode === 'drone') {
      this.zones.setVisible(false);
      this.drone.updateCamera(this.camera, dt);
      this.env.follow(this.drone.focus);
      this.env.setHaze(1 - 0.3 * THREE.MathUtils.clamp(this.drone.altitude / 250, 0, 1));
    } else if (this.mode === 'flip') {
      this.zones.setVisible(false);
      this.flip.updateCamera(this.camera, dt);
      this.env.follow(this.flip.focus);
      this.env.setHaze(1 - 0.3 * THREE.MathUtils.clamp(this.flip.altitude / 250, 0, 1));
    } else if (this.mode === 'ship') {
      this.zones.setVisible(false);
      this.ship.updateCamera(this.camera, dt);
      this.env.follow(this.ship.focus);
    } else if (this.mode === 'race') {
      this.zones.setVisible(false);
      this.speedway.updateCamera(this.camera, dt);
      this.env.follow(this.speedway.focus);
    } else if (this.mode === 'trail') {
      this.zones.setVisible(false);
      this.trail.updateCamera(this.camera, dt);
      this.env.follow(this.trail.focus);
    } else if (this.mode === 'shop' && this.shop) {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      const { pos, look } = this.shop.shot();
      this.camPos.lerp(pos, 1 - Math.exp(-dt * 2.6));
      this.camTarget.lerp(look, 1 - Math.exp(-dt * 2.6));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.env.follow(this.player.position);
      this.shop.update(dt);
    } else if (this.mode === 'ideas' && this.ideas) {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      const { pos, look } = this.ideas.shot();
      this.camPos.lerp(pos, 1 - Math.exp(-dt * 2.6));
      this.camTarget.lerp(look, 1 - Math.exp(-dt * 2.6));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.env.follow(this.player.position);
    } else if (this.mode === 'museum' && this.gallery) {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      const { pos, look } = this.museum.shot(this.gallery.index, this.museumFit());
      const k = 1 - Math.exp(-dt * 2.2);
      this.camPos.lerp(pos, k);
      this.camTarget.lerp(look, k);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.env.follow(this.camTarget);
    } else if (this.mode === 'workshop') {
      this.zones.setVisible(false);
      this.yard.updateCamera(this.camera, dt);
      this.env.follow(this.yard.focus);
    } else if (this.mode === 'ducks') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.ducks.updateCamera(this.camera, dt);
      this.env.follow(new THREE.Vector3(LAYOUT.ducks.x, 0, LAYOUT.ducks.z));
      const badge = `🦆 ${Math.ceil(this.ducks.secondsLeft)} s left · ${this.ducks.score} points · ${this.ducks.hits} ducks down`;
      if (badge !== this.ducksBadge) this.ui.score((this.ducksBadge = badge));
    } else if (this.mode === 'striker') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      const s = new THREE.Vector3(LAYOUT.striker.x, 0, LAYOUT.striker.z);
      this.camPos.lerp(s.clone().add(new THREE.Vector3(6, 7, 15)), 1 - Math.exp(-dt * 3));
      this.camTarget.lerp(s.clone().setY(5), 1 - Math.exp(-dt * 3));
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.env.follow(s);
    } else {
      this.camera.up.set(0, 1, 0); // the coaster cam may have rolled it
      this.updateDriveCamera(dt);
      this.env.follow(this.player.position);
      this.zones.setVisible(true);
      this.updateZones(t);
    }

    if (this.debugCam) {
      this.camera.position.copy(this.debugCam.pos);
      this.camera.lookAt(this.debugCam.look);
    }

    // grass/LOD focus: what the camera is looking at while driving, the camera itself on rides
    if (this.mode === 'drive' && !this.debugCam) this.focus.copy(this.camTarget);
    else this.focus.copy(this.camera.position);
    this.env.update(t, this.focus);
    this.player.setNightGlow(this.env.night);
    this.crowd?.setNight(this.env.night);
    this.timeControl?.update();

    if (this.adaptive.update(dt)) {
      this.renderer.setPixelRatio(this.quality.dpr * this.adaptive.scale);
      this.resize();
    }
    // a picture of the coaster for staff, taken just before the frame covers it
    if (this.mode === 'workshop') this.yard.takeSnapshot(this.scene);
    this.post.render(dt);
  }

  private updateMinimap(dt: number) {
    const q = this.player.group.quaternion;
    // yaw from the quaternion (the visitor only ever turns about y); in the air the map follows the
    // drone, on the circuit your kart
    const flying = this.mode === 'drone';
    const racing = this.mode === 'race';
    const trailing = this.mode === 'trail';
    const heading = flying
      ? this.drone.yaw
      : racing
        ? this.speedway.yaw
        : trailing
          ? this.trail.yaw
          : Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    const p = flying ? this.drone.position : racing ? this.speedway.position : trailing ? this.trail.position : this.player.position;
    const visitor = { x: p.x, z: p.z, heading };
    const karts = this.speedway.markers;
    const trains = [
      { x: this.stack.trainPosition.x, z: this.stack.trainPosition.z, color: PALETTE.mustard },
      { x: this.falcon.trainPosition.x, z: this.falcon.trainPosition.z, color: PALETTE.teal },
      // Creators' Valley's trains, in their first car's colour
      ...this.valley.coasters.map((r) => ({ x: r.coaster.trainPosition.x, z: r.coaster.trainPosition.z, color: r.detail.data.colors.cars[0] })),
      // the rivals (and, unless it's yours, the candy-red kart)
      ...(racing ? karts.slice(1) : karts),
      // the trail's demo buggy (yours is the arrow)
      ...(trailing ? [] : [this.trail.marker]),
    ];
    this.minimap.update(visitor, trains);
    this.worldMap.update(dt, visitor, trains);
  }

  /** One shared set of coaster sounds: the ride you're on, otherwise the nearest ghost train. */
  private updateCoasterAudio() {
    if (this.mode === 'coaster') {
      const c = this.ride;
      this.sfx.setCoaster(Math.min(1, c.speed / (c === this.falcon ? 60 : 30)), c.launching, true);
      return;
    }
    if (this.mode === 'ship') {
      this.sfx.setCoaster(this.ship.speed01, false, true);
      return;
    }
    let best = 0;
    let launching = false;
    for (const c of [this.stack, this.falcon, ...this.valley.coasters.map((r) => r.coaster)]) {
      const near = Math.max(0, 1 - c.trainPosition.distanceTo(this.camera.position) / 90);
      const level = Math.min(1, c.speed / 30) * near;
      if (level > best) {
        best = level;
        launching = c.launching && near > 0.4;
      }
    }
    this.sfx.setCoaster(best, launching, false);
  }

  /** Dev-only helpers: ?cam=x,y,z,lx,ly,lz pins the camera; window.__game for scripting. */
  private setupDebug() {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __game: Game }).__game = this;
    const hour = new URLSearchParams(location.search).get('hour');
    if (hour) {
      this.env.timeMode = 'paused';
      this.env.setHour(Number(hour));
    }
    const cam = new URLSearchParams(location.search).get('cam');
    if (cam) {
      const n = cam.split(',').map(Number);
      this.debugCam = { pos: new THREE.Vector3(n[0], n[1], n[2]), look: new THREE.Vector3(n[3], n[4], n[5]) };
    }
  }

  /** Dev helper used by screenshot scripts. */
  debugAction(zone: ZoneId) {
    const z = ZONES[zone];
    this.player.reset(z.x, z.z, z.heading);
    this.zones.update(this.player.position, this.time.t);
    this.onAction();
  }

  private updateZones(t: number) {
    this.showIdeaNews();
    const zone = this.zones.update(this.player.position, t);
    this.worldMap.setNear(zone);
    if (zone) {
      const z = ZONES[zone];
      // every attraction shows its price; guests are told up front it takes an account (the 3D
      // labels stay as they are)
      const crates = this.round?.ride === 'crates';
      const action =
        this.boarding === zone
          ? 'Punching your ticket…'
          : crates
            ? zone === 'crates'
              ? 'Smash them!'
              : 'Finish your Crate Smash round first'
            : isAttraction(zone)
              ? zoneAction(zone)
              : z.action;
      this.museumStop = -1;
      this.ui.prompt(`${zone}:${action}`, z.title, action);
      if (zone === 'crates' && this.panelZone !== 'crates' && !this.cratesDismissed) this.showZonePanel('crates');
      // the trail's card (today's leaderboard) opens by itself in its ring, unless something else is showing
      if (zone === 'trail' && this.panelZone !== 'trail' && !this.trailDismissed && !this.ui.panelOpenKey && !this.boarding && !this.round) this.showZonePanel('trail');
    } else {
      // in the museum, each frame offers a closer look from the spot in front of it
      this.museumStop = this.museum.stopAt(this.player.position);
      const stop = STOPS[this.museumStop];
      if (stop) {
        const title = stop.kind === 'exhibit' ? stop.exhibit.title : stop.kind === 'toolbox' ? 'The Toolbox' : 'Career Museum';
        this.ui.prompt(`museum-${this.museumStop}`, title, 'Look closer');
      } else this.ui.prompt('', '', '');
    }
    if (zone !== 'crates') this.cratesDismissed = false;
    if (zone !== 'trail') this.trailDismissed = false;

    // close a zone's panel once you walk well away from it
    if (this.panelZone) {
      const z = ZONES[this.panelZone];
      if (Math.hypot(this.player.position.x - z.x, this.player.position.z - z.z) > 28) {
        this.ui.hidePanel();
        this.panelZone = null;
      }
    }
    // the crates round's clock and score; no badge otherwise
    if (this.round?.ride === 'crates') {
      const badge = `🥫 ${Math.ceil(this.crates.secondsLeft)} s left · ${this.crates.score} points · ${this.crates.knockedCount} / ${this.crates.total} crates`;
      if (badge !== this.cratesBadge) this.ui.score((this.cratesBadge = badge));
    }
  }
}
