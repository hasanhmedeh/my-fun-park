import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { Sfx } from './audio';
import { Player } from './player';
import { Crowd } from './crowd/crowd';
import { downloadPeople, PEOPLE_URL, PeopleFactory } from './crowd/people-factory';
import type { PersonRig } from './crowd/person-rig';
import { lookFromVisitor, type Look } from './crowd/looks';
import type { VisitorLook } from './crowd/people-manifest';
import { defaultLook, visitorLook } from './visitor-look';
import { Customiser, customiserPeople } from './customiser';
import { ChangingRoom } from './attractions/changing-room';
import { DOG_URLS, DogFactory } from './crowd/pets';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Ctx } from './context';
import { Environment } from './environment';
import { Input } from './input';
import { DISTRICTS, FALCON_STATION, FOOTPRINTS, LAYOUT, PLAZAS, rideTitle, setPlotTitle, ZONES, type ZoneId } from './layout';
import { NAME_COLORS, physicsWord } from './letters';
import { PALETTE } from './textures';
import { escapeHtml, UI } from './ui';
import { Zones } from './zones';
import { Wayfinding } from './wayfinding';
import { perks } from './perks';
import { Shop, VENDOR_AVATAR, vendorLook } from './shop';
import { Ideas } from './ideas';
import { Gallery } from './gallery';
import { Wardrobe } from './souvenirs';
import { Minimap, setPlotPlace } from './minimap';
import { WorldMap } from './world-map';
import { Trackside } from './trackside';
import { TimeControl } from './time-control';
import { Post } from './post';
import { AdaptiveResolution, detectQuality, loadQualityChoice, TIERS, type Quality, type Tier } from './quality';
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
import { AIRFIELDS } from '../aviation/airports';
// the airport, the A320neo and Palm Cay load behind the fair (flight/world-kit.ts): types only here
import type { Traffic } from '../aviation/traffic';
import type { Airfield } from './airport/airfield';
import type { Airside } from './airport/airside';
import type { HomeTerminal } from './airport/terminal';
import type { Landside } from './airport/landside';
import type { SkyLink, SkyLinkRide } from './airport/skylink';
import type { PalmCay } from './island/island';
import type { IslandTerminal } from './island/island-terminal';
import type { JetSki } from './attractions/island/jetski';
import type { Slides } from './attractions/island/slides';
import type { Cannons } from './attractions/island/cannons';
import type { Volley } from './attractions/island/volley';
import type { Travellers } from './crowd/travellers';
import type { Flight } from './attractions/flight';
/** The airport and island code, loaded on its own (flight/world-kit.ts). */
type WorldKit = typeof import('./flight/world-kit');
import { PARK, canTravel, registerWalkAreas, REGION_INFO, ZONE_REGION } from './layout';
import { regionAt, SKYLINK, type Region } from './geo';
import { FOOT_VIEW } from './minimap';
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
/**
 * While dressing after dark the visitor glows this much more than on their night walks (the
 * customiser's preview level), so the colours being chosen can be seen against the lit room.
 */
const DRESSING_GLOW = 1.35;
/**
 * The airport's and Palm Cay's people load on the first trip out: as the visitor comes this close
 * to the SkyLink's park station (its hall is about 20 × 24 m), or anywhere south of this line (the
 * airport's side of the coast, past the fair's lawn).
 */
const TRIP_STATION_M = 16;
const TRIP_SOUTH_Z = 150;

/**
 * The quality tier when it can be known before the renderer exists, for the people's download
 * (it starts first thing, and the low tiers fetch fewer of the park's avatars): a forced or saved
 * choice, or a phone with fewer than 8 cores, which detection always puts on 'low'. Otherwise
 * undefined: everything is fetched, and the factory lets go of what the tier doesn't keep.
 */
function earlyTier(mobile: boolean): Tier | undefined {
  const forced = new URLSearchParams(location.search).get('quality');
  if (forced && (TIERS as string[]).includes(forced)) return forced as Tier;
  const choice = loadQualityChoice();
  if (choice !== 'auto') return choice;
  if (mobile && (navigator.hardwareConcurrency ?? 4) < 8) return 'low';
  return undefined;
}

type Mode =
  | 'drive'
  | 'coaster'
  | 'rocket'
  | 'striker'
  | 'ducks'
  | 'wheel'
  | 'drone'
  | 'flip'
  | 'ship'
  | 'race'
  | 'trail'
  | 'shop'
  | 'ideas'
  | 'museum'
  | 'workshop'
  | 'flight'
  | 'jetski'
  | 'slides'
  | 'cannons'
  | 'volley'
  | 'skylink'
  | 'dressing';

/** The SkyLink ride lasts about 80 s door to door; skipping it runs the rest of it in steps this long. */
const SKYLINK_SKIP_DT = 0.1;

/**
 * cannon-es's sweep and prune, made to scale with the airport's and the island's colliders. The
 * stock one skips a pair that can't collide (two static bodies, say) before it checks whether the
 * sweep has passed the body, so behind a static body it walks the whole rest of the list: with the
 * ~2,500 static colliders the fair, the terminals and Palm Cay have, that was ~3 M pairs a substep
 * (≈30 ms a frame at the park entrance). Here the bound is checked first (the list is sorted on the
 * same key the bound uses, the centre minus the bounding radius, so stopping there is exact), and
 * the axis is the one the bodies spread along most (z: the fair, the airport and the island lie
 * north to south), picked once the world is built (Game.build calls autoDetectAxis).
 */
class SweepBroadphase extends CANNON.SAPBroadphase {
  override collisionPairs(_world: CANNON.World, p1: CANNON.Body[], p2: CANNON.Body[]) {
    const list = this.axisList;
    const ax = this.axisIndex;
    const n = list.length;
    if (this.dirty) {
      this.sortList();
      this.dirty = false;
    }
    for (let i = 0; i !== n; i++) {
      const bi = list[i];
      const hi = SweepBroadphase.low(bi, ax) + 2 * bi.boundingRadius;
      for (let j = i + 1; j < n; j++) {
        const bj = list[j];
        if (SweepBroadphase.low(bj, ax) >= hi) break;
        if (this.needBroadphaseCollision(bi, bj)) this.intersectionTest(bi, bj, p1, p2);
      }
    }
  }

  override sortList() {
    const list = this.axisList;
    const ax = this.axisIndex;
    for (const b of list) if (b.aabbNeedsUpdate) b.updateAABB();
    // insertion sort: the order barely changes from one step to the next
    for (let i = 1; i < list.length; i++) {
      const b = list[i];
      const k = SweepBroadphase.low(b, ax);
      let j = i - 1;
      while (j >= 0 && SweepBroadphase.low(list[j], ax) > k) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = b;
    }
  }

  /** Where a body starts along the axis (its centre minus its bounding radius, as checkBounds reads it). */
  private static low(b: CANNON.Body, ax: 0 | 1 | 2) {
    return (ax === 0 ? b.position.x : ax === 1 ? b.position.y : b.position.z) - b.boundingRadius;
  }
}
/** Beyond this far from the fair (the camera, in flight) the park's own scenery isn't drawn. */
const FAIR_DRAW_M = 14000;
/** The player's collision sphere sits this high over the floor (player.ts BODY_R). */
const BODY_R = 0.42;
/** The modes the minimap shows in (it's the visitor's, or their vehicle's, map). */
const MAP_MODES: ReadonlySet<Mode> = new Set<Mode>(['drive', 'drone', 'race', 'trail', 'flight', 'jetski', 'slides', 'skylink']);

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** What the "Press E" prompt offers at an attraction: its price, or why it can't be played right now. */
function zoneAction(id: AttractionId, zone: ZoneId = id) {
  const z = ZONES[zone];
  const price = `${session.cost(id)} 🎟️`;
  const closed = !session.parkOpen || session.maintenance(id) !== undefined;
  if (closed && session.isStaff) return `🎩 Staff test · ${price}`;
  if (!session.parkOpen) return '🚧 The park is closed';
  if (closed) return '🚧 Under maintenance';
  return `${session.user ? z.action : 'Sign up for tickets'} · ${price}`;
}

/**
 * The world-space bounds of a group's fixed scenery on its own landmass, for culling the group
 * wholesale (Game.cullAirportGroups), padded by 60 m. Skinned people are left out (they walk about,
 * or are parked hidden at the origin; their bind-pose boxes say nothing), an instanced pool counts
 * only its live instances (a zero-scaled one collapses to the origin), and
 * a box that reaches off the group's landmass (a rider parked at the origin, a Points cloud at 0)
 * is dropped, so one stray child can't stretch Palm Cay's box 40 km north over the coast.
 */
function staticBounds(group: THREE.Object3D, region: Region): THREE.Box3 {
  const box = new THREE.Box3();
  const b = new THREE.Box3();
  const one = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const onLand = (bb: THREE.Box3) => !bb.isEmpty() && (region === 'island' ? bb.min.z > 20000 : bb.max.z < 20000);
  group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const geo = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geo || !(mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    if (!geo.boundingBox || geo.boundingBox.isEmpty()) return;
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh) {
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m4);
        if (Math.abs(m4.determinant()) < 1e-9) continue;
        one.copy(geo.boundingBox).applyMatrix4(m4.premultiply(im.matrixWorld));
        if (onLand(one)) box.union(one);
      }
      return;
    }
    b.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
    if (onLand(b)) box.union(b);
  });
  return box.isEmpty() ? box : box.expandByScalar(60);
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
  /** The flight just flown ended in a crash or a ditching (its report closed the round, not completed). */
  private flightFailed = false;
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
  /** The people's models: the visitor, Rosa, the crowd, and the airport's and the island's once asked for. */
  private people: PeopleFactory | null = null;
  /** The visitor's look as worn now (saved, or being tried on in the customiser). */
  private wornLook: VisitorLook | null = null;
  /** Counts changes to the visitor's look: a person still downloading for an earlier change isn't put on (the latest wins). */
  private dressSeq = 0;
  /** The visitor's Look, one object kept up to date in place (the jet-skis compare it at each start). */
  private readonly dressed = {} as Look;
  /** No saved look (or its person is no longer offered): the customiser opens as the visitor comes in. */
  private firstLook = false;
  /** The changing room by the booth, and the customiser it (and a first visit) opens. */
  private room!: ChangingRoom;
  private customiser: Customiser | null = null;
  /** While dressing: the camera's spot and where it looks (the room's shot, or in front of the visitor on a first visit). */
  private dressCam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), inRoom: true };
  /** The airport's and Palm Cay's people have been asked for (on the first trip out). */
  private tripPeople = false;
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

  // Funfair International, the A320neo and Palm Cay
  private airfields!: Record<Region, Airfield>;
  private homeTerminal!: HomeTerminal;
  private landside!: Landside;
  private skylink!: SkyLink;
  private airside!: Record<Region, Airside>;
  private traffic!: Traffic;
  private palmCay!: PalmCay;
  private islandTerminal!: IslandTerminal;
  private travellers: Travellers | null = null;
  private flight!: Flight;
  /** Palm Cay's scenery, its terminal and its four games, gathered at the origin (shown with the island). */
  private readonly islandRoot = new THREE.Group();
  /** The island games' touch camera button (phones only). */
  private islandCamBtn: HTMLButtonElement | null = null;
  /** The airport and island code (flight/world-kit.ts), once its chunk is in: from the airport's loading step on. */
  private kit!: WorldKit;
  private jetski!: JetSki;
  private slides!: Slides;
  private cannons!: Cannons;
  private volley!: Volley;
  /** The Pirate Cannons' HUD badge, as last drawn. */
  private cannonsBadge = '';
  /** The landmass the visitor is on (or flying over): the far one's people and games sleep. */
  private region: Region = 'home';
  /** The SkyLink ride the visitor is on, and which station it ends at. */
  private skyRide: { ride: SkyLinkRide; to: 'skylink' | 'skylinkBack'; aboard: boolean; yaw: number } | null = null;
  /** The fair's own scenery (everything built between the environment and the airport), hidden when the camera is far away. */
  private fairObjects: THREE.Object3D[] = [];
  private fairHidden: boolean[] | null = null;
  /** The night level the airport and the island were last told (they're told again when it moves). */
  private worldNight = -1;
  /** The last round's results are on their way to the server: the next round waits for them (one open round per member). */
  private finishing: Promise<unknown> | null = null;

  constructor(private container: HTMLElement) {}

  /** Builds the whole fair in small steps so the progress bar can update. */
  async build(onProgress: (p: number) => void) {
    // the people first of all (no renderer needed): the manifest, the clips, the park's crowd, and
    // Rosa's and the visitor's own close-up files, downloading while the world is built
    const saved = this.devLook() ?? visitorLook.get();
    const dl = downloadPeople({ sets: ['park'], hero: saved ? [VENDOR_AVATAR, saved.avatar] : [VENDOR_AVATAR], tier: earlyTier(this.mobile) });
    // who the visitor is: their saved look, or (none yet, or that person is no longer offered) a
    // default, picked as soon as the manifest is in so their file downloads with the rest
    const firstLook = dl.manifest.then((m) => {
      const playable = m.avatars.filter((a) => a.roles.includes('playable') && a.files.hero);
      if (saved && playable.some((a) => a.id === saved.avatar)) return { look: saved, first: false };
      const look = defaultLook(session.user?.gender, playable);
      if (!look) throw new Error('people: no playable avatars in the manifest');
      const file = playable.find((a) => a.id === look.avatar)?.files.hero;
      if (file) void dl.file(file).catch(() => undefined);
      return { look, first: true };
    });
    firstLook.catch(() => undefined);
    // (parsed from the renderer's step on: see the people's step)
    let peopleReady: Promise<PeopleFactory> | null = null;
    const loader = new GLTFLoader();
    const dogModels = Promise.all([loader.loadAsync(DOG_URLS.shiba), loader.loadAsync(DOG_URLS.husky)]).catch(() => null);
    // the airport's, the aircraft's and Palm Cay's code: its own chunk, downloading while the fair builds
    const worldKit = import('./flight/world-kit');
    // (a failure surfaces at the airport's step, which awaits it: not as an unhandled rejection before)
    worldKit.catch(() => undefined);
    const steps: [number, () => void | Promise<void>][] = [];
    const step = (w: number, fn: () => void | Promise<void>) => steps.push([w, fn]);

    step(1, () => {
      this.setupRenderer();
      // the people's files are parsed as they arrive (the KTX2 transcoder needs the renderer)
      peopleReady = PeopleFactory.create(this.renderer, dl, { tier: this.quality.tier });
      peopleReady.catch(() => undefined);
    });
    step(1, () => this.setupPhysics());
    // (everything the fair builds from here to the airport is its own scenery: see fairObjects)
    let fairFrom = 0;
    step(3, () => {
      this.env = new Environment(this.ctx, this.quality);
      fairFrom = this.scene.children.length;
      // the post pipeline (the flight switches its AO off at height)
      this.post = new Post(this.renderer, this.scene, this.camera, this.quality);
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
      // the changing room beside it (before the crowd, which reads the colliders once), whose ring
      // is the one ZONES has for it
      this.room = new ChangingRoom(this.ctx);
      this.updatables.push(this.room);
      Object.assign(ZONES.changing, this.room.zone);
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
      this.fairObjects = this.scene.children.slice(fairFrom);
    });
    // Funfair International on the south coast, the SkyLink out to it, and Palm Cay 40 km south
    step(3, async () => {
      this.kit = await worldKit;
      const { Airfield } = this.kit;
      this.airfields = { home: new Airfield(this.ctx, AIRFIELDS.home), island: new Airfield(this.ctx, AIRFIELDS.island) };
      this.scene.add(this.airfields.home.group, this.airfields.island.group);
    });
    step(3, () => {
      const { HomeTerminal, Landside, SkyLink } = this.kit;
      this.homeTerminal = new HomeTerminal(this.ctx);
      this.landside = new Landside(this.ctx);
      this.skylink = new SkyLink(this.ctx);
      this.scene.add(this.homeTerminal.group, this.landside.group, this.skylink.group);
      registerWalkAreas('home', this.homeTerminal.walk, 'terminal');
      registerWalkAreas('home', this.skylink.walk, 'skylink');
    });
    step(2, () => {
      const { Airside, reservedStands } = this.kit;
      this.airside = {
        home: new Airside(this.ctx, AIRFIELDS.home, { reserved: reservedStands('home') }),
        island: new Airside(this.ctx, AIRFIELDS.island, { reserved: reservedStands('island') }),
      };
      this.scene.add(this.airside.home.group, this.airside.island.group);
      // the parked fleet's doors are on their bridges
      for (const id of this.airside.home.parkedStands) this.homeTerminal.bridges[id]?.dock(true);
    });
    step(2, () => {
      // the AI fleet's geometry and paint, built now rather than on the first arrival
      const { Traffic, createA320, LIVERIES, warmA320 } = this.kit;
      warmA320(['ai', 'parked'], Object.values(LIVERIES));
      this.traffic = new Traffic(this.ctx, {
        createPlane: (o) => createA320(o),
        onStand: (r, id, state) => {
          // the player's stand is the flight's to dock and undock
          if (id === AIRFIELDS[r].playerStand) return;
          if (r === 'home') this.homeTerminal.bridges[id]?.dock(state === 'arrived');
          this.airside[r].setStandService(id, state === 'arrived');
        },
      });
      this.scene.add(this.traffic.group);
    });
    // (Palm Cay, its terminal and its games: gathered under islandRoot once built)
    let isleFrom = 0;
    step(3, () => {
      isleFrom = this.scene.children.length;
      const { PalmCay, IslandTerminal, PALM_CAY_WALK } = this.kit;
      this.palmCay = new PalmCay(this.ctx);
      this.islandTerminal = new IslandTerminal(this.ctx);
      this.scene.add(this.palmCay.group, this.islandTerminal.group);
      registerWalkAreas('island', this.islandTerminal.walk, 'island-terminal');
      registerWalkAreas('island', PALM_CAY_WALK, 'palm-cay');
    });
    step(3, () => {
      // Palm Cay's four games (each adds itself to the scene)
      const { JetSki, Slides, Cannons, Volley, JETSKI_WALK } = this.kit;
      this.jetski = new JetSki(this.ctx);
      this.slides = new Slides(this.ctx);
      this.cannons = new Cannons(this.ctx);
      this.volley = new Volley(this.ctx);
      this.updatables.push(this.jetski, this.slides, this.cannons, this.volley);
      registerWalkAreas('island', JETSKI_WALK, 'jetski');
      // until the visitor gets there, the island sleeps
      for (const g of [this.jetski, this.slides, this.cannons, this.volley]) g.setAwake(false);
      // everything the island added straight to the scene (the games' docks, courts, forts, ships,
      // wakes, slides…) under one group at the origin, so the mainland can switch it off in one go
      // (updateAirports): world transforms don't change, and nothing here takes itself out of the scene
      const isle = this.scene.children.slice(isleFrom);
      this.islandRoot.add(...isle);
      // but no lights: islandRoot is switched on and off, and a change in the scene's light count
      // recompiles every lit shader in view (a long freeze at the first departure). The cannons'
      // flash light stays in the scene, always counted (at intensity 0 between shots), as it was
      // built to; islandRoot sits at the origin, so its world position doesn't change.
      const lights: THREE.Object3D[] = [];
      this.islandRoot.traverse((o) => {
        if ((o as THREE.Light).isLight) lights.push(o);
      });
      for (const l of lights) this.scene.attach(l);
      this.scene.add(this.islandRoot);
    });
    step(1, () => {
      // the districts' signs and the fingerposts (once everything they keep clear of is standing)
      new Wayfinding(this.ctx);
    });
    step(1, async () => {
      this.zones = new Zones(this.ctx);
      const people = await peopleReady!;
      this.people = people;
      // the visitor, as they made themselves (or as the customiser will first offer them)
      const { look, first } = await firstLook;
      this.firstLook = first;
      await people.load(look.avatar, { hero: true });
      this.wornLook = look;
      this.player = new Player(this.ctx, people.create(lookFromVisitor(look, people.spec(look.avatar)!)));
      Object.assign(this.dressed, this.player.rig.look);
      // Rosa behind the booth's counter, and what the visitor wears from her shop
      this.booth.setVendor(people.create(vendorLook(people.spec(VENDOR_AVATAR)!)));
      this.wardrobe = new Wardrobe(this.player.rig, this.scene);
      // the airport's and the island's travellers (they map the colliders, so everything stands by now)
      const { Travellers, Flight, flightGround } = this.kit;
      this.travellers = new Travellers(this.ctx, people, {
        home: this.homeTerminal,
        island: this.islandTerminal,
        palmCay: this.palmCay,
        shadows: this.quality.shadows && this.quality.tier !== 'low',
        tier: this.quality.tier,
      });
      // the island's players and riders: the visitor's own look, as it is when each round starts
      this.volley.setPeople(people, () => this.player.rig.look);
      this.jetski.setPeople(people, this.dressed);
      // the flight, with the world's ground under it: the terrain and the sea, the airfields' pavement
      this.flight = new Flight(this.ctx, {
        env: this.env,
        post: this.post,
        airfields: this.airfields,
        homeTerminal: this.homeTerminal,
        islandTerminal: this.islandTerminal,
        airside: this.airside,
        traffic: this.traffic,
        travellers: this.travellers,
        ground: flightGround({ home: (x, z) => this.airfields.home.surfaceAt(x, z), island: (x, z) => this.airfields.island.surfaceAt(x, z) }),
      });
      this.updatables.push(this.flight);
      // both terminals' boards list Funfair Air's day from the booking itself, at the card's time
      this.paintFlightBoards();
      this.flight.onTimeOfDay = () => this.paintFlightBoards();
      this.wire();
      // the crowd: queues, riders, families, kids and dogs (fewer on modest hardware)
      const dogs = await dogModels;
      const crowdFrom = this.scene.children.length;
      const crowd = new Crowd(this.ctx, people, dogs && new DogFactory({ shiba: dogs[0], husky: dogs[1] }), [this.stack, this.falcon], this.striker, {
        count: CROWD_SIZE[this.quality.tier],
        shadows: this.quality.shadows && this.quality.tier !== 'low',
        // (nobody in the crowd is the visitor's double)
        exclude: [this.player.rig.look.avatar],
      });
      crowd.setPlayer(this.player);
      this.player.onWave = () => crowd.waveBack(this.player.position);
      this.player.onKick = () => crowd.shove(this.player.position, this.player.forward);
      this.updatables.push(crowd); // after the coasters, so riders sit where their seats are now
      this.crowd = crowd;
      this.fairObjects.push(...this.scene.children.slice(crowdFrom));
      this.setupDressing();
    });
    step(2, () => {
      // warm up: upload textures/compile shaders before the user enters
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
    // every collider is in: sweep along the axis they spread along most (SweepBroadphase)
    (this.world.broadphase as SweepBroadphase).autoDetectAxis();
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
        if (this.mode === 'flight') return this.flight.zoomBy(e.deltaY);
        if (this.mode !== 'drive' && this.mode !== 'skylink') return;
        this.zoom = THREE.MathUtils.clamp(this.zoom + e.deltaY * 0.001, 0.55, 1.7);
      },
      { passive: true },
    );
    // drag the view (mouse or finger) to look around the visitor
    const canvas = this.renderer.domElement;
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if ((this.mode !== 'drive' && this.mode !== 'drone' && this.mode !== 'flight' && this.mode !== 'skylink') || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const k = 4 / Math.max(1, canvas.clientHeight);
      if (this.mode === 'drone') this.drone.look((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
      else if (this.mode === 'flight') this.flight.look((e.clientX - drag.x) * k, (e.clientY - drag.y) * k);
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
    w.broadphase = new SweepBroadphase(w);
    // which pairs touched this step and the last: a sparse map, not cannon's default N²/2 array,
    // which with the airport's and the island's ~2,500 colliders is 3.3 M entries cleared every
    // substep (≈40 ms a frame in the park). The two have the same interface.
    w.collisionMatrix = new CANNON.ObjectCollisionMatrix() as unknown as CANNON.ArrayCollisionMatrix;
    w.collisionMatrixPrevious = new CANNON.ObjectCollisionMatrix() as unknown as CANNON.ArrayCollisionMatrix;
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
      // (back to this landmass's own front door: the entrance at the fair, the arrivals hall on Palm Cay)
      if (this.mode === 'drive') this.teleport(this.region === 'island' ? REGION_INFO.island.arrival : 'entrance');
      else if (this.mode === 'race') this.speedway.rescue();
      else if (this.mode === 'trail') this.trail.rescue();
      else if (this.mode === 'jetski') this.jetski.rescue();
    });
    this.input.on('restart', () => this.mode === 'trail' && this.trail.restart());
    this.input.on('honk', () => {
      if (this.mode === 'drive') this.player.wave();
      else if (this.mode === 'drone') this.drone.flyHome();
    });
    // Space rolls on foot, climbs in the drone, drifts a kart or the buggy and hops the jet-ski, and
    // does nothing in the A320's cockpit; on rides and the striker it keeps working as the action key
    this.input.on('roll', () => {
      if (this.mode === 'drive') this.player.roll();
      else if (this.mode !== 'drone' && this.mode !== 'race' && this.mode !== 'trail' && this.mode !== 'jetski' && this.mode !== 'flight') this.onAction();
    });
    this.input.on('kick', () => this.mode === 'drive' && this.player.kick());
    // on touch, the island games' camera (C on a keyboard): their E is the game's own action
    if (this.mobile) {
      const cam = document.createElement('button');
      cam.type = 'button';
      cam.className = 'isl-cam-btn';
      cam.textContent = '🎥';
      cam.setAttribute('aria-label', 'Change the camera');
      cam.hidden = true;
      cam.addEventListener('pointerdown', (e) => {
        // (not through to the canvas, where the cannons and the volley aim and fire)
        e.preventDefault();
        e.stopPropagation();
        if (this.mode === 'jetski') this.jetski.cycleCamera();
        else if (this.mode === 'slides') this.slides.cycleCamera();
        else if (this.mode === 'cannons') this.cannons.cycleCamera();
        else if (this.mode === 'volley') this.volley.cycleCamera();
      });
      document.getElementById('touch')!.append(cam);
      this.islandCamBtn = cam;
    }
    this.input.on('camera', () => {
      if (this.mode === 'coaster') this.ride.cycleCamera();
      else if (this.mode === 'wheel') this.wheel.cycleCamera();
      else if (this.mode === 'drone') this.drone.cycleCamera();
      else if (this.mode === 'flip') this.flip.cycleCamera();
      else if (this.mode === 'ship') this.ship.cycleCamera();
      else if (this.mode === 'race') this.speedway.cycleCamera();
      else if (this.mode === 'trail') this.trail.cycleCamera();
      else if (this.mode === 'flight') this.flight.cycleCamera();
      else if (this.mode === 'jetski') this.jetski.cycleCamera();
      else if (this.mode === 'slides') this.slides.cycleCamera();
      else if (this.mode === 'cannons') this.cannons.cycleCamera();
      else if (this.mode === 'volley') this.volley.cycleCamera();
    });
    this.flight.input = this.input;
    this.jetski.input = this.input;
    this.slides.input = this.input;
    this.cannons.input = this.input;
    this.volley.input = this.input;
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
      else if (b.dataset.goto === 'mainland') this.returnToMainland();
      else if (b.dataset.goto === 'desk') this.goToFlightDesk();
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
      const done = (round.ride === 'trail' && this.trail.crossedLine) || this.roundRanToEnd();
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
    // (on either landmass, on foot: not from the cockpit, nor from a seat at a game)
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
    this.flight.onFinish = () => this.endRide();
    this.jetski.onFinish = () => this.endRide();
    this.slides.onFinish = () => this.endRide();
    this.cannons.onFinish = () => this.endRide();
    this.volley.onFinish = () => this.endRide();
    // the first shot puts the Pirate Cannons' card away too
    this.cannons.onShot = () => {
      if (this.ui.panelOpenKey === 'cannons-play') this.ui.hidePanel();
    };
    // each attraction ends on its own after one round: back to walking, with the results
    for (const a of [this.stack, this.falcon, this.rocket, this.wheel, this.flip, this.ship, this.speedway, this.trail, this.striker, this.crates, this.ducks, this.jetski, this.slides, this.cannons, this.volley])
      a.onComplete = () => this.leave(true);
    // a flight ends gate to gate (completed), or after a failure's aftermath and its report (not)
    this.flight.onComplete = () => {
      // the report closes the round: a crash or a ditching isn't a completed flight
      this.flightFailed = !this.flight.completed;
      this.leave(this.flight.completed);
    };
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
    // no look of their own yet: the customiser opens on the visitor where they stand, to make one
    // (it covers the welcome below until it closes; after the office's link, it waits for next time)
    if (this.firstLook && !inspect && this.mode === 'drive' && this.customiser) {
      this.firstLook = false;
      this.startDressing(false);
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
      changing: '👕 <strong>Changing room</strong> — beside the booth: be someone else, dye your clothes or try another height. Free, no ticket',
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
      skylink: '🚝 <strong>SkyLink</strong> — the driverless train from the south gate to the airport, along an elevated guideway. Free, no ticket',
      skylinkBack: '🚝 <strong>SkyLink</strong> — back from the airport to the fair. Free, no ticket',
      airport: '🛫 <strong>Funfair International</strong> — the airport on the south coast: check-in, security, the shops and Gate 3',
      flight: `✈️ <strong>Funfair Air FA101</strong> — at Gate 3: fly the A320neo yourself, 40 km south to Palm Cay (pushback, taxi, take-off, landing) ${cost('flight')}`,
      flightBack: `✈️ <strong>Funfair Air FA102</strong> — the flight home from Palm Cay ${cost('flight')}`,
      palmcay: '🌴 <strong>Palm Cay</strong> — the tropical island at the end of the flight: beaches, palms and four games',
      jetski: `🌊 <strong>Jet-Ski Race</strong> — three laps of a buoy course in the lagoon, against the island's riders ${cost('jetski')}`,
      slides: `🛝 <strong>Splash Tower</strong> — climb the 24 m tower and pick a slide: the Kamikaze drop, the Typhoon tube or the Lazy Loop ${cost('slides')}`,
      cannons: `💣 <strong>Pirate Cannons</strong> — man the old fort's guns and sink the pirate ships against the clock ${cost('cannons')}`,
      volley: `🏐 <strong>Beach Volley</strong> — ten serves with an island partner against two locals: time your serves, digs and spikes ${cost('volley')}`,
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
      user
        ? `<p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-goto="booth">${this.awayFromBooth ? 'Get tickets at the fair ✈️' : 'Take me to the Ticket Booth 🎟️'}</button></p>`
        : accountButtons()
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
    if (this.mode === 'flight') return this.flight.action();
    if (this.mode === 'jetski') return this.jetski.action();
    if (this.mode === 'slides') return this.slides.action();
    if (this.mode === 'cannons') return this.cannons.action();
    if (this.mode === 'volley') return this.volley.action();
    if (this.mode === 'skylink') return this.skipSkyLink();
    if (this.mode !== 'drive') return;
    const z = this.zones.active;
    // inside the museum, at a frame: a closer look (the tour, from there)
    if (!z) return this.museumStop >= 0 ? this.enterMuseum(this.museumStop) : undefined;
    if (z === 'museum') {
      this.enterMuseum(0);
    } else if (z === 'booth') {
      this.enterShop();
    } else if (z === 'changing') {
      this.enterChanging();
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
    } else if (z === 'flight' || z === 'flightBack') {
      // E at the gate desk shows the booking card; E again (or its Board button) boards
      if (this.panelZone === z && this.ui.panelOpenKey.startsWith('flight-offer')) this.board('flight');
      else {
        this.player.interact();
        this.showZonePanel(z);
        this.sfx.chime();
      }
    } else if (z === 'skylink' || z === 'skylinkBack') {
      this.rideSkyLink(z === 'skylink' ? 'park' : 'airport');
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
    // a member has one open round at a time: the last one (a flight that just landed, say) is closed first
    const ready = this.finishing ?? Promise.resolve();
    ready.then(() => session.board(ride)).then(
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
        this.placeVisitor(spot.x, spot.z, spot.heading);
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
      case 'flight': {
        // the leg from the desk the visitor stands at, at the hour picked on the card
        const from = regionAt(this.player.position.x, this.player.position.z);
        this.flight.booking = { from, timeOfDay: this.flight.booking?.timeOfDay ?? 'day' };
        this.ui.hidePanel();
        this.panelZone = null;
        this.startRide('flight', () => {
          // the visitor is in the captain's seat now, not at the desk
          this.player.group.visible = false;
          this.flight.start();
        });
        break;
      }
      case 'jetski':
        this.startRide('jetski', () => this.jetski.start());
        break;
      case 'slides':
        this.startRide('slides', () => this.slides.start());
        break;
      case 'cannons': {
        // the visitor steps up behind the guns (the camera is their eyes)
        this.player.interact();
        const spot = this.cannons.standSpot;
        this.placeVisitor(spot.x, spot.z, spot.heading);
        this.mode = 'cannons';
        this.player.enabled = false;
        this.player.group.visible = false;
        this.ui.rideExit(true);
        this.ui.prompt('', '', '');
        this.ui.cinematic(true);
        this.cannons.start();
        this.cannonsBadge = '';
        this.panelZone = 'cannons';
        this.ui.panel('cannons-play', this.cannons.panelHtml(this.mobile), { accent: PALETTE.mustard });
        break;
      }
      case 'volley': {
        // the visitor takes the server's spot (the game draws them as its own player)
        this.player.interact();
        const spot = this.volley.standSpot;
        this.placeVisitor(spot.x, spot.z, spot.heading);
        this.mode = 'volley';
        this.player.enabled = false;
        this.player.group.visible = false;
        this.ui.rideExit(true);
        this.ui.prompt('', '', '');
        // (the game's own HUD: the walking keys and the minimap step aside)
        this.ui.cinematic(true);
        this.volley.start();
        this.panelZone = 'volley';
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
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    const closed = !(err instanceof ApiError) || err.unavailable;
    this.sfx.beep();
    this.panelZone = zone;
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
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = zone;
    const sign = session.park?.message ?? "The park is closed right now. Come back soon: you're welcome to look around meanwhile.";
    this.ui.panel(
      `closed-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · Park closed</p><h2>🚧 The park is closed</h2><p>${escapeHtml(sign)}</p><p class="sub">No tickets are spent while the park is closed.</p>${this.strandedHtml(zone)}`,
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
    if (this.mode === 'dressing') this.leaveDressing(false);
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
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    const parkClosed = !session.parkOpen;
    const back = refunded ? (refunded === 1 ? 'its ticket is back in your wallet' : `its ${refunded} tickets are back in your wallet`) : 'it has been ended';
    // a member's coaster taken out of Creators' Valley (or swapped for a newer version) under the rider
    if (isPlot(ride) && coaster !== null && !parkClosed && session.maintenance(ride) === undefined) {
      const newer = session.creationOn(plotNumber(ride));
      const name = escapeHtml(coaster);
      this.sfx.beep();
      this.panelZone = zone;
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
    this.panelZone = zone;
    this.ui.panel(
      `${parkClosed ? 'closed' : 'maintenance'}-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${parkClosed ? 'Park closed' : 'Under maintenance'}</p><h2>🚧 ${parkClosed ? 'The park just closed' : `${escapeHtml(z.title)} just closed`}</h2><p>${escapeHtml(sign)}</p><p class="sub">Your round was stopped, and ${back}.</p>${this.strandedHtml(zone)}`,
      { accent: PALETTE.candy },
    );
  }

  /** The attraction is closed for maintenance: its sign. */
  private showMaintenance(ride: AttractionId) {
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = zone;
    const sign = session.maintenance(ride) ?? `Our crew is giving ${z.title} some care. It will be back soon: try another attraction meanwhile!`;
    this.ui.panel(
      `maintenance-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · Under maintenance</p><h2>🚧 Under maintenance</h2><p>${escapeHtml(sign)}</p><p class="sub">No tickets were spent.</p>${this.strandedHtml(zone)}`,
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
      const ride = this.panelZone === 'flightBack' ? 'flight' : this.panelZone;
      if (ride && isAttraction(ride) && open && session.maintenance(ride) === undefined) {
        this.ui.hidePanel();
        this.panelZone = null;
      }
    } else if (this.mode === 'drive' && key.startsWith('trail-board') && this.panelZone === 'trail') {
      // the trail's card keeps its leaderboard; only its button follows the gates
      this.showZonePanel('trail');
    } else if (this.mode === 'drive' && /^(gate|short|drone-offer|flight-offer|crates)-/.test(key) && !session.isStaff && !this.boarding && !this.round) {
      // closed while its offer is up (the office pushes it live): the sign replaces the offer
      // (the desk on Palm Cay sells the same flight)
      const ride = this.panelZone === 'flightBack' ? 'flight' : this.panelZone;
      if (ride && isAttraction(ride)) {
        if (!open) this.showClosed(ride);
        else if (session.maintenance(ride) !== undefined) this.showMaintenance(ride);
      }
    }
  }

  /** The zone of the desk the visitor is at for this ride: the flight is sold at Gate 3 and at the Palm Cay desk. */
  private deskZone(ride: AttractionId): ZoneId {
    return ride === 'flight' && this.region === 'island' ? 'flightBack' : ride;
  }

  /** The members-only card a guest gets at an attraction. */
  private showGate(ride: AttractionId, expired = false) {
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = zone;
    this.ui.panel(
      `gate-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${ticketsText(session.cost(ride))}</p><h2>🎟️ Members only</h2><p>${
        expired ? "Your session ran out, so you're back to being a guest. " : ''
      }Every ride and game costs tickets, and tickets come with a free account: pick up ${packText()}. Visiting the booth is always free.</p>${accountButtons(ride)}${this.strandedHtml(zone)}`,
      { accent: PALETTE.mustard },
    );
  }

  /** A member without enough tickets for this round: how many they're short, and the way to the booth. */
  private showShort(ride: AttractionId, cost: number, balance: number) {
    const zone = this.deskZone(ride);
    const z = ZONES[zone];
    this.player.interact();
    this.sfx.beep();
    this.panelZone = zone;
    const wait = session.msUntilPurchase();
    this.ui.panel(
      `short-${ride}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(z.title)} · ${ticketsText(cost)}</p><h2>Not enough tickets</h2><p>${escapeHtml(z.title)} costs <strong>${ticketsText(cost)}</strong> a round, and you have <strong>${balance}</strong>.</p>${
        wait === null ? '' : waitHtml(wait)
      }<p class="panel-actions">${
        zone === 'flightBack'
          ? this.returnHomeButton()
          : `<button class="btn btn-primary btn-small" type="button" data-goto="booth">${this.awayFromBooth ? 'Get tickets at the fair ✈️' : 'Go to the Ticket Booth 🎟️'}</button>`
      }</p>`,
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
    const at = this.zones.active === 'flightBack' ? 'flight' : this.zones.active;
    if (this.mode === 'drive' && at === ride) this.board(ride);
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
    else if (switched && key.startsWith('flight-offer') && (this.panelZone === 'flight' || this.panelZone === 'flightBack')) this.showZonePanel(this.panelZone);
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
    if (z === 'flight' || z === 'flightBack') {
      // the gate desk's booking card: the leg from here, its weather, and the hour to fly at
      const cost = session.cost('flight');
      const gate = session.user
        ? null
        : `<p class="drone-gate">🎟️ A flight costs ${ticketsText(cost)}, and tickets come free with an account. Sign up or log in, and the left seat is yours.</p>${accountButtons('flight')}`;
      const from = z === 'flightBack' ? 'island' : 'home';
      this.ui.panel(`flight-offer-${Date.now()}`, this.flight.offerHtml(from, cost, gate), { accent: PALETTE.teal });
      this.flight.wireOffer(this.ui.panelElement, () => this.board('flight'));
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
      this.placeVisitor(spot.x, spot.z, spot.heading);
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

  // ---------- The visitor's look: the customiser, the changing room ----------

  /**
   * The customiser (in the HUD), and the visitor following their look wherever it changes: Done
   * in the customiser, or a member's own look arriving as they log in.
   */
  private setupDressing() {
    const people = this.people!;
    this.customiser = new Customiser(
      {
        people: customiserPeople(people.manifest.avatars, PEOPLE_URL),
        preview: (look) => this.dressVisitor(look),
        close: (saved) => this.leaveDressing(saved),
        turn: () => this.player.face(this.player.facing + Math.PI),
      },
      this.ui.hud,
    );
    visitorLook.onChange((look) => {
      // (while the customiser is open it puts on the looks itself, and its Done ends in leaveDressing)
      if (!look || this.customiser?.isOpen || !people.spec(look.avatar)?.roles.includes('playable')) return;
      this.dressVisitor(look).catch((e: unknown) => console.warn('The Funfair: the visitor’s look could not be put on.', e));
    });
  }

  /**
   * Puts `v` on the visitor: in place when it's the same person (colours, height and build change
   * at once), or as another person once their close-up file is in (swapRig). The latest call wins:
   * someone still downloading for an earlier call isn't put on once a later call has shown
   * someone else. Rejects when the person can't be fetched (the customiser goes back to whoever
   * was shown before).
   */
  private async dressVisitor(v: VisitorLook): Promise<void> {
    const people = this.people;
    const spec = people?.spec(v.avatar);
    if (!people || !spec) throw new Error(`people: no avatar "${v.avatar}"`);
    const seq = ++this.dressSeq;
    const look = lookFromVisitor(v, spec);
    if (!this.player.rig.applyLook(look)) {
      await people.load(v.avatar, { hero: true });
      if (seq !== this.dressSeq) return;
      if (!people.has(v.avatar, true)) throw new Error(`people: ${v.avatar} could not be fetched`);
      this.swapRig(people.create(look));
    }
    this.wornLook = v;
    Object.assign(this.dressed, this.player.rig.look);
  }

  /** The visitor becomes another person: whatever holds their body (the player, their souvenirs) moves over to the new one. */
  private swapRig(rig: PersonRig) {
    const old = this.player.rig;
    this.player.setRig(rig);
    this.wardrobe?.setRig(rig);
    // nobody in the crowd may wear the visitor's new face (a guest wearing it becomes someone else)
    if (rig.look.avatar !== old.look.avatar) this.crowd?.setExclude([rig.look.avatar]);
    old.dispose();
  }

  /**
   * Steps into the changing room: the visitor stands inside facing out (behind a quick fade), the
   * camera moves in front of the cubicle, and the customiser opens beside them.
   */
  private enterChanging() {
    if (this.mode !== 'drive' || this.round || this.boarding || !this.customiser) return;
    this.ui.hidePanel();
    this.panelZone = null;
    this.ui.prompt('', '', '');
    this.player.enabled = false;
    // the shot starts from where the camera is, and glides over
    this.camPos.copy(this.camera.position);
    this.fade(() => {
      const at = this.room.standAt;
      this.placeVisitor(at.x, at.z, this.room.facing);
      this.startDressing(true);
    });
  }

  /**
   * Opens the customiser on what the visitor wears: in the changing room, or (`inRoom` false, a
   * first visit) where they stand, the camera in front of them. The game's keys wait meanwhile.
   */
  private startDressing(inRoom: boolean) {
    if (!this.customiser || !this.wornLook) return;
    this.mode = 'dressing';
    this.player.enabled = false;
    this.input.paused = true;
    this.dressCam.inRoom = inRoom;
    this.customiser.open(this.wornLook, { firstVisit: !inRoom });
    this.resize();
    // (into the room the camera glides from behind the visitor; on a first visit it starts in front
    // of them, rather than swooping over their head)
    if (!inRoom) {
      this.camPos.copy(this.dressCam.pos);
      this.camTarget.copy(this.dressCam.look);
    }
  }

  /**
   * The customiser closed: Done (`saved`: the look is in visitorLook) or Cancel (its preview has
   * just put the old look back). Back to the fair, the camera behind the visitor. A person still
   * downloading when Done is pressed changes the visitor as they land.
   */
  private leaveDressing(saved: boolean) {
    if (this.mode !== 'dressing') return;
    if (this.customiser?.isOpen) {
      // called away (the park closing): the look saved before is put back
      this.customiser.close();
      const back = visitorLook.get();
      if (back) this.dressVisitor(back).catch(() => undefined);
      // a first visit that never chose: the customiser comes back next time
      else this.firstLook = true;
    } else if (saved) {
      // (the panel may have had a change still to show when Done came)
      const look = visitorLook.get();
      if (look) this.dressVisitor(look).catch((e: unknown) => console.warn('The Funfair: the visitor’s look could not be put on.', e));
    }
    this.mode = 'drive';
    this.input.paused = false;
    this.player.enabled = this.inFair;
    this.camYaw = this.player.facing; // behind the visitor, wherever they face
    this.camPitch = 0.2;
    this.resize();
    this.sfx.chime();
  }

  /** The customiser's camera: the room's shot, or (a first visit) in front of the visitor where they stand. */
  private aimDressCam() {
    const portrait = this.camera.aspect < 0.8;
    const c = this.dressCam;
    if (c.inRoom) {
      const { pos, look } = this.room.shot(portrait);
      c.pos.copy(pos);
      c.look.copy(look);
      return;
    }
    // as the room's: a few metres in front of them (their forward is (-sin h, -cos h)), a little
    // to their right ((cos h, -sin h)), the whole visitor in frame
    const p = this.player.position;
    const h = this.player.facing;
    const floor = p.y - BODY_R;
    const d = portrait ? 5.3 : 4.2;
    const side = portrait ? 0.35 : 0.55;
    c.pos.set(p.x - Math.sin(h) * d + Math.cos(h) * side, floor + 1.6, p.z - Math.cos(h) * d - Math.sin(h) * side);
    c.look.set(p.x, floor + 1, p.z);
  }

  /** Dev only: ?look=Female_Adult_01 plays as that person in their own colours (nothing saved, no first-visit customiser). */
  private devLook(): VisitorLook | null {
    if (!import.meta.env.DEV) return null;
    const id = new URLSearchParams(location.search).get('look');
    return id ? { v: 1, avatar: id, top: null, bottom: null, shoes: null, hair: null, height: 1, build: 1 } : null;
  }

  /**
   * The airport's and Palm Cay's people, asked for once on the first trip out (they don't download
   * with the fair's): near the SkyLink's park station, aboard it, or jumping to the airport or the
   * island. The travellers and the island's games dress them as their sets arrive.
   */
  private loadTripPeople() {
    if (this.tripPeople || !this.people) return;
    this.tripPeople = true;
    for (const set of ['airport', 'island']) this.people.loadSet(set).catch((e: unknown) => console.warn(`people: the ${set} set failed to load`, e));
  }

  /** Takes the visitor to the Ticket Booth and opens its counter. */
  private goToBooth() {
    if (this.mode !== 'drive' || this.round) return;
    // the booth is at the fair: from Palm Cay the way there is the flight home (or the free seat)
    if (this.awayFromBooth) return this.showBoothAway();
    this.ui.hidePanel();
    this.panelZone = null;
    this.teleport('booth', () => this.enterShop());
  }

  /** The visitor stands across the sea from the Ticket Booth (on Palm Cay). */
  private get awayFromBooth() {
    return !canTravel(regionAt(this.player.position.x, this.player.position.z), 'booth');
  }

  /** Whether this member can book the flight home from Palm Cay right now (tickets, gates, desk). */
  private canFlyHome() {
    const balance = session.balance;
    return !!session.user && (session.parkOpen || session.isStaff) && (session.maintenance('flight') === undefined || session.isStaff) && (balance === null || balance >= session.cost('flight'));
  }

  /** On the Palm Cay desk's cards that say the flight home can't be booked: the free seat home. */
  private strandedHtml(zone: ZoneId) {
    return zone === 'flightBack' ? `<p class="panel-actions">${this.returnHomeButton()}</p>` : '';
  }

  /** The free way back to the fair from Palm Cay, for when the flight home can't be booked (the button). */
  private returnHomeButton() {
    return '<button class="btn btn-outline btn-small" type="button" data-goto="mainland">Free seat home on the staff shuttle 🛩️</button>';
  }

  /** On Palm Cay, the way to more tickets: they're sold at the fair, so it's the flight home (or the free shuttle seat when that can't be booked). */
  private showBoothAway() {
    this.player.interact();
    this.sfx.beep();
    this.panelZone = this.zones.active;
    const fly = this.canFlyHome();
    this.ui.panel(
      `booth-away-${Date.now()}`,
      `<p class="eyebrow">Ticket Booth · The Funfair</p><h2>The Ticket Booth is back at the fair 🎟️</h2><p>Tickets are handed out at the booth by the fair's gate, about 40 km north across the sea. ${
        fly ? "Fly home from Palm Cay's gate desk (Funfair Air FA102), then take the SkyLink to the fair." : "You can't book the flight home right now, so the staff shuttle has a free seat for you: it lands at Funfair International, a SkyLink ride from the fair."
      }</p><p class="panel-actions">${
        fly ? '<button class="btn btn-primary btn-small" type="button" data-goto="desk">Go to the Palm Cay gate desk ✈️</button>' : this.returnHomeButton()
      }</p>`,
      { accent: PALETTE.mustard },
    );
  }

  /** Over to this landmass's gate desk, with its flight card open. */
  private goToFlightDesk() {
    if (this.mode !== 'drive' || this.round) return;
    const desk = this.deskZone('flight');
    this.ui.hidePanel();
    this.panelZone = null;
    if (this.zones.active === desk) this.showZonePanel(desk);
    else this.teleport(desk, () => this.showZonePanel(desk));
  }

  /**
   * The free way off Palm Cay (no round, no tickets): the staff shuttle sets the visitor down in
   * Funfair International's arrivals hall, behind the fade, so nobody is stranded on the island
   * without the tickets for the flight home (or while it's closed). The region switch (which games
   * are awake, the scenery shown) follows by itself on the next frame, as after a landing.
   */
  private returnToMainland() {
    if (this.mode !== 'drive' || this.round || this.boarding || this.region !== 'island') return;
    this.ui.hidePanel();
    this.panelZone = null;
    const z = ZONES[REGION_INFO.home.arrival];
    this.fade(() => {
      this.placeVisitor(z.x, z.z, z.heading, z.y ?? 0);
      this.camYaw = z.heading;
      this.camPitch = 0.2;
      this.updateDriveCamera(1, true);
      this.sfx.chime();
    });
  }

  /** A place across the sea from the visitor: you fly there, from this side's gate desk. */
  private showAcrossSea(id: ZoneId) {
    this.player.interact();
    this.sfx.beep();
    this.panelZone = this.zones.active;
    const there = REGION_INFO[ZONE_REGION[id]].name;
    this.ui.panel(
      `across-${id}-${Date.now()}`,
      `<p class="eyebrow">${escapeHtml(ZONES[id].title)} · ${escapeHtml(there)}</p><h2>That's across the sea ✈️</h2><p>${escapeHtml(ZONES[id].title)} is on ${escapeHtml(there)}, and there's no walking over the water: Funfair Air flies between the two from the gate desks.</p><p class="panel-actions"><button class="btn btn-primary btn-small" type="button" data-goto="desk">Go to the gate desk ✈️</button></p>`,
      { accent: PALETTE.mustard },
    );
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
      this.placeVisitor(spot.x, spot.z, spot.heading);
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
      this.placeVisitor(z.x, z.z, z.heading);
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
      this.placeVisitor(spot.x, spot.z, spot.heading);
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
    // (the customiser has the keyboard while it's open: its Escape is Cancel)
    if (this.mode === 'dressing') return;
    if (this.mode === 'shop') return this.leaveShop();
    if (this.mode === 'ideas') return this.leaveIdeas();
    if (this.mode === 'museum') return this.leaveMuseum();
    if (this.mode === 'workshop') return this.workshop?.escape();
    // past the line, at the far gate, or in an island game's last look: the round's done, so this is
    // no early exit (and a crash's aftermath or report just closes the lost flight)
    if (this.roundRanToEnd()) return this.leave(true);
    if (this.flightLost()) return;
    if (this.mode === 'skylink') return this.skipSkyLink();
    if (this.mode !== 'drive' || this.round?.ride === 'crates') return this.askToLeave();
    if (this.zones.active === 'crates') this.cratesDismissed = true;
    if (this.zones.active === 'trail') this.trailDismissed = true;
    this.ui.hidePanel();
    this.panelZone = null;
  }

  /** Esc, the exit button or "Stop the round" mid-round: its tickets aren't given back, so the visitor is asked first. */
  private askToLeave() {
    if (this.roundRanToEnd()) return this.leave(true);
    if (this.flightLost()) return;
    const round = this.round;
    // nothing to lose (no round, or one already on its way out): straight out as before
    if (!round || this.leaving || this.lockedOut) return this.leave(false);
    if (leaveEarly.isOpen) return;
    void leaveEarly.ask(rideTitle(round.ride), round.tickets, isGame(round.ride)).then((go) => {
      if (go && this.round === round) this.leave(false);
    });
  }

  /**
   * The round in progress already ran to its end, and is only finishing up: a trail run past the
   * line, a flight on the ground at the far gate, the jet-ski past the flag, a slide's splashdown,
   * the cannons' or the volley's last look. Leaving now (Esc, the exit button, the tab closing)
   * counts as completed.
   */
  private roundRanToEnd() {
    return (
      (this.mode === 'trail' && this.trail.finished) ||
      (this.mode === 'flight' && this.flight.arrived) ||
      (this.mode === 'jetski' && this.jetski.finished) ||
      (this.mode === 'slides' && this.slides.finished) ||
      (this.mode === 'cannons' && this.cannons.finished) ||
      (this.mode === 'volley' && this.volley.finished)
    );
  }

  /** In a crash's or a ditching's aftermath (or its report): the flight is lost, so leaving closes it as such, without asking. */
  private flightLost() {
    if (this.mode !== 'flight' || !this.flight.failed) return false;
    this.flightFailed = true;
    this.leave(false);
    return true;
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
    if (this.mode === 'skylink') {
      // no round on the SkyLink: leaving it is arriving straight away
      this.leaving = false;
      return this.skipSkyLink();
    }
    if (this.mode === 'dressing') {
      this.leaving = false;
      return this.leaveDressing(false);
    }
    const exit: Record<Exclude<Mode, 'drive' | 'striker' | 'ducks' | 'cannons' | 'volley' | 'skylink' | 'shop' | 'ideas' | 'museum' | 'workshop' | 'dressing'>, () => void> = {
      coaster: () => this.ride.exit(),
      rocket: () => this.rocket.exit(),
      wheel: () => this.wheel.exit(),
      drone: () => this.drone.exit(),
      flip: () => this.flip.exit(),
      ship: () => this.ship.exit(),
      race: () => this.speedway.exit(),
      trail: () => this.trail.exit(),
      flight: () => this.flight.exit(),
      jetski: () => this.jetski.exit(),
      slides: () => this.slides.exit(),
    };
    // each exit() hands back to endRide() (its onFinish)
    if (this.mode === 'striker') this.striker.exit();
    else if (this.mode === 'ducks') this.ducks.exit();
    else if (this.mode === 'cannons') this.cannons.exit();
    else if (this.mode === 'volley') this.volley.exit();
    else this.fade(exit[this.mode]);
  }

  private endRide() {
    this.camera.up.set(0, 1, 0);
    this.ui.endIntro();
    const wasRide =
      this.mode === 'coaster' || this.mode === 'rocket' || this.mode === 'wheel' || this.mode === 'drone' || this.mode === 'flip' || this.mode === 'ship' || this.mode === 'race' || this.mode === 'trail' ||
      this.mode === 'flight' || this.mode === 'jetski' || this.mode === 'slides';
    if (this.mode === 'wheel' || this.mode === 'drone' || this.mode === 'flip') this.env.setHaze(1);
    const from = this.mode;
    if (from === 'ducks') {
      // back on foot at the counter, the camera behind the visitor
      this.player.group.visible = true;
      this.camYaw = ZONES.ducks.heading;
      this.ui.score(null);
    }
    if (from === 'cannons' || from === 'volley') {
      // (the serve spot is out on the sand, inside the court's fence: back to its ring instead)
      if (from === 'volley') this.placeVisitor(ZONES.volley.x, ZONES.volley.z, ZONES.volley.heading);
      this.player.group.visible = true;
      this.camYaw = ZONES[from].heading;
      this.ui.score(null);
    }
    let flightZone: ZoneId = 'flight';
    // however the flight was left (Esc, the exit button, a lock-out, the report's Continue), a
    // crash or a ditching ends it as one
    if (from === 'flight' && this.flight.lastFailed) this.flightFailed = true;
    if (from === 'flight') {
      // off the aircraft: in the arrivals hall it landed at (or still at the desk, if it never left)
      this.player.group.visible = true;
      const a = this.flight.arrival;
      const pos = a ?? this.player.position;
      flightZone = regionAt(pos.x, pos.z) === 'island' ? 'flightBack' : 'flight';
      if (a) {
        this.placeVisitor(a.x, a.z, a.heading, ZONES[flightZone].y ?? 0);
        // a little off to one side: the home hall has a tree tub right behind the arrivals spot
        this.camYaw = a.heading + 0.7;
        this.camPitch = 0.25;
      }
      this.minimap.markers = [];
      this.minimap.arrow = 'visitor';
      this.minimap.setView(FOOT_VIEW);
    }
    this.mode = 'drive';
    // a ride that ended because the park went under maintenance lands at the intro, not on foot
    this.player.enabled = this.inFair;
    this.ui.cinematic(false);
    this.ui.rideExit(false);
    this.ui.countdown(null);
    const zoneOf: Partial<Record<Mode, ZoneId>> = { striker: 'striker', ducks: 'ducks', drone: 'drone', flip: 'flip', ship: 'ship', race: 'speedway', trail: 'trail', wheel: 'ferris', jetski: 'jetski', slides: 'slides', cannons: 'cannons', volley: 'volley', flight: flightZone };
    this.panelZone =
      from === 'coaster' ? (this.ride === this.falcon ? 'falcon' : this.ride === this.stack ? 'coaster' : (this.plotRound?.plot ?? 'coaster')) : (zoneOf[from] ?? 'rocket');
    // a member's coaster taken out of the park while it was ridden can go now
    if (from === 'coaster') this.valley.release();
    if (wasRide) this.updateDriveCamera(1, true);
    // off a ride the visitor may be far from where they boarded (a flight's arrival, the gate desk
    // after a crash, the jet-ski's or the slides' landing spot): the trees there, at once
    if (wasRide) this.warmTerrain();
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
    const crashed = this.flightFailed && round.ride === 'flight';
    this.flightFailed = false;
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
      // (the flight's zone is its gate desk: the round is the flight itself)
      title: plotRound?.name ?? rideTitle(round.ride),
      completed,
      boothAway: this.awayFromBooth,
      stats,
      ...(crashed
        ? {
            ending: {
              headline: "The flight didn't make it",
              lead: "A crash or a ditching ends the round: the passengers never reached the other side, and you're back at the gate you left from.",
            },
          }
        : stalled === null
          ? {}
          : {
              ending: {
                headline: `Stalled at ${stalled} m`,
                lead: 'Not enough speed to make it over the top: the train rolled to a stop, and the crew towed it back to the station.',
              },
            }),
    };
    void results.open(result).then((choice) => this.afterResults(round.ride, choice));
    const finishing = session.finish(round.id, completed, stats).then(
      (res) => results.saved(result, res),
      (err: unknown) => {
        if (err instanceof ApiError && err.status === 401) session.expire();
        results.failed(result, err);
      },
    );
    this.finishing = finishing;
    void finishing.finally(() => {
      if (this.finishing === finishing) this.finishing = null;
    });
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
      flight: this.flight,
      jetski: this.jetski,
      slides: this.slides,
      cannons: this.cannons,
      volley: this.volley,
    };
    return cleanStats(measured[ride].roundStats());
  }

  /** The results screen's buttons: another round, or the way to more tickets. */
  private afterResults(ride: AttractionId, choice: ResultsChoice) {
    if (this.mode !== 'drive') return;
    if (choice === 'again') {
      // another flight is booked at this side's gate desk (the leg home, after landing): over to it,
      // and its card (the hour to fly at is picked there)
      // (the island games are only played there: not from across the sea)
      if (ride === 'flight') {
        const desk: ZoneId = this.region === 'island' ? 'flightBack' : 'flight';
        if (this.zones.active === desk) this.showZonePanel(desk);
        else this.teleport(desk, () => this.showZonePanel(desk));
      } else if (ZONE_REGION[ride] === this.region) this.board(ride);
    } else if (choice === 'booth') this.goToBooth();
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
    if (this.mode === 'striker' || this.mode === 'ducks' || this.mode === 'cannons' || this.mode === 'volley') this.leave(false);
    if (this.mode !== 'drive') return;
    // no walking across the sea: Palm Cay is reached by air only
    if (!canTravel(regionAt(this.player.position.x, this.player.position.z), id)) return this.showAcrossSea(id);
    const z = ZONES[id];
    // a jump to the airport (or beyond): its people start loading during the fade
    if (z.z > TRIP_SOUTH_Z) this.loadTripPeople();
    this.fade(() => {
      // park just in front of the trigger ring so the prompt shows up immediately
      this.placeVisitor(z.x, z.z, z.heading, z.y ?? 0);
      this.camYaw = z.heading; // behind the visitor, facing the attraction
      this.camPitch = 0.2;
      this.updateDriveCamera(1, true);
      then?.();
    });
  }

  /**
   * Takes the SkyLink between the fair and the airport (free, no round): the visitor is carried
   * through the scripted trip (into the lift, up, aboard at the windscreen, along the guideway, and
   * down and out at the far hall). E, Esc or the exit button skips to the far hall.
   */
  private rideSkyLink(from: 'park' | 'airport') {
    if (this.mode !== 'drive' || this.round || this.boarding || !this.player.enabled) return;
    this.player.interact();
    this.ui.hidePanel();
    this.panelZone = null;
    this.ui.prompt('', '', '');
    this.loadTripPeople();
    this.skyRide = { ride: this.skylink.ride(from), to: from === 'park' ? 'skylinkBack' : 'skylink', aboard: false, yaw: 0 };
    this.mode = 'skylink';
    this.player.enabled = false;
    this.ui.rideExit(true);
    this.ui.cinematic(true);
    this.sfx.chime();
  }

  /** One frame of the SkyLink trip: the visitor moves with the pose; at the far hall, back on foot. */
  private updateSkyRide(dt: number) {
    const sr = this.skyRide;
    if (!sr) return;
    const before = this.player.position;
    const bx = before.x;
    const bz = before.z;
    const pose = sr.ride.update(dt);
    const moved = Math.hypot(pose.pos.x - bx, pose.pos.z - bz);
    // strolling on the scripted legs (not while the lift or the train carries them)
    const walking = !pose.aboard && pose.phase !== 'lift-up' && pose.phase !== 'lift-down' && dt > 0 && moved / dt > 0.3 && moved / dt < 3;
    this.player.carry(pose.pos.x, pose.pos.y, pose.pos.z, pose.yaw, walking ? moved / dt : 0);
    sr.aboard = pose.aboard;
    sr.yaw = pose.yaw;
    if (pose.done) this.endSkyRide();
  }

  /** E, Esc or the exit button on the SkyLink: the rest of the trip runs on, out of sight, to the far hall. */
  private skipSkyLink() {
    const sr = this.skyRide;
    if (!sr || this.mode !== 'skylink') return;
    this.fade(() => {
      if (this.skyRide !== sr) return;
      // the trains and the lifts run with it, so the lane and the lift it claimed are let go as usual
      let t = 0;
      for (let i = 0; i < 6000 && this.skyRide === sr; i++) {
        t += SKYLINK_SKIP_DT;
        this.skylink.update(SKYLINK_SKIP_DT, t);
        this.updateSkyRide(SKYLINK_SKIP_DT);
      }
      // (in case the trip never finished: the visitor is put at the far hall all the same)
      if (this.skyRide === sr) this.endSkyRide();
    });
  }

  private endSkyRide() {
    const sr = this.skyRide;
    if (!sr) return;
    this.skyRide = null;
    this.player.release();
    const z = ZONES[sr.to];
    // just outside the far hall's ring, facing out of it (so E there doesn't send them straight back)
    const pos = this.player.position;
    this.placeVisitor(pos.x, pos.z, sr.to === 'skylinkBack' ? Math.PI : 0, z.y ?? 0);
    this.camYaw = sr.to === 'skylinkBack' ? Math.PI : 0;
    this.camPitch = 0.2;
    this.mode = 'drive';
    this.player.enabled = this.inFair;
    this.ui.rideExit(false);
    this.ui.cinematic(false);
    this.updateDriveCamera(1, true);
  }

  /**
   * The terminals' boards and gate screens from the same source as the booking card: FA101 at
   * gate 3 and FA102 on the island at the times the card offers, the one it has picked boarding.
   */
  private paintFlightBoards() {
    const tod = this.flight.timeOfDay;
    const { scheduleBoards, DEFAULT_ARRIVALS, DEFAULT_DEPARTURES, ISLAND_ARRIVALS, ISLAND_DEPARTURES } = this.kit;
    const home = scheduleBoards('home', tod, { departures: DEFAULT_DEPARTURES, arrivals: DEFAULT_ARRIVALS });
    this.homeTerminal.setFlights(home.departures, home.arrivals);
    const isle = scheduleBoards('island', tod, { departures: ISLAND_DEPARTURES, arrivals: ISLAND_ARRIVALS });
    this.islandTerminal.setFlights(isle.departures, isle.arrivals);
  }

  /** Puts the visitor down (Player.reset), with the trees round the spot planted for the first frame there. */
  private placeVisitor(x: number, z: number, heading: number, floorY = 0) {
    this.player.reset(x, z, heading, floorY);
    this.warmTerrain(x, z);
  }

  /** Where and when the trees were last warmed (one warm per spot: a fade, a reset and a region change can land together). */
  private lastWarm = { x: NaN, z: NaN, at: -1 };

  /**
   * Plants the terrain's trees round (x, z) at once (Terrain.warm) after a jump: a teleport, a
   * region change, an arrival or a reset. On foot the view range is always the walking one by then
   * (the flight restores it in its exit(), before endRide runs), which warm() reads to know how far
   * out to plant. A second call for about the same spot within a second is skipped.
   */
  private warmTerrain(x = this.player.position.x, z = this.player.position.z) {
    const now = performance.now();
    const w = this.lastWarm;
    if (now - w.at < 1000 && Math.hypot(x - w.x, z - w.z) < 40) return;
    this.lastWarm = { x, z, at: now };
    this.env.terrain.warm(x, z);
  }

  /** Aboard the SkyLink: the view from the leading car's windscreen. */
  private updateSkyCamera(dt: number) {
    const p = this.player.position;
    const yaw = this.skyRide?.yaw ?? this.camYaw;
    const eye = new THREE.Vector3(p.x, p.y - 0.42 + 1.65, p.z);
    const look = new THREE.Vector3(eye.x - Math.sin(yaw) * 10, eye.y - 0.4, eye.z - Math.cos(yaw) * 10);
    const k = 1 - Math.exp(-dt * 6);
    this.camPos.lerp(eye, k);
    this.camTarget.lerp(look, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);
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
              : this.mode === 'dressing' && this.customiser
                ? this.customiser.viewOffset(w, h)
                : null;
    // (the customiser's camera stands further back on a portrait screen)
    if (this.mode === 'dressing') this.aimDressCam();
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
    // eye height over the floor they stand on (a terminal's, the SkyLink's platform, the island's beach)
    const floor = Math.max(0, p.y - BODY_R);
    const target = new THREE.Vector3(p.x + vel.x * 0.3, floor + 1.7, p.z + vel.z * 0.3);
    this.player.camYaw = this.camYaw;
    const goal = target.clone().add(offset);
    // in the museum's hall the camera stays between its walls, under the roof (and the terminal's)
    if (this.museum.inside(p)) this.museum.clampCamera(target, goal);
    else if (this.region === 'home' && this.homeTerminal.inside(p)) this.homeTerminal.clampCamera(target, goal);
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
    // where the visitor is: the aircraft's region while flying it, else where they stand
    if (this.mode === 'skylink') this.updateSkyRide(dt);
    if (!this.tripPeople) {
      const p = this.player.position;
      if (p.z > TRIP_SOUTH_Z || Math.hypot(p.x - SKYLINK.park.x, p.z - SKYLINK.park.z) < TRIP_STATION_M) this.loadTripPeople();
    }
    const region = this.flight.active ? this.flight.region : regionAt(this.player.position.x, this.player.position.z);
    if (region !== this.region) this.enterRegion(region);
    // the AI traffic first: the flight reads where everyone is this frame
    this.traffic.update(dt, t, this.flight.trafficPlayer, region);
    for (const u of this.updatables) u.update(dt, t);
    this.updateAirports(dt, t, region);
    this.wardrobe?.update(dt);
    this.updateCoasterAudio();
    if (MAP_MODES.has(this.mode)) this.updateMinimap(dt);
    if (this.islandCamBtn) {
      const isle = this.mode === 'jetski' || this.mode === 'slides' || this.mode === 'cannons' || this.mode === 'volley';
      if (this.islandCamBtn.hidden === isle) this.islandCamBtn.hidden = !isle;
    }
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
    } else if (this.mode === 'dressing') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      const k = 1 - Math.exp(-dt * 2.6);
      this.camPos.lerp(this.dressCam.pos, k);
      this.camTarget.lerp(this.dressCam.look, k);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.env.follow(this.player.position);
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
    } else if (this.mode === 'flight') {
      this.zones.setVisible(false);
      this.flight.updateCamera(this.camera, dt);
      this.env.follow(this.flight.focus);
    } else if (this.mode === 'jetski') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.jetski.updateCamera(this.camera, dt);
      this.env.follow(this.jetski.focus);
    } else if (this.mode === 'slides') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.slides.updateCamera(this.camera, dt);
      this.env.follow(this.slides.focus);
    } else if (this.mode === 'cannons') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.cannons.updateCamera(this.camera, dt);
      this.env.follow(this.cannons.focus);
      const badge = `💥 ${Math.ceil(this.cannons.secondsLeft)} s left · ${this.cannons.score} points · ${this.cannons.sunk} sunk`;
      if (badge !== this.cannonsBadge) this.ui.score((this.cannonsBadge = badge));
    } else if (this.mode === 'volley') {
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.volley.updateCamera(this.camera, dt);
      this.env.follow(this.volley.focus);
    } else if (this.mode === 'skylink' && this.skyRide?.aboard) {
      // at the leading car's windscreen
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.updateSkyCamera(dt);
      this.env.follow(this.player.position);
    } else if (this.mode === 'skylink') {
      // walking to the lift, riding it, along the platform: the usual camera, on the carried visitor
      this.camera.up.set(0, 1, 0);
      this.zones.setVisible(false);
      this.updateDriveCamera(dt);
      this.env.follow(this.player.position);
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
    this.player.setNightGlow(this.mode === 'dressing' ? this.env.night * DRESSING_GLOW : this.env.night);
    this.crowd?.setNight(this.env.night);
    this.timeControl?.update();

    if (this.adaptive.update(dt)) {
      this.renderer.setPixelRatio(this.quality.dpr * this.adaptive.scale);
      this.resize();
    }
    // a picture of the coaster for staff, taken just before the frame covers it
    if (this.mode === 'workshop') this.yard.takeSnapshot(this.scene);
    this.cullAirportGroups();
    this.post.render(dt);
  }

  /** Each airport and island group's world bounds (padded), worked out once after the build. */
  private airportBounds: { group: THREE.Object3D; box: THREE.Box3 }[] | null = null;
  private readonly cullFrustum = new THREE.Frustum();
  private readonly cullMatrix = new THREE.Matrix4();

  /**
   * Drops the airports' and Palm Cay's groups wholesale when their bounds are out of the camera's
   * view, just before the frame is drawn (updateAirports has set which side is shown). Their merged
   * meshes are big (an apron, a guideway, a landside road net), so three's per-mesh sphere test
   * keeps them in from the park's entrance even looking north, away from them: ~45 draw calls and
   * ~190k triangles for nothing. The bounds are padded by 60 m, more than the walking shadow box,
   * so nothing casting a shadow into view goes missing. (Lights are kept out of these groups on
   * purpose, so hiding them never recompiles a shader: see where islandRoot is gathered.) The AI
   * traffic and the hero aircraft move, and stay as they are.
   */
  private cullAirportGroups() {
    if (!this.homeTerminal) return;
    if (!this.airportBounds) {
      const groups: [THREE.Object3D, Region][] = [
        [this.airfields.home.group, 'home'],
        [this.airfields.island.group, 'island'],
        [this.airside.home.group, 'home'],
        [this.airside.island.group, 'island'],
        [this.homeTerminal.group, 'home'],
        [this.landside.group, 'home'],
        [this.skylink.group, 'home'],
        [this.islandRoot, 'island'],
      ];
      this.airportBounds = groups.map(([group, region]) => {
        group.updateMatrixWorld(true);
        return { group, box: staticBounds(group, region) };
      });
    }
    const cam = this.camera;
    cam.updateMatrixWorld();
    this.cullFrustum.setFromProjectionMatrix(this.cullMatrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    for (const { group, box } of this.airportBounds) if (group.visible && !box.isEmpty() && !this.cullFrustum.intersectsBox(box)) group.visible = false;
  }

  /**
   * The visitor crossed between the mainland and Palm Cay (by air): the far side's games sleep.
   */
  private enterRegion(region: Region) {
    this.region = region;
    const island = region === 'island';
    for (const g of [this.jetski, this.slides, this.cannons, this.volley]) g.setAwake(island);
    // on foot (an arrival, a jump): the trees round the visitor at once. In flight the aircraft's
    // own planting fills them in as it goes, and a 45 ms warm would only stutter the view.
    if (!this.flight.active) this.warmTerrain();
    // (the park map opens on the visitor's own landmass by itself)
  }

  /**
   * The airports, the SkyLink, Palm Cay and their people, each frame (as the flight preview does),
   * with the far side's heavy scenery hidden while the visitor's on foot (in flight both stay: the
   * flight sets its own view range) and the fair hidden once the camera is far from it.
   */
  private updateAirports(dt: number, t: number, region: Region) {
    const cam = this.camera;
    const flying = this.flight.active;
    const n = this.env.night;
    if (Math.abs(n - this.worldNight) > 0.005) {
      this.worldNight = n;
      for (const r of ['home', 'island'] as const) this.airside[r].setNight(n);
      this.traffic.setNight(n);
      this.homeTerminal.setNight(n);
      this.landside.setNight(n);
      this.skylink.setNight(n);
      this.islandTerminal.setNight(n);
      this.palmCay.setNight(n);
      this.travellers?.setNight(n);
      for (const g of [this.jetski, this.slides, this.cannons, this.volley]) g.setNight(n);
      // the flight lights its own field (and both in low visibility); otherwise they follow the dusk
      if (!flying) for (const r of ['home', 'island'] as const) this.airfields[r].setLights(n);
    }
    const showHome = flying || region === 'home';
    const showIsland = flying || region === 'island';
    this.airfields.home.group.visible = this.airside.home.group.visible = showHome;
    this.homeTerminal.group.visible = this.landside.group.visible = this.skylink.group.visible = showHome;
    this.airfields.island.group.visible = this.airside.island.group.visible = showIsland;
    this.islandTerminal.group.visible = this.palmCay.group.visible = showIsland;
    this.islandRoot.visible = showIsland;
    for (const r of ['home', 'island'] as const) {
      this.airside[r].setAircraft(this.traffic.bodies(r));
      if (r === 'home' ? showHome : showIsland) {
        this.airside[r].update(dt, t, cam);
        this.airfields[r].update(dt, t, cam);
      }
    }
    if (showHome) {
      this.homeTerminal.update(dt, t, cam);
      this.landside.visitor = this.mode === 'drive' ? this.player.position : null;
      this.landside.update(dt, t, cam);
      this.skylink.update(dt, t, cam);
    }
    if (showIsland) {
      this.islandTerminal.update(dt, t);
      this.palmCay.update(dt, t, cam);
    }
    if (this.travellers) {
      this.travellers.setVisitor(this.mode === 'drive' || this.mode === 'skylink' ? this.player.position : null);
      this.travellers.update(dt, t, cam, region);
    }
    // the fair's own scenery (rides, stalls, crowd), from far out to sea or over Palm Cay: not drawn
    const far = Math.hypot(cam.position.x - PARK.x, cam.position.z - PARK.z) > FAIR_DRAW_M;
    if (far && !this.fairHidden) {
      this.fairHidden = this.fairObjects.map((o) => o.visible);
      for (const o of this.fairObjects) o.visible = false;
    } else if (!far && this.fairHidden) {
      this.fairObjects.forEach((o, i) => (o.visible = this.fairHidden![i]));
      this.fairHidden = null;
    }
  }

  private updateMinimap(dt: number) {
    const q = this.player.group.quaternion;
    // yaw from the quaternion (the visitor only ever turns about y); in the air the map follows the
    // drone (or the airliner), on the circuit your kart, on the lagoon your jet-ski
    const mover =
      this.mode === 'drone'
        ? this.drone
        : this.mode === 'race'
          ? this.speedway
          : this.mode === 'trail'
            ? this.trail
            : this.mode === 'flight'
              ? this.flight
              : this.mode === 'jetski'
                ? this.jetski
                : this.mode === 'slides'
                  ? this.slides
                  : null;
    const racing = this.mode === 'race';
    const trailing = this.mode === 'trail';
    const heading = mover ? mover.yaw : Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    const p = mover ? mover.position : this.player.position;
    const visitor = { x: p.x, z: p.z, heading };
    // how far the map reaches: on foot, on the water or taxiing, and up to 15 km at cruise
    if (this.mode === 'flight') {
      const alt = this.flight.altitude;
      this.minimap.setView(alt < 15 ? 300 : THREE.MathUtils.clamp(3000 + alt * 1.2, 3000, 15000));
      this.minimap.arrow = 'aircraft';
      this.minimap.markers = this.flight.markers;
    } else if (this.mode === 'jetski') {
      this.minimap.setView(300);
      if (this.minimap.markers.length) this.minimap.markers = [];
    } else {
      this.minimap.setView(FOOT_VIEW);
      if (this.minimap.markers.length) this.minimap.markers = [];
      this.minimap.arrow = 'visitor';
    }
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
      // the lagoon's skis (yours is the arrow)
      ...(this.mode === 'jetski' ? this.jetski.markers.slice(1) : []),
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
    // the rush of water down the flume
    if (this.mode === 'slides') {
      this.sfx.setCoaster(Math.min(1, this.slides.speed / 22), false, true);
      return;
    }
    // no coasters to hear across the sea, nor from the cockpit
    if (this.region === 'island' || this.mode === 'flight') {
      this.sfx.setCoaster(0, false, false);
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
    this.placeVisitor(z.x, z.z, z.heading);
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
              : zone === 'flightBack'
                ? zoneAction('flight', 'flightBack')
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
