// The numbers each attraction reports for a round: one table for their labels, units, formatting
// and which way a personal best goes. The game measures them (they're client-reported, so
// they're for fun, not for prizes) and the server keeps them with the round.
import { PLOT_IDS, type AttractionId, type Bests, type RoundStats } from './api';

/** Which way a personal best goes: higher, lower, or not a contest at all. */
export type Better = 'max' | 'min' | 'none';

interface StatDef {
  label: string;
  /** Shown after the value (e.g. "km/h"); empty for counts and times. */
  unit: string;
  better: Better;
  format: (v: number) => string;
}

/** 83.4 s → "1:23.4" (lap and race times). */
export const clock = (s: number) => {
  const t = Math.round(s * 10) / 10; // round first, so 59.96 s reads 1:00.0
  const m = Math.floor(t / 60);
  const r = t - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
};
/** 42.173 s → "0:42.17" (the Rally Trail's times, to the hundredth, as on its leaderboard). */
export const clockHundredths = (s: number) => {
  const t = Math.round(s * 100) / 100;
  const m = Math.floor(t / 60);
  const r = t - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(2)}`;
};
/** 42 170 ms → "0:42.17" (a time on the Rally Trail's leaderboard). */
export const trailTime = (ms: number) => clockHundredths(ms / 1000);
/** 151 s → "2:31" (how long a round lasted). */
const minutes = (s: number) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const whole = (v: number) => String(Math.round(v));
const tenths = (v: number) => v.toFixed(1);
const hundredths = (v: number) => v.toFixed(2);
/** 4980 → "4,980" (altitudes in feet, as a pilot reads them). */
const grouped = (v: number) => Math.round(v).toLocaleString('en-GB');
/** 4 → "★★★★☆" (a flight's rating, out of five). */
const starRow = (v: number) => {
  const n = Math.max(0, Math.min(5, Math.round(v)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
};
const ordinal = (n: number) => {
  const r = n % 100;
  return `${n}${r >= 11 && r <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

const def = (label: string, better: Better, format: (v: number) => string, unit = ''): StatDef => ({ label, unit, better, format });

/**
 * Every stat key, as sent to the server. Lower-is-better times end in `TimeS`; `durationS`
 * (how long the round took) is neutral, since a longer ride isn't a worse one.
 */
export const STATS: Record<string, StatDef> = {
  durationS: def('Round time', 'none', minutes),
  lapTimeS: def('Lap time', 'min', clock),
  topSpeedKmh: def('Top speed', 'max', whole, 'km/h'),
  maxG: def('Peak force', 'max', tenths, 'G'),
  minG: def('Lowest force', 'none', tenths, 'G'),
  // rocket
  timeToOrbitS: def('Time to orbit', 'min', clock),
  stagesFired: def('Stages reached', 'max', whole),
  maxAltitudeM: def('Highest point', 'max', whole, 'm'),
  // wheel, flip, ship
  maxHeightM: def('Highest point', 'max', whole, 'm'),
  loops: def('Loops', 'none', whole),
  flips: def('Flips', 'none', whole),
  // speedway
  position: def('Finished', 'min', ordinal),
  raceTimeS: def('Race time', 'min', clock),
  bestLapTimeS: def('Best lap', 'min', clock),
  cones: def('Cones scattered', 'none', whole),
  crashes: def('Crashes', 'none', whole),
  // trail
  runTimeS: def('Trail time', 'min', clockHundredths),
  airS: def('Airtime', 'max', tenths, 's'),
  bigAirS: def('Biggest jump', 'max', tenths, 's'),
  rescues: def('Back on the trail', 'none', whole),
  // drone
  distanceM: def('Distance flown', 'max', (v) => (v >= 1000 ? (v / 1000).toFixed(2) : whole(v)), 'm'),
  // crates
  score: def('Score', 'max', whole, 'pts'),
  cratesSmashed: def('Crates smashed', 'max', whole),
  clearTimeS: def('Time to clear them all', 'min', clock),
  // striker
  bestHit: def('Best hit', 'max', whole, '%'),
  bellsRung: def('Bells rung', 'max', whole),
  // duck shoot
  ducksHit: def('Ducks down', 'max', whole),
  accuracy: def('Accuracy', 'max', whole, '%'),
  bestStreak: def('Best streak', 'max', whole),
  goldenDucks: def('Golden ducks', 'max', whole),
  // Creators' Valley: where a train that ran out of speed came to a stop
  stalledAtM: def('Stalled at', 'none', whole, 'm'),
  // Funfair Air: how the flight went (score and comfort out of 100). The touchdown point is metres
  // past the threshold, and neither short nor long is a record; a flight that keeps to its block
  // time with no penalties is the one to beat.
  stars: def('Rating', 'max', starRow),
  comfort: def('Passenger comfort', 'max', whole, '%'),
  landingFpm: def('Touchdown rate', 'min', whole, 'fpm'),
  landingG: def('Touchdown force', 'min', hundredths, 'G'),
  centrelineM: def('Off the centreline', 'min', tenths, 'm'),
  touchdownM: def('Touchdown past the threshold', 'none', whole, 'm'),
  flightTimeS: def('Flight time', 'min', minutes),
  maxAltitudeFt: def('Highest altitude', 'none', grouped, 'ft'),
  topSpeedKt: def('Top speed', 'none', whole, 'kt'),
  maxBankDeg: def('Steepest bank', 'none', whole, '°'),
  violations: def('Penalties', 'min', whole),
  delayS: def('Delay', 'min', minutes),
  // jet-ski race
  buoysMissed: def('Buoys missed', 'min', whole),
  jumps: def('Jumps', 'max', whole),
  // water slides: which slide of the tower, and how far it drops
  slide: def('Slide', 'none', whole),
  dropM: def('Drop', 'max', whole, 'm'),
  // pirate cannons
  shipsSunk: def('Ships sunk', 'max', whole),
  shots: def('Shots fired', 'none', whole),
  // beach volley
  aces: def('Aces', 'max', whole),
  coconutsHit: def('Coconuts hit', 'max', whole),
};

/** What each attraction reports, in the order the results screen lists them. */
export const ATTRACTION_STATS: Record<AttractionId, string[]> = {
  coaster: ['lapTimeS', 'topSpeedKmh', 'maxG', 'minG', 'durationS'],
  falcon: ['lapTimeS', 'topSpeedKmh', 'maxG', 'minG', 'durationS'],
  rocket: ['timeToOrbitS', 'stagesFired', 'maxAltitudeM', 'topSpeedKmh', 'durationS'],
  ferris: ['maxHeightM', 'durationS'],
  flip: ['maxHeightM', 'topSpeedKmh', 'maxG', 'loops', 'flips', 'durationS'],
  ship: ['maxG', 'minG', 'maxHeightM', 'topSpeedKmh', 'durationS'],
  speedway: ['position', 'raceTimeS', 'bestLapTimeS', 'topSpeedKmh', 'cones', 'crashes'],
  trail: ['runTimeS', 'topSpeedKmh', 'airS', 'bigAirS', 'cratesSmashed', 'crashes', 'rescues'],
  drone: ['durationS', 'maxAltitudeM', 'distanceM', 'topSpeedKmh'],
  crates: ['score', 'cratesSmashed', 'clearTimeS', 'durationS'],
  striker: ['score', 'bestHit', 'bellsRung'],
  ducks: ['score', 'ducksHit', 'accuracy', 'bestStreak', 'goldenDucks', 'durationS'],
  // every plot runs a player-built coaster
  ...(Object.fromEntries(PLOT_IDS.map((id) => [id, ['lapTimeS', 'topSpeedKmh', 'maxG', 'minG', 'stalledAtM', 'durationS']])) as Record<(typeof PLOT_IDS)[number], string[]>),
  // Funfair Air: the verdict, then the landing, then the flight (exactly the 16 keys a round may hold)
  flight: [
    'score',
    'stars',
    'comfort',
    'landingFpm',
    'landingG',
    'centrelineM',
    'touchdownM',
    'flightTimeS',
    'delayS',
    'distanceM',
    'maxAltitudeFt',
    'topSpeedKt',
    'maxG',
    'minG',
    'maxBankDeg',
    'violations',
  ],
  jetski: ['position', 'raceTimeS', 'bestLapTimeS', 'topSpeedKmh', 'buoysMissed', 'jumps'],
  slides: ['slide', 'topSpeedKmh', 'maxG', 'dropM', 'durationS'],
  cannons: ['score', 'shipsSunk', 'accuracy', 'bestStreak', 'shots', 'durationS'],
  volley: ['score', 'aces', 'coconutsHit', 'bestStreak', 'accuracy'],
};

/**
 * Where a shared key reads the other way on one attraction. On a flight the passengers would rather
 * not feel the most G, and a longer track flown is no achievement: a smooth flight on the plan is.
 */
const RIDE_BETTER: Partial<Record<AttractionId, Readonly<Record<string, Better>>>> = {
  flight: { maxG: 'none', distanceM: 'none' },
};

/** Stats the game sends for the server's sake, not for show (when the trail's run crossed the line). */
export const HIDDEN_STATS: ReadonlySet<string> = new Set(['lineAgoS']);

/** The direction for any key, including ones this table doesn't know yet (on `ride`, when given). */
export function betterOf(key: string, ride?: AttractionId): Better {
  return (ride && RIDE_BETTER[ride]?.[key]) ?? STATS[key]?.better ?? (key.endsWith('TimeS') ? 'min' : 'none');
}

/** Units written straight after the number ("87%", "34°"); the rest get a space ("212 km/h"). */
const TIGHT_UNITS: ReadonlySet<string> = new Set(['%', '°']);

/** "1:23.4", "212 km/h", "3.8 G"… */
export function formatStat(key: string, v: number) {
  const d = STATS[key];
  if (!d) return String(Math.round(v * 100) / 100);
  const unit = key === 'distanceM' && v >= 1000 ? 'km' : d.unit;
  return unit ? `${d.format(v)}${TIGHT_UNITS.has(unit) ? '' : ' '}${unit}` : d.format(v);
}

export const statLabel = (key: string) => STATS[key]?.label ?? key;

/** True when `v` beats the best of the earlier rounds (there has to be one to beat) on `ride`, when given. */
export function isPersonalBest(key: string, v: number, best: Bests | null | undefined, ride?: AttractionId) {
  const prev = best?.[key];
  const dir = betterOf(key, ride);
  if (!prev || dir === 'none') return false;
  return dir === 'max' ? v > prev.max : v < prev.min;
}

/**
 * Tidies a round's numbers for the server: finite values only, rounded to a sensible precision,
 * at most 16 keys with the allowed names.
 */
export function cleanStats(stats: RoundStats): RoundStats {
  const out: RoundStats = {};
  for (const [k, v] of Object.entries(stats)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.max(-1e9, Math.min(1e9, Math.round(v * 100) / 100));
    if (Object.keys(out).length >= 16) break;
  }
  return out;
}
