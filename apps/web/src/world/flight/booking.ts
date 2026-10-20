// The flight the visitor books at a gate desk: which leg (FA101 out to Palm Cay, FA102 back), the
// weather it will fly in for the chosen time of day, the runways that weather puts in use, the
// plan and its block time, how many seats are taken, and the booking card's text. Everything is
// worked out from the day and the choice, so the card and the flight that follows always agree
// (the same METAR on the card, on the ATIS and in the sky). Pure: it runs in node.

import { AIRFIELDS, flightPlan, runwayForWind, type RunwayIdent } from '../../aviation/airports';
import { metar, makeWeather, windComponents } from '../../aviation/weather';
import { TIME_OF_DAY_HOUR, type FlightPlan, type TimeOfDay, type Weather } from '../../aviation/types';
import { LIVERIES } from '../airport/liveries';
import type { Region } from '../geo';

/** One booked flight. */
export interface FlightInfo {
  from: Region;
  to: Region;
  timeOfDay: TimeOfDay;
  /** The clock (hours) the flight departs at. */
  hour: number;
  flightNo: 'FA101' | 'FA102';
  /** The radio callsign: "Funfair 101". */
  callsign: string;
  registration: string;
  weather: Weather;
  depRunway: RunwayIdent;
  arrRunway: RunwayIdent;
  plan: FlightPlan;
  /** Passengers aboard (the seats booked). */
  passengers: number;
  /** The seed the weather and the AI's choices come from. */
  seed: number;
}

/** The tickets a flight costs (one leg). */
export const FLIGHT_COST = 10;

/** Today's number (days since 1970, local), so the weather changes from day to day but not within one. */
function today(now: Date) {
  return Math.floor((now.getTime() - now.getTimezoneOffset() * 60000) / 86400000);
}

const TOD_INDEX: Record<TimeOfDay, number> = { dawn: 0, day: 1, dusk: 2, night: 3 };

/** The flight from `from` at a time of day, today (or on `now`'s day). */
export function bookFlight(from: Region, timeOfDay: TimeOfDay, now = new Date()): FlightInfo {
  const out = from === 'home';
  const seed = today(now) * 8 + TOD_INDEX[timeOfDay] * 2 + (out ? 0 : 1);
  const weather = makeWeather(seed, timeOfDay);
  // one wind over the whole sea: both ends use the runway into it
  const rw = runwayForWind(weather.windFrom, weather.windKt);
  const plan = flightPlan(from, rw, rw);
  // a busy holiday route: 70 % to 98 % full, the same for the same day and departure
  const k = ((seed * 2654435761) >>> 0) / 4294967296;
  const passengers = Math.round(126 + k * 50);
  return {
    from,
    to: out ? 'island' : 'home',
    timeOfDay,
    hour: TIME_OF_DAY_HOUR[timeOfDay],
    flightNo: out ? 'FA101' : 'FA102',
    callsign: out ? 'Funfair 101' : 'Funfair 102',
    registration: LIVERIES.funfair.registration,
    weather,
    depRunway: rw,
    arrRunway: rw,
    plan,
    passengers,
    seed,
  };
}

// ------------------------------------------------------------------------------------------------
// The card's words
// ------------------------------------------------------------------------------------------------

const COVER: Record<Weather['clouds'][number]['cover'], string> = { FEW: 'Few clouds', SCT: 'Scattered clouds', BKN: 'Broken cloud', OVC: 'Overcast' };
const compass = (deg: number) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** The METAR in plain words: wind, visibility, cloud, temperature and pressure. */
export function decodeWeather(w: Weather) {
  const wind = w.windKt < 3 ? 'Calm' : `${String(Math.round(w.windFrom / 10) * 10 || 360).padStart(3, '0')}° at ${w.windKt} kt${w.gustKt > w.windKt ? `, gusting ${w.gustKt}` : ''} (from the ${compass(w.windFrom)})`;
  const vis = w.visibilityM >= 10000 ? '10 km or more' : `${(w.visibilityM / 1000).toFixed(w.visibilityM < 5000 ? 1 : 0)} km${w.visibilityM < 5000 && w.tempC - w.dewC <= 2 ? ', mist' : ''}`;
  const clouds = w.clouds.length ? w.clouds.map((c) => `${COVER[c.cover]} at ${c.baseFt.toLocaleString('en-GB')} ft`).join(', ') : 'No significant cloud';
  return { wind, vis, clouds, temp: `${w.tempC} °C, dew point ${w.dewC} °C`, qnh: `QNH ${Math.floor(w.qnh)} hPa` };
}

/** The raw METARs at both ends (the same air mass, reported by each airport). */
export function metars(f: FlightInfo) {
  return { dep: metar(f.weather, AIRFIELDS[f.from].geo.icao, f.hour), arr: metar(f.weather, AIRFIELDS[f.to].geo.icao, f.hour + 0.4) };
}

/** "Runway 27, 8 kt headwind, 4 kt crosswind from the left". */
export function runwayText(f: FlightInfo, rw: RunwayIdent) {
  const end = AIRFIELDS[f.from].runways[rw];
  const c = windComponents(f.weather, end.heading);
  if (f.weather.windKt < 3) return `Runway ${rw}, calm`;
  const head = Math.round(c.head);
  const cross = Math.round(Math.abs(c.cross));
  const along = head >= 0 ? `${head} kt headwind` : `${-head} kt tailwind`;
  return `Runway ${rw}, ${along}${cross >= 3 ? `, ${cross} kt crosswind from the ${c.cross > 0 ? 'right' : 'left'}` : ''}`;
}

/** Block time as "15 min". */
export const blockText = (s: number) => `${Math.round(s / 60)} min`;

/** The departure time on the clock for the time of day, "12:30". */
export const clockText = (hour: number) => `${String(Math.floor(hour) % 24).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;
