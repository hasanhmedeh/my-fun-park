// The weather for one flight and the air the aircraft flies through.
//
// makeWeather() rolls a pleasant tropical day from a seed (the flight's number, so a replayed
// flight gets the same sky), metar() writes it up the way the ATIS and the briefing card show it,
// and Air turns it into what the flight model feels: ISA density and temperature with altitude,
// a wind that grows with height above the surface, smooth gusts, and Dryden-like turbulence that
// the aircraft flies through as a frozen field drifting with the wind (so the bumps depend on
// where it is, and climbing or turning changes them, like the real thing).

import * as THREE from 'three';
import { FT, KT, SEA_Y, headingVec } from '../world/geo';
import { mulberry } from '../world/random';
import type { AirSample, Atmosphere, GroundQuery, TimeOfDay, Weather } from './types';

const R_AIR = 287.053; // J/(kg·K)
const LAPSE = 0.0065; // K per metre (ISA troposphere)
/** Height of the wind's reference (the anemometer's 10 m) and the top of the surface layer (m). */
const WIND_REF_M = 10;
const SURFACE_LAYER_M = 300;
/** How far the wind veers (turns clockwise) from the surface to the top of the friction layer (deg). */
const VEER_DEG = 12;

// ------------------------------------------------------------------------------------------------
// The day's weather
// ------------------------------------------------------------------------------------------------

/** The windiest day the game rolls (kt): a mean wind and gusts a player can still land in for fun. */
export const MAX_WIND_KT = 18;
export const MAX_GUST_KT = 25;

/**
 * Rolls the weather for a flight: winds 4–18 kt from varied directions (mostly the trade winds'
 * east and south-east, sometimes a westerly sea breeze), gusts to at most 25 kt on the windier days
 * (the crosswind on either runway is then 25 kt at worst, well inside the A320's 38 kt demonstrated), a few
 * fair-weather cumulus at 2,000–4,500 ft, good visibility with a morning mist now and then, and
 * warm tropical temperatures. The same seed always gives the same weather.
 */
export function makeWeather(seed: number, tod: TimeOfDay): Weather {
  const rnd = mulberry(Math.floor(seed * 7919 + 13) | 0);
  rnd();

  // Wind: the trades blow from 060–150 most days; one day in three it's anyone's guess.
  const trades = rnd() < 0.65;
  const windFrom = trades ? 60 + rnd() * 90 : rnd() * 360;
  // Calmer at dawn and night, freshest in the afternoon.
  const todWind = tod === 'day' ? 1 : tod === 'dusk' ? 0.9 : 0.75;
  const windKt = Math.min(MAX_WIND_KT, Math.round(4 + (MAX_WIND_KT - 4) * Math.pow(rnd(), 1.3) * todWind));
  // a METAR reports gusts 10 kt or more above the mean; the game keeps them to 25 kt (so the gusty
  // days are the moderate ones, 10–15 kt mean: on a stronger day the gusts would be past the cap)
  const gustRoll = windKt >= 10 && rnd() < 0.4;
  const gustKt = gustRoll ? Math.min(MAX_GUST_KT, windKt + Math.round(9 + rnd() * 5)) : 0;
  const gusty = gustKt >= windKt + 8;

  // Clouds: zero to two layers of FEW/SCT cumulus, a broken layer one day in seven.
  const clouds: Weather['clouds'] = [];
  const layers = rnd() < 0.15 ? 0 : rnd() < 0.55 ? 1 : 2;
  let base = 2000 + Math.round((rnd() * 1500) / 100) * 100;
  for (let i = 0; i < layers; i++) {
    const cover = i === 0 ? (rnd() < 0.6 ? 'FEW' : 'SCT') : rnd() < 0.8 ? 'SCT' : 'BKN';
    clouds.push({ cover, baseFt: Math.min(base, 4500 + i * 1500) });
    base += 1000 + Math.round((rnd() * 1500) / 100) * 100;
  }
  if (layers > 0 && rnd() < 0.14) clouds[clouds.length - 1].cover = 'BKN';

  // Visibility: 8–40 km; a dawn mist one morning in three.
  const mist = tod === 'dawn' && rnd() < 0.33;
  const visibilityM = mist ? 4000 + Math.round(rnd() * 3) * 1000 : Math.round(8000 + 32000 * Math.pow(rnd(), 0.7));

  // Warm and humid; cooler at dawn and night.
  const baseT = { dawn: 25, day: 30, dusk: 28, night: 26 }[tod];
  const tempC = Math.round(baseT + (rnd() - 0.5) * 3);
  const dewC = Math.round(tempC - (mist ? 1 + rnd() * 1.5 : 4 + rnd() * 5));
  const qnh = Math.round(1009 + rnd() * 10);

  // Over the sea the air is smooth to light chop; more on windy and gusty days and afternoons.
  const turbulence = Math.min(1, 0.08 + windKt / 45 + (gusty ? 0.2 : 0) + (tod === 'day' ? 0.08 : 0) + rnd() * 0.08);

  return { windFrom: Math.round(windFrom / 10) * 10 || 360, windKt, gustKt: gusty ? gustKt : 0, visibilityM, clouds, tempC, dewC, qnh, turbulence };
}

/** International Standard Atmosphere, calm: the reference conditions the A320's numbers assume. */
export function isaWeather(over: Partial<Weather> = {}): Weather {
  return { windFrom: 270, windKt: 0, gustKt: 0, visibilityM: 40000, clouds: [], tempC: 15, dewC: 5, qnh: 1013.25, turbulence: 0, ...over };
}

const pad = (n: number, w: number) => String(Math.round(n)).padStart(w, '0');

/**
 * The METAR for the weather at an airport, e.g. `XPCY 191300Z 25012G22KT 9999 FEW025 SCT040 29/22
 * Q1013 NOSIG`. Routine reports are issued on the hour and the half hour, so `hourUtc` (fractional)
 * is rounded down to the last issue. `day` is the day of the month (today's by default).
 */
export function metar(w: Weather, icao: string, hourUtc: number, day = new Date().getUTCDate()): string {
  const halfHours = Math.floor((((hourUtc % 24) + 24) % 24) * 2);
  const time = `${pad(day, 2)}${pad(Math.floor(halfHours / 2), 2)}${halfHours % 2 ? '30' : '00'}Z`;

  let wind: string;
  if (w.windKt < 1) wind = '00000KT';
  else if (w.windKt < 3) wind = `VRB${pad(w.windKt, 2)}KT`;
  else {
    const dir = Math.round(w.windFrom / 10) * 10 || 360;
    wind = `${pad(dir, 3)}${pad(w.windKt, 2)}${w.gustKt > w.windKt ? `G${pad(w.gustKt, 2)}` : ''}KT`;
  }

  const mist = w.visibilityM < 5000 && w.tempC - w.dewC <= 2;
  const cloudless = w.clouds.every((c) => c.baseFt >= 5000);
  const temp = (t: number) => (t < 0 ? `M${pad(-t, 2)}` : pad(t, 2));
  const tail = `${temp(w.tempC)}/${temp(w.dewC)} Q${pad(Math.floor(w.qnh), 4)} NOSIG`;

  // CAVOK: 10 km or more, no cloud below 5,000 ft, no weather.
  if (w.visibilityM >= 10000 && cloudless && !mist) return `${icao} ${time} ${wind} CAVOK ${tail}`;

  const vis = w.visibilityM >= 10000 ? '9999' : pad(w.visibilityM < 5000 ? Math.round(w.visibilityM / 100) * 100 : Math.round(w.visibilityM / 1000) * 1000, 4);
  const parts = [icao, time, wind, vis];
  if (mist) parts.push('BR');
  if (w.clouds.length) for (const c of w.clouds) parts.push(`${c.cover}${pad(c.baseFt / 100, 3)}`);
  else parts.push('NSC');
  return `${parts.join(' ')} ${tail}`;
}

/**
 * The mean wind's components along a runway (kt): `head` positive into the aircraft's face
 * (negative is a tailwind), `cross` positive when it blows from the right.
 */
export function windComponents(w: Weather, runwayHeading: number): { head: number; cross: number } {
  const a = ((w.windFrom - runwayHeading) * Math.PI) / 180;
  return { head: w.windKt * Math.cos(a), cross: w.windKt * Math.sin(a) };
}

// ------------------------------------------------------------------------------------------------
// The air
// ------------------------------------------------------------------------------------------------

/** The turbulence field's waves per velocity component (wavelengths 15 m .. 3 km). */
const WAVES = 8;
const K_MIN = (2 * Math.PI) / 3000;
const K_MAX = (2 * Math.PI) / 15;

interface Wave {
  k: number;
  dx: number;
  dz: number;
  dy: number;
  phase: number;
}

/**
 * The atmosphere for one flight. `step(dt, t)` sets the clock the gusts and the drifting
 * turbulence follow (call it once per frame with the game clock before the flight model steps);
 * `sample()` is then a pure function of position, so any number of callers (the flight model at
 * each substep, a windsock, the sea) see the same air.
 */
export class Air implements Atmosphere {
  readonly weather: Weather;
  private t = 0;
  private readonly waves: Wave[][] = [[], [], []];
  private readonly gustPhase: number[] = [];
  /** Cached ground height under the last sample (re-queried when it moves more than 40 m). */
  private gx = Number.NaN;
  private gz = Number.NaN;
  private gy = 0;
  /** Sea-level temperature (K) and pressure (Pa). */
  private readonly t0: number;
  private readonly p0: number;
  /** Dryden weights scratch (per wave). */
  private readonly wts = new Float64Array(WAVES);

  constructor(w: Weather, private readonly ground: GroundQuery, seed = 1) {
    this.weather = w;
    this.t0 = 273.15 + w.tempC;
    this.p0 = w.qnh * 100;
    const rnd = mulberry(Math.floor(seed * 104729 + w.windFrom * 31 + w.windKt * 7 + w.qnh) | 0);
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < WAVES; i++) {
        // log-spaced wavenumbers, each along a random horizontal direction and tilted a little in height
        const k = K_MIN * Math.pow(K_MAX / K_MIN, (i + rnd() * 0.8) / WAVES);
        const a = rnd() * Math.PI * 2;
        this.waves[c].push({ k, dx: Math.cos(a), dz: Math.sin(a), dy: (rnd() - 0.5) * 1.2, phase: rnd() * Math.PI * 2 });
      }
    for (let i = 0; i < 6; i++) this.gustPhase.push(rnd() * Math.PI * 2);
  }

  step(_dt: number, t: number) {
    this.t = t;
  }

  /** Gust strength now, 0 (the mean wind) .. 1 (the reported peak). */
  gustFactor(t = this.t) {
    const p = this.gustPhase;
    // three slow incommensurate swells; only their peaks reach the reported gust
    const n = 0.5 * Math.sin(0.23 * t + p[0]) + 0.3 * Math.sin(0.61 * t + p[1]) + 0.2 * Math.sin(1.37 * t + p[2]);
    return Math.min(1, Math.max(0, n) ** 2 / 0.81);
  }

  /** The surface wind now (10 m, with the gusts), as a windsock or the tower's anemometer reads it. */
  surfaceWind(t = this.t): { fromDeg: number; kt: number } {
    const w = this.weather;
    const p = this.gustPhase;
    const lull = 1 + 0.08 * Math.sin(0.41 * t + p[3]) + 0.05 * Math.sin(1.1 * t + p[4]);
    const kt = Math.max(0, w.windKt * lull + Math.max(0, w.gustKt - w.windKt) * this.gustFactor(t));
    const swing = (w.gustKt > 0 ? 9 : 5) * Math.sin(0.17 * t + p[5]);
    return { fromDeg: (((w.windFrom + swing) % 360) + 360) % 360, kt };
  }

  sample(pos: THREE.Vector3, out: AirSample): AirSample {
    const w = this.weather;
    const h = Math.max(0, pos.y - SEA_Y); // above mean sea level (m)

    // ISA with the day's sea-level temperature and QNH.
    const tK = Math.max(180, this.t0 - LAPSE * h);
    const p = this.p0 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
    out.density = p / (R_AIR * tK);
    out.oatC = tK - 273.15;
    out.soundSpeed = Math.sqrt(1.4 * R_AIR * tK);

    // Height above whatever is below (re-queried only when the point has moved a fair way).
    if (!(Math.abs(pos.x - this.gx) < 40 && Math.abs(pos.z - this.gz) < 40)) {
      this.gx = pos.x;
      this.gz = pos.z;
      this.gy = this.ground(pos.x, pos.z).y;
    }
    const agl = Math.max(0.5, pos.y - this.gy);

    // Mean wind: a 1/7 power law through the surface layer, veering with height. The gusts are the
    // surface layer's (thermals and the island's lee): they fade above it to a quarter by 3,000 ft,
    // so the cruise isn't a ride on a 15-knot swell the autothrust can't keep up with.
    const surf = this.surfaceWind();
    const hp = Math.min(agl, SURFACE_LAYER_M);
    const profile = Math.pow(hp / WIND_REF_M, 1 / 7);
    const gustPart = Math.max(0, w.gustKt - w.windKt) * this.gustFactor();
    const fade = Math.max(0.25, Math.min(1, 1 - (agl - SURFACE_LAYER_M) / 800));
    const speed = Math.max(0, surf.kt - gustPart * (1 - fade)) * KT * profile;
    const veer = VEER_DEG * Math.min(1, agl / 600);
    const to = headingVec(surf.fromDeg + veer + 180);
    let wx = to.x * speed;
    let wz = to.z * speed;
    let wy = 0;

    // Turbulence (MIL-F-8785C's Dryden model): mechanical near the surface (scaled by the wind at
    // 20 ft), the day's convective/sea turbulence above 2,000 ft, and chop at the cloud bases.
    const hFt = agl / FT;
    // the steady wind only: the reported gusts are already the slow swells of surfaceWind(), and
    // scaling the eddies by them as well would count the gustiness twice
    const w20 = w.windKt * KT * Math.pow(6.1 / WIND_REF_M, 1 / 7);
    const hl = Math.min(hFt, 1000);
    const sLow = 0.1 * w20;
    const uRatio = 1 / Math.pow(0.177 + 0.000823 * Math.max(hl, 10), 0.4);
    const sHigh = 2.4 * w.turbulence;
    const blend = hFt <= 1000 ? 0 : hFt >= 2000 ? 1 : (hFt - 1000) / 1000;
    let sw = Math.hypot(sLow * (1 - blend), sHigh * (blend + (1 - blend) * 0.45));
    let su = Math.hypot(sLow * uRatio * (1 - blend), sHigh * (blend + (1 - blend) * 0.45));
    const lw = Math.max(15, (hFt <= 1000 ? Math.max(hl, 30) : 1750) * FT * (1 - blend) + 533 * blend);
    const lu = Math.max(30, ((hl / Math.pow(0.177 + 0.000823 * Math.max(hl, 10), 1.2)) * FT) * (1 - blend) + 533 * blend);
    const alt = h / FT;
    for (const c of w.clouds) {
      const d = Math.abs(alt - c.baseFt);
      if (d < 500) {
        const k = (1 - d / 500) * (c.cover === 'FEW' ? 0.45 : c.cover === 'SCT' ? 0.75 : c.cover === 'BKN' ? 1 : 0.8);
        sw = Math.hypot(sw, 0.9 * k);
        su = Math.hypot(su, 0.6 * k);
      }
    }
    if (su > 0.01 || sw > 0.01) {
      // the field drifts with the steady reported wind (Taylor's frozen turbulence); not with the
      // gusting or height-scaled one, whose changes multiplied by the clock would sweep it past ever faster
      const drift = w.windKt * KT;
      const fx = pos.x - to.x * drift * this.t;
      const fz = pos.z - to.z * drift * this.t;
      const fy = pos.y;
      // along-wind and cross-wind components, turned into the world frame
      const ul = this.component(0, fx, fy, fz, su, lu);
      const vl = this.component(1, fx, fy, fz, su, lu);
      wx += ul * to.x - vl * to.z;
      wz += ul * to.z + vl * to.x;
      // vertical gusts die out at the ground
      wy = this.component(2, fx, fy, fz, sw, lw) * Math.min(1, agl / 20);
    }
    out.wind.set(wx, wy, wz);
    return out;
  }

  /**
   * One turbulence component at a point: the sum of the waves, weighted to the Dryden spectrum for
   * scale length L (longitudinal form for 0 and 1, vertical form for 2) and scaled to variance σ².
   */
  private component(c: number, x: number, y: number, z: number, sigma: number, L: number) {
    const ws = this.waves[c];
    const wts = this.wts;
    let sum2 = 0;
    for (let i = 0; i < WAVES; i++) {
      const kl = ws[i].k * L;
      const kl2 = kl * kl;
      // Φ(k)·k (per log-wavenumber): longitudinal 2L/(1+(kL)²), vertical L(1+3(kL)²)/(1+(kL)²)²
      const phi = c === 2 ? (kl * (1 + 3 * kl2)) / ((1 + kl2) * (1 + kl2)) : (2 * kl) / (1 + kl2);
      wts[i] = Math.sqrt(phi);
      sum2 += phi;
    }
    if (sum2 <= 0) return 0;
    const norm = sigma * Math.sqrt(2 / sum2);
    let v = 0;
    for (let i = 0; i < WAVES; i++) {
      const wv = ws[i];
      v += wts[i] * Math.sin(wv.k * (wv.dx * x + wv.dz * z + wv.dy * y) + wv.phase);
    }
    return v * norm;
  }
}
