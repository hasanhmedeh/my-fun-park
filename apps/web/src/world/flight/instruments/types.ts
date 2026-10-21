// What the cockpit's instruments read each frame, and what its FCU asks the autopilot to do.
// The flight attraction fills one CockpitData from the flight model, the autopilot, the
// navigator, the callouts and the AI traffic, and hands it to Cockpit.update().

import type { FdmSystems } from '../../../aviation/fdm';
import type { FlightPhase, Navigator } from '../../../aviation/nav';
import type { AircraftState, Controls, FcuState, IlsReading, Weather } from '../../../aviation/types';

/** One AI aircraft as the TCAS sees it (Traffic.contacts()). */
export interface TrafficContact {
  callsign: string;
  x: number;
  z: number;
  altFt: number;
  /** Vertical speed (ft/min). */
  vs: number;
}

/** The FCU knobs the visitor can select (keys 1–4) and turn. */
export type FcuKnob = 'spd' | 'hdg' | 'alt' | 'vs';

export interface CockpitData {
  s: AircraftState;
  fcu: FcuState;
  ils: IlsReading | null;
  nav: Navigator;
  traffic: TrafficContact[];
  weather: Weather;
  phase: FlightPhase;
  /** ECAM: active warnings/cautions (red/amber lines) and memos (green). */
  warnings: { text: string; level: 'warning' | 'caution' }[];
  memos: string[];
  /** The clock (UTC, "HH:MM" or "HH:MM:SS"), the chrono's running time (s) or null when it's off. */
  utc: string;
  chronoS: number | null;
  timeWarp: number;
  /** 0 by day .. 1 at night: the panel's lighting. */
  night: number;

  // ------------------------------------------------------------------ optional extras (shown when given)

  /** The flight model's systems: THS, spoiler panels, brakes, the engines' start, the protections. */
  sys?: FdmSystems;
  /** The pilot's controls: thrust lever position, flap lever, autobrake, parking brake, spoilers armed. */
  controls?: Controls;
  /** From the Autopilot: the speed target in use (the PFD's bug), "LVR CLB" and whether A/THR is active (not just armed). */
  speedTarget?: number;
  lvrClb?: boolean;
  athrActive?: boolean;
  /** From the Callouts: the master lights on the glareshield. */
  masterWarning?: boolean;
  masterCaution?: boolean;
  /** The FCU knob the keyboard has selected (highlighted on the FCU). */
  knob?: FcuKnob | null;
  /** The decision height for the approach (ft, radio). Default 200. */
  dhFt?: number;
  /** An autoland is briefed: the FMA's approach capability reads CAT 3 SINGLE, no DH. */
  autoland?: boolean;
}

/**
 * What the FCU strip and the panel's buttons ask for. `turn`'s delta is in knob clicks (±1, ±10
 * with Shift / the big buttons): the flight turns it into units — SPD 1 kt, HDG 1°, ALT 100 ft,
 * V/S 100 ft/min per click.
 */
export type FcuCommand =
  | { kind: 'ap' | 'athr' | 'loc' | 'appr' }
  | { kind: 'push' | 'pull'; knob: FcuKnob }
  | { kind: 'turn'; knob: FcuKnob; delta: number }
  | { kind: 'select'; knob: FcuKnob }
  | { kind: 'autobrake'; mode: 'lo' | 'med' | 'max' }
  | { kind: 'gear' }
  | { kind: 'chrono' };
