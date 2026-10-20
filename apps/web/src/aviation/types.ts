// The contracts between the aviation modules: the flight model (fdm.ts), the autopilot
// (autopilot.ts), the weather (weather.ts), navigation (nav.ts), scoring (scoring.ts), ATC and
// cabin speech (atc.ts), AI traffic (traffic.ts), the 3D aircraft (world/airport/a320-model.ts),
// the cockpit instruments (world/flight/instruments.ts) and the attraction that ties them together
// (world/attractions/flight.ts). Frames and units: see a320.ts and world/geo.ts.

import type * as THREE from 'three';
import type { Region } from '../world/geo';

// ------------------------------------------------------------------------------------------------
// Pilot inputs
// ------------------------------------------------------------------------------------------------

/** What the pilot (or the autopilot, for the axes) commands this frame. */
export interface Controls {
  /** Sidestick pitch, −1 (full forward, nose down) .. +1 (full back, nose up). */
  pitch: number;
  /** Sidestick roll, −1 (left) .. +1 (right). */
  roll: number;
  /** Rudder pedals, −1 (left) .. +1 (right): rudder in the air, nosewheel steering (±6°) on the ground. */
  yaw: number;
  /** Nosewheel tiller, −1 .. +1 (±75°), for slow turns on the ground. */
  tiller: number;
  /** Thrust levers, 0 (IDLE) .. 1 (TOGA); see A320.detents. Both engines move together. */
  throttle: number;
  /** Reverse thrust lever pulled, 0..1 (only acts on the ground with the levers at idle). */
  reverse: number;
  /** Toe brakes, 0..1 each. */
  brakeL: number;
  brakeR: number;
  parkingBrake: boolean;
  /** Flap lever, 0..4 = 0, 1, 2, 3, FULL. */
  flapLever: number;
  gearDown: boolean;
  /** Speed brake lever, 0..1 (in flight); ground spoilers deploy on touchdown when armed. */
  speedbrake: number;
  spoilersArmed: boolean;
  autobrake: 'off' | 'lo' | 'med' | 'max';
}

export const neutralControls = (): Controls => ({
  pitch: 0,
  roll: 0,
  yaw: 0,
  tiller: 0,
  throttle: 0,
  reverse: 0,
  brakeL: 0,
  brakeR: 0,
  parkingBrake: true,
  flapLever: 0,
  gearDown: true,
  speedbrake: 0,
  spoilersArmed: false,
  autobrake: 'off',
});

// ------------------------------------------------------------------------------------------------
// The world the aircraft flies in
// ------------------------------------------------------------------------------------------------

/** What lies under a point: its height and surface (the flight model's ground contact and friction). */
export type Surface = 'runway' | 'taxiway' | 'apron' | 'grass' | 'sand' | 'water' | 'building';
export interface GroundSample {
  /** Height of the surface (m, world y). For water: the sea's surface. */
  y: number;
  surface: Surface;
}
export type GroundQuery = (x: number, z: number) => GroundSample;

/** Weather for one flight (weather.ts makes it, the METAR describes it). */
export interface Weather {
  /** Where the wind blows FROM (degrees true) and its mean speed (kt) at 10 m. */
  windFrom: number;
  windKt: number;
  /** Peak gusts (kt), or 0. */
  gustKt: number;
  /** Visibility (m) and cloud layers (cover in oktas, base in ft). */
  visibilityM: number;
  clouds: { cover: 'FEW' | 'SCT' | 'BKN' | 'OVC'; baseFt: number }[];
  /** Sea-level temperature (°C), dew point, QNH (hPa). */
  tempC: number;
  dewC: number;
  qnh: number;
  /** Turbulence intensity over the sea, 0 (smooth) .. 1 (moderate). */
  turbulence: number;
}

/** The air at a point: wind vector (the air's velocity, m/s, world frame) and density. */
export interface AirSample {
  wind: THREE.Vector3;
  density: number;
  /** Speed of sound (m/s) and outside air temperature (°C). */
  soundSpeed: number;
  oatC: number;
}
export interface Atmosphere {
  readonly weather: Weather;
  /** Advance gusts and turbulence (call once per frame before sampling). */
  step(dt: number, t: number): void;
  sample(pos: THREE.Vector3, out: AirSample): AirSample;
}

// ------------------------------------------------------------------------------------------------
// Aircraft state (the flight model's output, read by everything else)
// ------------------------------------------------------------------------------------------------

export interface AircraftState {
  /** Reference point (see a320.ts) in world metres, and its velocity (m/s, world frame). */
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** Body → world rotation, and the same as Euler angles (degrees): pitch (nose up +), bank (right +), heading 0–360. */
  quat: THREE.Quaternion;
  pitch: number;
  bank: number;
  heading: number;
  /** Track over the ground (degrees) and flight path angle (degrees, climbing +). */
  track: number;
  fpa: number;
  /** Angular rates (deg/s): pitch rate, roll rate, yaw rate. */
  q: number;
  p: number;
  r: number;
  /** Air data: angle of attack and sideslip (deg), indicated / true airspeed (kt), ground speed (kt), Mach. */
  alpha: number;
  beta: number;
  ias: number;
  tas: number;
  gs: number;
  mach: number;
  /** Speed trend: IAS in 10 s at the current acceleration (kt). */
  iasTrend: number;
  /** Vertical speed (ft/min), altitude above the sea (ft, QNH), height of the main gear above the surface below (ft). */
  vs: number;
  altFt: number;
  radioAltFt: number;
  /** Load factor along the body's up axis (g), and lateral (g). */
  nz: number;
  ny: number;
  /** Engines: N1 0..~1.02 each, thrust per engine (N), fuel flow (kg/s total), reversers deployed 0..1. */
  n1: [number, number];
  thrust: [number, number];
  fuelFlow: number;
  reverser: number;
  /** Mass (kg) and fuel on board (kg). */
  mass: number;
  fuel: number;
  /** Actual surface positions (lagging the levers): flaps/slats deg, gear 0 (up) .. 1 (down and locked), speed brakes / ground spoilers 0..1. */
  flapsDeg: number;
  slatsDeg: number;
  config: number;
  gear: number;
  spoilers: number;
  /** Control surface deflections, −1..1 (for the 3D model). */
  aileron: number;
  elevator: number;
  rudder: number;
  /** Nosewheel steering angle (deg), main wheels' spin (rad/s). */
  nosewheel: number;
  wheelSpin: number;
  /** Gear compression (m): nose, left main, right main. */
  compression: [number, number, number];
  /** Weight on wheels: any gear, nose gear. */
  onGround: boolean;
  noseOnGround: boolean;
  /** What's under the aircraft. */
  surface: Surface;
  /** Normal-law protections and warnings active now. */
  law: 'ground' | 'flight' | 'flare';
  stallWarning: boolean;
  alphaFloor: boolean;
  overspeed: boolean;
  /** Characteristic speeds for the current mass and configuration (kt IAS): VLS, VαPROT, VαMAX, VMAX (the lowest limit), green dot, F, S. */
  speeds: { vls: number; vaprot: number; vamax: number; vmax: number; greenDot: number; f: number; s: number; vs1g: number };
  /** Simulated time since the flight model was reset (s). */
  time: number;
}

/** Things the flight model detected this step (the attraction scores them and plays sounds). */
export type FdmEvent =
  | { kind: 'touchdown'; gear: 'main' | 'nose'; vsFpm: number; g: number; bank: number; pitch: number; crabDeg: number; ias: number; pos: THREE.Vector3; surface: Surface }
  | { kind: 'liftoff'; ias: number; pos: THREE.Vector3 }
  | { kind: 'tailstrike'; pitch: number }
  | { kind: 'podstrike'; side: 'L' | 'R' }
  | { kind: 'wingstrike'; side: 'L' | 'R' }
  | { kind: 'gearLocked'; down: boolean }
  | { kind: 'crash'; reason: CrashReason; ias: number; vsFpm: number };

export type CrashReason = 'impact' | 'ditching' | 'gear-collapse' | 'belly-landing' | 'wingstrike' | 'runway-excursion' | 'overspeed' | 'obstacle';

// ------------------------------------------------------------------------------------------------
// Autopilot / FCU
// ------------------------------------------------------------------------------------------------

export type LateralMode = 'none' | 'HDG' | 'NAV' | 'LOC*' | 'LOC' | 'RWY' | 'RWY TRK';
export type VerticalMode = 'none' | 'SRS' | 'CLB' | 'OP CLB' | 'DES' | 'OP DES' | 'ALT*' | 'ALT' | 'V/S' | 'G/S*' | 'G/S' | 'FLARE';
export type ThrustMode = 'none' | 'MAN TOGA' | 'MAN FLX' | 'THR CLB' | 'THR IDLE' | 'SPEED' | 'A.FLOOR' | 'TOGA LK' | 'THR LVR';

/** The Flight Control Unit's selections and the flight mode annunciator (what the PFD shows on top). */
export interface FcuState {
  ap: boolean;
  athr: boolean;
  /** Selected targets. `null` speed = managed (the FMS speed: 250 below FL100, then the flight plan's). */
  spd: number | null;
  hdg: number;
  alt: number;
  vs: number;
  /** The LOC and APPR buttons are armed. */
  loc: boolean;
  appr: boolean;
  /** Flight mode annunciator: engaged and armed modes. */
  fma: { thrust: ThrustMode; vertical: VerticalMode; lateral: LateralMode; armedVertical: VerticalMode; armedLateral: LateralMode };
  /** Flight director bars: commanded pitch and bank (deg), or null when there's nothing to follow. */
  fdPitch: number | null;
  fdBank: number | null;
}

// ------------------------------------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------------------------------------

export interface Fix {
  name: string;
  x: number;
  z: number;
  /** Altitude constraint (ft), and the speed constraint (kt), if any. */
  altFt?: number;
  spdKt?: number;
}

/** One flight's route as the ND draws it and ATC hands it out. */
export interface FlightPlan {
  from: Region;
  to: Region;
  depRunway: '09' | '27';
  arrRunway: '09' | '27';
  /** Cruise altitude (ft) and the fixes, departure to the final approach fix. */
  cruiseFt: number;
  fixes: Fix[];
  /** Planned gate-to-gate time (s), for the on-time score. */
  blockTimeS: number;
}

/** ILS deviations for the approach in use: dots as the PFD shows them (±2), and raw values. */
export interface IlsReading {
  ident: string;
  freq: string;
  course: number;
  /** Distance to the threshold (NM, DME). */
  dme: number;
  /** Localizer deviation in dots (+: the runway is to the right) and glideslope in dots (+: the slope is above). */
  loc: number;
  gs: number;
  /** Raw lateral offset (m, + right of centreline) and height above the 3° path (ft, + above). */
  locM: number;
  gsFt: number;
  /** Whether the receiver has a signal (inside the localizer's coverage, in front of the antenna). */
  valid: boolean;
}

/**
 * What the autopilot asks the navigation (nav.ts implements it): managed guidance along the
 * flight plan, the tuned ILS, and the managed speed and altitude.
 */
export interface NavSource {
  /** The active leg: the track to fly to the next fix (deg), cross-track error (m, + right of the leg), distance to the fix (m). Null when the plan is done. */
  navLeg(state: AircraftState): { fix: Fix; track: number; xtkM: number; distM: number } | null;
  /** The ILS for the arrival runway, once in range. */
  ils(state: AircraftState): IlsReading | null;
  /** Managed speed (kt): the plan's constraints, 250 below FL100, the approach speeds by configuration. */
  managedSpeed(state: AircraftState): number;
  /** The next altitude constraint (ft), or null. */
  nextAltitude(state: AircraftState): number | null;
}

/** When the flight happens (the visitor picks it when booking); the clock goes back to 16:00 afterwards. */
export type TimeOfDay = 'dawn' | 'day' | 'dusk' | 'night';
/** Clock hours for each (the park's sun rises at 06:00 and sets at 18:00: dawn and dusk glow at ~0.93). */
export const TIME_OF_DAY_HOUR: Record<TimeOfDay, number> = { dawn: 6.5, day: 12.5, dusk: 17.5, night: 23 };

// ------------------------------------------------------------------------------------------------
// The 3D aircraft
// ------------------------------------------------------------------------------------------------

/** A fictional airline's colours, painted on the fuselage, tail and engines. */
export interface Livery {
  name: string;
  /** Short code painted on the tail / used in flight numbers. */
  code: string;
  fuselage: string;
  belly: string;
  cheatline: string;
  tail: string;
  tailArt: 'funfair' | 'palm' | 'wave' | 'star' | 'plain';
  engines: string;
  /** Registration painted aft of the doors, e.g. "FF-AIR". */
  registration: string;
}

/** What the 3D model shows: the flight model's surfaces, plus doors and lights. */
export interface PlaneVisual {
  flapsDeg: number;
  slatsDeg: number;
  /** 0 up .. 1 down and locked (doors and legs animate through the travel). */
  gear: number;
  aileron: number;
  elevator: number;
  rudder: number;
  /** Spoiler panels: 0..1 each side (speed brakes, ground spoilers, roll spoilers). */
  spoilerL: number;
  spoilerR: number;
  reverser: number;
  n1: [number, number];
  nosewheel: number;
  wheelSpin: number;
  compression: [number, number, number];
  /** Door L1 (boarding), L2 (catering): 0 closed .. 1 open. */
  doorL1: number;
  doorL2: number;
  /** Cargo hold doors open (baggage loading at the gate). */
  cargo: number;
  lights: { nav: boolean; beacon: boolean; strobe: boolean; landing: boolean; taxi: boolean; logo: boolean; cabin: boolean };
}

export interface PlaneModel {
  /** Place this group at the reference point's world position with the aircraft's quaternion. */
  readonly group: THREE.Group;
  readonly livery: Livery;
  /** Update moving parts, spinning fans and blinking lights. `t` is the game clock (s). */
  setVisual(v: PlaneVisual, dt: number, t: number): void;
  /** Hide the cabin/cockpit interior bits that would be in the cockpit camera's way. */
  setCockpitView(on: boolean): void;
  /** How bright the night lights glow (0 by day .. 1 at night). */
  setNight(k: number): void;
  dispose(): void;
}

export interface PlaneModelOptions {
  livery: Livery;
  /** 'hero': the player's aircraft (full detail); 'ai': flying/taxiing traffic; 'parked': at a stand, far away. */
  detail: 'hero' | 'ai' | 'parked';
  shadows: boolean;
}

// ------------------------------------------------------------------------------------------------
// Speech, ATC, cabin
// ------------------------------------------------------------------------------------------------

export type Speaker = 'atc' | 'fo' | 'captain' | 'cabin' | 'gpws' | 'pa';

/** One line of radio or cabin talk: shown as text, and spoken when speech is available. */
export interface Utterance {
  speaker: Speaker;
  /** Who's talking, shown before the text: "Funfair Tower", "First Officer", "Cabin". */
  from: string;
  text: string;
  /** The words spoken, if different from the text (numbers spelled out the radio way: "two seven", "niner"). */
  say?: string;
  /** Higher interrupts lower (GPWS 3, warnings 2, ATC 1, cabin 0). */
  priority?: number;
}

// ------------------------------------------------------------------------------------------------
// The flight's result
// ------------------------------------------------------------------------------------------------

/** A score item: what happened, how many points it cost (or gained), for the results' debrief. */
export interface ScoreItem {
  label: string;
  points: number;
  /** When in the flight (s). */
  at: number;
}
