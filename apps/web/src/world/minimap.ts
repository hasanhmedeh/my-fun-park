import { isPlot, PLOT_IDS, plotNumber, type PlotId } from '../account/api';
import { DISTRICTS, VALLEY, ZONES, type DistrictId, type ZoneId } from './layout';
import { AIRPORT_MARKS, fairBounds, paintAircraft, paintFix, paintTrain, paintVisitor, pushMapShapes, setValleyTrack, type MapShape } from './map-paint';
import { drawTiles, mapTiles } from './map-tiles';
import { PALETTE } from './textures';

type Place = { icon: string; label: string; blurb: string };

/** Every place on the map (keyed by zone, so a new zone can't be left off). */
const PLACES: Record<ZoneId, Place> = {
  entrance: { icon: '🎪', label: 'Entrance', blurb: 'The main gate and the welcome plaza' },
  coaster: { icon: '🎢', label: 'Thunder Loop', blurb: 'Drive the coaster yourself: launch, loop and roll' },
  falcon: { icon: '🦅', label: 'Sky Falcon', blurb: 'A 250 km/h cliff coaster with a 158 m drop' },
  rocket: { icon: '🚀', label: 'Rocket Ride', blurb: 'Fire six stages all the way to orbit' },
  ferris: { icon: '🎡', label: 'Giant Wheel', blurb: 'Ride 250 m up over the whole park' },
  flip: { icon: '🌀', label: 'Sky Flip', blurb: 'Swing 125 m up and flip over the top' },
  ship: { icon: '🛸', label: 'Nebula 360', blurb: 'A pendulum ship that loops all the way round' },
  speedway: { icon: '🏎️', label: 'Turbo Speedway', blurb: 'Race the karts round the circuit' },
  trail: { icon: '🚙', label: 'Rally Trail', blurb: 'A buggy time trial with jumps: today’s fastest top the leaderboard' },
  crates: { icon: '🥫', label: 'Crate Smash', blurb: 'Kick, roll and smash the crate stacks' },
  striker: { icon: '🔔', label: 'High Striker', blurb: 'Swing the hammer and ring the bell' },
  ducks: { icon: '🦆', label: 'Duck Shoot', blurb: 'Knock down the tin ducks before the clock runs out' },
  drone: { icon: '🚁', label: 'Drone Flights', blurb: 'Rent a drone and see it all from the sky' },
  booth: { icon: '🎟️', label: 'Ticket Booth', blurb: 'Free tickets, treats and souvenirs at Rosa’s counter' },
  ideas: { icon: '💡', label: 'Idea Box', blurb: 'Tell us what you’d love to see in the fair' },
  museum: { icon: '🏛️', label: 'Career Museum', blurb: 'Hasan Hmedeh’s work from 2019 to today, in framed pictures' },
  workshop: { icon: '🛠️', label: 'Coaster Workshop', blurb: 'Build your own coaster, and send it in to run here in the valley' },
  skylink: { icon: '🚝', label: 'SkyLink', blurb: 'The free people mover: two minutes over the Rally Trail to the airport' },
  flight: { icon: '✈️', label: 'Funfair Air · Gate 3', blurb: 'Book flight FA101 and fly the A320neo yourself to Palm Cay, 40 km south' },
  airport: { icon: '🛫', label: 'Funfair International', blurb: 'The airport on the coast: check-in, shops and the gates' },
  skylinkBack: { icon: '🚝', label: 'SkyLink to the fair', blurb: 'The people mover back to the fair’s main gate' },
  flightBack: { icon: '✈️', label: 'Funfair Air · Palm Cay', blurb: 'Book flight FA102 and fly yourself home to the fair' },
  palmcay: { icon: '🌴', label: 'Palm Cay arrivals', blurb: 'The island’s arrivals plaza, at the top of the Palm Promenade' },
  jetski: { icon: '🚤', label: 'Jet-Ski Race', blurb: 'Three laps of the lagoon against four rivals, with jumps' },
  slides: { icon: '🌊', label: 'Splash Tower', blurb: 'Three water slides from a 28 m tower: Kamikaze, Typhoon and the Lazy Loop' },
  cannons: { icon: '🏴‍☠️', label: 'Pirate Cannons', blurb: 'Man the fort’s cannons and sink the pirate ships' },
  volley: { icon: '🏐', label: 'Beach Volley', blurb: 'Serve, spike and knock the coconuts off their stand' },
  // each plot is named after the coaster running on it (see setPlotPlace)
  ...(Object.fromEntries(PLOT_IDS.map((id) => [id, { icon: '🎢', label: `Plot ${plotNumber(id)}`, blurb: 'Waiting for a coaster' }])) as Record<PlotId, Place>),
};
/** The places in the order the map's legend lists them: district by district, each with its district. */
export const MAP_PLACES = (Object.entries(DISTRICTS) as [DistrictId, (typeof DISTRICTS)[DistrictId]][]).flatMap(([district, d]) =>
  d.zones.map((id) => ({ id, district, ...PLACES[id] })),
);

/** The plots with a coaster running on them: the empty ones stay off the maps and the lists. */
const runningPlots = new Set<PlotId>();
/** True for every place the maps show (a plot only while a coaster runs there). */
export const onMap = (id: ZoneId) => !isPlot(id) || runningPlots.has(id);

/** Creators' Valley's ground, where a plot's coaster is painted. */
const valleyBox = () => {
  const [v] = VALLEY.lawns;
  return { x0: v.x0, x1: v.x1, z0: v.z0, z1: v.z1 };
};

/** A coaster opened on a plot (or the plot emptied): its place on the maps and its track from above. */
export function setPlotPlace(id: PlotId, coaster: { name: string; creator: string; track: [number, number][]; color: string } | null) {
  const p = MAP_PLACES.find((m) => m.id === id)!;
  p.label = coaster?.name ?? `Plot ${plotNumber(id)}`;
  p.blurb = coaster ? `A coaster by @${coaster.creator}, built in the Coaster Workshop` : 'Waiting for a coaster';
  if (coaster) runningPlots.add(id);
  else runningPlots.delete(id);
  setValleyTrack(id, coaster ? { pts: coaster.track, color: coaster.color } : null);
  mapTiles.invalidate(valleyBox());
}
if (import.meta.env.DEV && new Set(MAP_PLACES.map((p) => p.id)).size !== Object.keys(PLACES).length)
  console.warn('Every zone belongs in exactly one district (DISTRICTS in layout.ts), or the map leaves it out.');

/**
 * Adds buildings to both maps (the airside's hangars and tower, the cargo sheds…), from the
 * module that builds them; the tiles under them are painted again.
 */
export function addMapShapes(shapes: readonly MapShape[]) {
  pushMapShapes(shapes);
  for (const sh of shapes) mapTiles.invalidate('r' in sh ? { x0: sh.x - sh.r, x1: sh.x + sh.r, z0: sh.z - sh.r, z1: sh.z + sh.r } : sh);
}

export { fairBounds };
export type { MapShape };

/** Something moving or fixed the minimap shows during a flight: AI traffic (with its callsign), or a waypoint. */
export interface MapMarker {
  x: number;
  z: number;
  kind: 'traffic' | 'fix';
  label: string;
  /** Traffic only: which way it's heading (radians, the park's yaw: 0 faces north). */
  heading?: number;
}

/** Metres from the centre to the edge of the minimap on foot. */
export const FOOT_VIEW = 55;
/** Beyond these views, the places are shown a district at a time, then only the airports. */
const PLACES_VIEW = 450;
const DISTRICTS_VIEW = 4000;

/**
 * North-up circular minimap in the bottom-left corner, over the world's tiles (map-tiles.ts): a
 * window round the visitor, 55 m out to the edge on foot, wider in vehicles (setView), up to
 * tens of kilometres in flight. Click / tap it (or press M) to open the full-screen map.
 */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private size = 0;
  private dpr = 1;
  private centre = { x: 0, z: 0 };
  /** Metres from the centre to the edge: now, and where it's easing to. */
  private view = FOOT_VIEW;
  private targetView = FOOT_VIEW;
  /** Attractions closed for maintenance: their icon sits on a red disc. */
  closed: ReadonlySet<ZoneId> = new Set();
  /** AI traffic and the flight plan's fixes, while flying (set them back to [] afterwards). */
  markers: readonly MapMarker[] = [];
  /** The visitor's symbol: the arrow on foot, an airliner when they're flying one. */
  arrow: 'visitor' | 'aircraft' = 'visitor';
  onOpen: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.canvas = root.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    root.addEventListener('click', () => this.onOpen?.());
  }

  /**
   * How far the minimap reaches, from its centre to the edge, in metres: FOOT_VIEW (55) on foot,
   * ~300 taxiing or on a jet-ski, 3000–15000 in flight. It eases there unless `instant`.
   */
  setView(metres: number, instant = false) {
    this.targetView = Math.max(20, metres);
    if (instant) this.view = this.targetView;
  }

  /** Paints the fair again (a coaster opened or closed in Creators' Valley). */
  redraw() {
    mapTiles.invalidate(fairBounds());
  }

  private resize() {
    const size = this.canvas.clientWidth;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (size === this.size && dpr === this.dpr) return;
    this.size = size;
    this.dpr = dpr;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
  }

  /** Converts a world position to minimap CSS pixels (relative to the canvas). */
  private toMap(x: number, z: number) {
    const k = this.size / 2 / this.view;
    return { x: this.size / 2 + (x - this.centre.x) * k, y: this.size / 2 + (z - this.centre.z) * k };
  }

  update(car: { x: number; z: number; heading: number }, trains: { x: number; z: number; color: string }[]) {
    this.resize();
    if (!this.size) return;
    this.centre.x = car.x;
    this.centre.z = car.z;
    // ease the view's reach in log space, so zooming out to a flight's 15 km feels as even as to 300 m
    if (this.view !== this.targetView) {
      const v = Math.exp(Math.log(this.view) + (Math.log(this.targetView) - Math.log(this.view)) * 0.08);
      this.view = Math.abs(v - this.targetView) < 0.5 ? this.targetView : v;
    }

    const g = this.g;
    const S = this.size;
    const view = this.view;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, S, S);
    g.save();
    g.beginPath();
    g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
    g.clip();

    // the world's tiles round the centre
    g.imageSmoothingEnabled = true;
    drawTiles(g, car.x, car.z, S / 2 / view, S, S, this.dpr);

    // moving coaster trains, karts and buggies (only while they'd be more than a speck)
    if (view < PLACES_VIEW * 2)
      for (const t of trains) {
        const p = this.toMap(t.x, t.z);
        if (p.x < -6 || p.y < -6 || p.x > S + 6 || p.y > S + 6) continue;
        paintTrain(g, p.x, p.y, t.color, view > PLACES_VIEW ? 2.5 : 3.5);
      }

    // the places: each attraction close up; a district at a time further out; the airports far out
    const iconSize = Math.round(Math.max(12, Math.min(18, S / 11)));
    g.font = `${iconSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const icon = (x: number, z: number, glyph: string, shut: boolean) => {
      const p = this.toMap(x, z);
      if (p.x < -10 || p.y < -10 || p.x > S + 10 || p.y > S + 10) return;
      g.fillStyle = shut ? 'rgba(255, 77, 109, 0.95)' : 'rgba(255, 245, 227, 0.92)';
      g.beginPath();
      g.arc(p.x, p.y, iconSize * 0.72, 0, Math.PI * 2);
      g.fill();
      if (shut) {
        g.strokeStyle = PALETTE.cream;
        g.lineWidth = 2;
        g.stroke();
      }
      g.fillStyle = '#000';
      g.fillText(glyph, p.x, p.y + 1);
    };
    if (view <= PLACES_VIEW) {
      for (const { id, icon: glyph } of MAP_PLACES) if (onMap(id)) icon(ZONES[id].x, ZONES[id].z, glyph, this.closed.has(id));
    } else if (view <= DISTRICTS_VIEW) {
      for (const d of Object.values(DISTRICTS)) icon(d.plaza[0], d.plaza[1], d.icon, false);
    } else {
      for (const a of AIRPORT_MARKS) {
        icon(a.x, a.z, '✈️', false);
        const p = this.toMap(a.x, a.z);
        g.font = `700 10px "DM Sans", sans-serif`;
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
        g.strokeText(a.icao, p.x, p.y + iconSize);
        g.fillStyle = PALETTE.cream;
        g.fillText(a.icao, p.x, p.y + iconSize);
        g.font = `${iconSize}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      }
    }

    // a flight's fixes and the traffic round it
    for (const m of this.markers) {
      const p = this.toMap(m.x, m.z);
      if (p.x < -40 || p.y < -20 || p.x > S + 20 || p.y > S + 20) continue;
      if (m.kind === 'fix') paintFix(g, p.x, p.y, m.label);
      else {
        g.save();
        g.translate(p.x, p.y);
        paintAircraft(g, m.heading ?? 0, 0.75, '#f4f7fb');
        g.restore();
        g.font = '700 9px "DM Sans", sans-serif';
        g.textAlign = 'left';
        g.lineWidth = 3;
        g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
        g.strokeText(m.label, p.x + 9, p.y - 7);
        g.fillStyle = '#ffffff';
        g.fillText(m.label, p.x + 9, p.y - 7);
        g.textAlign = 'center';
      }
    }

    // the visitor
    const c = this.toMap(car.x, car.z);
    g.translate(c.x, c.y);
    if (this.arrow === 'aircraft') paintAircraft(g, car.heading, 1.15);
    else paintVisitor(g, car.heading);
    g.restore();

    // north marker
    g.fillStyle = 'rgba(255, 245, 227, 0.9)';
    g.font = `700 10px "DM Sans", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', S / 2, 9);
  }
}
