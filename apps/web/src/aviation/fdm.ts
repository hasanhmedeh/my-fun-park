// The A320neo's flight model: a rigid body with six degrees of freedom flown through Airbus's
// fly-by-wire laws, on three oleo struts.
//
// The airframe is a real rigid body: lift, drag and side force from the configuration's polar,
// thrust from two LEAP-1As with lapse and spool lag, the gear's spring-dampers and tyre friction
// all act at their points, and the body turns under the moments they make. What the pilot moves is
// not a control surface but a demand, as on the real aircraft: the normal law (fly-by-wire) works
// out which elevator, aileron and rudder deflections give the demanded response by inverting the
// same aerodynamic model (nonlinear dynamic inversion), so the surfaces saturate, lose authority
// at low speed and fight the gear exactly where the real ones would.
//
//   ground law   on the wheels: the stick moves the elevator directly; rotation is about the
//                main gear, and an over-rotation scrapes the tail at ~11.5° of pitch
//   flight law   in the air: the stick demands load factor (C*), released it holds the flight
//                path, with automatic trim and turn coordination; roll rate up to 15°/s, bank held
//                up to 33° with the stick released, 67° at most; protections for pitch attitude,
//                angle of attack (α prot / α max, α floor for the autothrust) and high speed
//   flare law    below 50 ft on the way down: the stick commands pitch attitude, and from 30 ft
//                the nose is lowered 2° over 8 s, so the pilot has to flare
//
// Frames: world x east, y up, z south (metres); the body frame of a320.ts (forward −Z, up +Y,
// right +X). Internally, moments and rates use the aerospace body axes (x forward, y right,
// z down), where p is roll rate (right wing down +), q pitch rate (nose up +), r yaw rate (nose
// right +), and the usual stability derivatives keep their textbook signs.
//
// The model steps at a fixed 240 Hz whatever the frame rate, so a frame of up to 0.1 s is a
// handful of identical substeps and a replay with the same inputs flies the same flight.

import * as THREE from 'three';
import { A320, A320_POINTS } from './a320';
import { FPM, FT, KT, SEA_Y } from '../world/geo';
import type { AircraftState, AirSample, Atmosphere, Controls, CrashReason, FdmEvent, GroundQuery, GroundSample, Surface } from './types';

const G = 9.80665;
const DEG = Math.PI / 180;
const RHO0 = 1.225;
const P0 = 101325;
const A0 = 340.294;
const R_AIR = 287.053;
/** The fixed internal step (s). */
const SUB = 1 / 240;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const approach = (v: number, target: number, rate: number) => (v < target ? Math.min(target, v + rate) : Math.max(target, v - rate));
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ------------------------------------------------------------------------------------------------
// The model's own numbers (beyond a320.ts): stability derivatives, inertia, gear, engine ratings
// ------------------------------------------------------------------------------------------------

/**
 * Stability and control derivatives (per radian, aerospace axes), typical of a short/medium-haul
 * twin and tuned against the targets in a320.ts. Control inputs are normalised: elevator per
 * radian of deflection, aileron and rudder per unit of full travel (aileron + roll spoilers 1 =
 * full roll authority; rudder 1 = 30°).
 */
const AERO = {
  cm0: 0.04,
  cmAlpha: -1.1, // a static margin of ~20 % MAC
  cmQ: -35,
  /** Pitching moment of the flaps at 40° (they load the wing's trailing edge: nose down). */
  cmFlaps: -0.12,
  /** Trimmable horizontal stabiliser (THS) and elevator, per radian (positive = nose up). */
  cmThs: 2.4,
  cmElev: 0.8,
  /** Ground effect cuts the downwash at the tail, which pitches the nose down near the runway. */
  cmGround: -0.05,
  /** Fowler flaps extend the chord: the lift slope grows this much per degree of flap. */
  fowler: 0.0035,
  /** Lift gained in ground effect at zero height (scaled by the induced-drag factor's deficit). */
  groundLift: 0.25,
  clBeta0: -0.05,
  clBetaCl: -0.08, // the swept wing's dihedral effect grows with lift
  clP: -0.45,
  clRCl: 0.25,
  clAil: 0.065,
  clRud: -0.01,
  cnBeta: 0.13,
  cnR: -0.2,
  cnPCl: -0.03,
  cnRud: 0.045,
  cyBeta: -0.9,
  cyRud: -0.095,
};

/** Moments of inertia at 66 t (kg·m², aerospace axes); they scale with the mass. */
const INERTIA = { mass: 66000, xx: 1.7e6, yy: 3.2e6, zz: 4.9e6 };

/** Surface travel (degrees) and actuator rates (normalised travel per second). */
const ELEV_UP = 30;
const ELEV_DOWN = 17;
const THS_UP = 13.5;
const THS_DOWN = 4;
const THS_RATE = 0.5; // °/s of auto-trim
/** The THS setting for takeoff at the mid-range CG (degrees nose up), set on the ground. */
const THS_TAKEOFF = 0.5;
const RATE = { elev: 1.3, ail: 2.2, rud: 1.4 };

/**
 * The oleo-pneumatic struts, per gear leg (two tyres each). The oleo's gas spring is preloaded
 * (it doesn't stroke until the load passes the gas pressure at full extension) and stiffens as the
 * gas compresses (polytropic, F = preload · (gas / (gas − x))^n), so a parked A320 sits with its
 * oleos about two-thirds compressed and a hard landing meets a rapidly hardening strut. The oil
 * forced through the metering orifice damps with the square of the stroke rate (plus a linear
 * part for the slow bobbing of a taxiing aircraft), much harder on the rebound. The tyres are a
 * softer spring in series (an H46×17.0R20 deflects ~12 cm at the limit load).
 */
interface Strut {
  preload: number;
  /** Length of the gas column at full extension (m), longer than the stroke. */
  gas: number;
  kTyre: number;
  cTyre: number;
  /** Damping: linear (N per m/s) and orifice (N per (m/s)²), compressing and extending. */
  cl: number;
  cq: number;
  clExt: number;
  cqExt: number;
}
const STRUT: Record<'main' | 'nose', Strut> = {
  main: { preload: 70e3, gas: 0.47, kTyre: 2.6e6, cTyre: 1.5e4, cl: 3e4, cq: 1.0e4, clExt: 1.6e5, cqExt: 6e4 },
  nose: { preload: 20e3, gas: 0.47, kTyre: 1.3e6, cTyre: 5e3, cl: 1.2e4, cq: 8e3, clExt: 5e4, cqExt: 2e4 },
};
/** Polytropic exponent of the strut's nitrogen (between isothermal 1 and adiabatic 1.4). */
const POLY = 1.35;
const STROKE = A320_POINTS.gearStroke;
const K_BOTTOM = 3e7;
/** Main wheel tyre radius (H46×17.0R20), for the wheels' spin. */
const TYRE_R = 0.585;

/** Engine ratings: N1 for the climb and flex detents (TOGA and idle are in a320.ts), and max reverse. */
const N1_CLB = 0.9;
const N1_FLX = 0.94;
const N1_REV = 0.82;
const ENGINE_START_S = 25;
/** The engines sit this far below and ahead of the CG (m), so thrust pitches the nose up. */
const ENGINE_BELOW_CG = A320_POINTS.cg.y - A320_POINTS.engineL.y;

/** Normal-law gains (1/s). */
const LAW = {
  gamma: 0.55,
  alpha: 1.4,
  q: 2.5,
  phi: 1.3,
  p: 4,
  r: 2.2,
  beta: 1.1,
  theta: 1.4,
  /** Flare law: degrees of pitch attitude per unit of stick. */
  flareStick: 8,
};

/** Surfaces under the wheels: rolling resistance and the friction available. */
const SURF: Record<Surface, { roll: number; mu: number; brake: number; bump: number }> = {
  runway: { roll: A320.rollingFriction, mu: 0.8, brake: 0.56, bump: 0 },
  taxiway: { roll: A320.rollingFriction, mu: 0.8, brake: 0.56, bump: 0 },
  apron: { roll: A320.rollingFriction, mu: 0.8, brake: 0.56, bump: 0 },
  grass: { roll: 0.07, mu: 0.45, brake: 0.3, bump: 0.035 },
  sand: { roll: 0.16, mu: 0.4, brake: 0.25, bump: 0.02 },
  water: { roll: 0.5, mu: 0.2, brake: 0, bump: 0 },
  building: { roll: 0.5, mu: 0.6, brake: 0, bump: 0 },
};

/** The tyre contact points: nose, left main, right main (the order of the strut arrays). */
const GEAR_POINTS = [A320_POINTS.noseGear, A320_POINTS.mainGearL, A320_POINTS.mainGearR] as const;

/** Points on the airframe that can touch the ground (body frame), besides the wheels. */
const BODY_POINTS = [
  { id: 'tail', p: A320_POINTS.tailStrike },
  { id: 'podL', p: A320_POINTS.podL },
  { id: 'podR', p: A320_POINTS.podR },
  { id: 'tipL', p: A320_POINTS.tipL },
  { id: 'tipR', p: A320_POINTS.tipR },
  { id: 'nose', p: { x: 0, y: 1.9, z: -14.5 } },
  { id: 'belly', p: { x: 0, y: 1.78, z: -4 } },
  { id: 'aft', p: { x: 0, y: 2.1, z: 8 } },
] as const;
type BodyPointId = (typeof BODY_POINTS)[number]['id'];

// ------------------------------------------------------------------------------------------------
// Configurations
// ------------------------------------------------------------------------------------------------

const CONFIGS = A320.configs;
/** Flap angles of the configurations with flaps (1+F, 2, 3, FULL) and the slat angle of CONF 1. */
const FLAP_ROWS = [1, 2, 3, 4, 5];
const SLAT_1 = CONFIGS[1].slats;

/** The configuration index (into A320.configs) a flap lever position selects. */
const leverConfig = [0, 1, 3, 4, 5];

/**
 * Aerodynamic properties of the wing for actual slat and flap angles: the slats' share comes from
 * CONF 1 (slats only), the flaps' from the flapped rows, each interpolated by its own angle, so a
 * steady configuration reproduces its row in a320.ts exactly and a moving one blends smoothly.
 */
interface WingProps {
  clMax: number;
  dCl0: number;
  dCd0: number;
  alphaStall: number;
}
function wingProps(slats: number, flaps: number, out: WingProps): WingProps {
  const c0 = CONFIGS[0];
  const c1 = CONFIGS[1];
  const ks = clamp(slats / SLAT_1, 0, 1);
  out.clMax = c0.clMax + ks * (c1.clMax - c0.clMax);
  out.dCl0 = c0.dCl0 + ks * (c1.dCl0 - c0.dCl0);
  out.dCd0 = c0.dCd0 + ks * (c1.dCd0 - c0.dCd0);
  out.alphaStall = c0.alphaStall + ks * (c1.alphaStall - c0.alphaStall);
  if (flaps > 0) {
    // between the previous flapped row (or CONF 1 at 0°) and the next
    let lo: (typeof CONFIGS)[number] = c1;
    let hi: (typeof CONFIGS)[number] = CONFIGS[FLAP_ROWS[FLAP_ROWS.length - 1]];
    for (const i of FLAP_ROWS) {
      if (CONFIGS[i].flaps >= flaps) {
        hi = CONFIGS[i];
        break;
      }
      lo = CONFIGS[i];
    }
    const span = hi.flaps - lo.flaps;
    const t = span > 0 ? clamp((flaps - lo.flaps) / span, 0, 1) : 1;
    const d = (k: 'clMax' | 'dCl0' | 'dCd0' | 'alphaStall') => lo[k] - c1[k] + t * (hi[k] - lo[k]);
    out.clMax += d('clMax');
    out.dCl0 += d('dCl0');
    out.dCd0 += d('dCd0');
    out.alphaStall += d('alphaStall');
  }
  return out;
}

/** Slat and flap rates (°/s) for a surface at `deg` moving towards the next row: each step of the lever takes A320.flapTravel. */
function surfaceRate(kind: 'slats' | 'flaps', deg: number, up: boolean) {
  const stops = kind === 'slats' ? [0, 18, 22, 27] : [0, 10, 15, 20, 40];
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1];
    const hi = stops[i];
    if (up ? deg <= hi + 1e-6 && deg > lo : deg < hi && deg >= lo - 1e-6) return (hi - lo) / A320.flapTravel;
  }
  return (stops[1] - stops[0]) / A320.flapTravel;
}

// ------------------------------------------------------------------------------------------------
// Engines
// ------------------------------------------------------------------------------------------------

/** N1 the FADEC targets for a thrust lever position (forward thrust). */
export function leverN1(lever: number) {
  const d = A320.detents;
  if (lever <= d.cl) return A320.n1Idle + (N1_CLB - A320.n1Idle) * clamp(lever / d.cl, 0, 1);
  if (lever <= d.flx) return N1_CLB + ((N1_FLX - N1_CLB) * (lever - d.cl)) / (d.flx - d.cl);
  return N1_FLX + ((A320.n1Toga - N1_FLX) * clamp(lever - d.flx, 0, d.toga - d.flx)) / (d.toga - d.flx);
}

/** The lever position that gives an N1 (the inverse of leverN1; used to set the levers for a trimmed state). */
export function n1Lever(n1: number) {
  const d = A320.detents;
  if (n1 <= N1_CLB) return clamp(((n1 - A320.n1Idle) / (N1_CLB - A320.n1Idle)) * d.cl, 0, d.cl);
  if (n1 <= N1_FLX) return d.cl + ((n1 - N1_CLB) / (N1_FLX - N1_CLB)) * (d.flx - d.cl);
  return clamp(d.flx + ((n1 - N1_FLX) / (A320.n1Toga - N1_FLX)) * (d.toga - d.flx), 0, 1);
}

/** Fraction of the rated thrust an engine makes at an N1 (before lapse). */
function thrustFrac(n1: number) {
  const idle = A320.n1Idle;
  if (n1 < idle) return A320.idleThrustFrac * (n1 / idle) ** 2;
  const x = clamp((n1 - idle) / (A320.n1Toga - idle), 0, 1.05);
  return A320.idleThrustFrac + (1 - A320.idleThrustFrac) * x ** A320.thrustExp;
}

/** Thrust lapse with Mach and air density. */
function lapse(mach: number, sigma: number) {
  return Math.max(0.2, 1 - A320.lapseM * mach + A320.lapseM2 * mach * mach) * sigma ** A320.densityExp;
}

interface Engine {
  running: boolean;
  /** Seconds into the start sequence, or −1 when not starting. */
  starting: number;
  n1: number;
  thrust: number;
  flow: number;
}

// ------------------------------------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------------------------------------

/** Systems the instruments and the 3D model want beyond AircraftState. */
export interface FdmSystems {
  /** Trimmable stabiliser (degrees, nose up +). */
  ths: number;
  /** Spoiler panels per wing 0..1 (speed brakes, ground spoilers and roll spoilers together). */
  spoilerL: number;
  spoilerR: number;
  /** Ground spoilers deployed, speed brakes out (in flight). */
  groundSpoilers: number;
  speedbrake: number;
  /** Autobrake braking now (the DECEL light), and still armed. */
  autobrakeActive: boolean;
  autobrakeArmed: boolean;
  /** Brake pressure applied to the left/right main wheels 0..1. */
  brakes: [number, number];
  /** Engines: running, and the start sequence (0..1 while starting, else −1). */
  engineRunning: [boolean, boolean];
  engineStart: [number, number];
  /** The α protection is active (the stick commands angle of attack), and high-speed protection. */
  alphaProt: boolean;
  highSpeedProt: boolean;
  /** V2 for the current mass in CONF 1+F (kt), and VR (a little below it). */
  v2: number;
  vr: number;
}

/** The lever position, angle of attack and THS that held the trimmed state of the last placeInAir(). */
export interface TrimResult {
  throttle: number;
  alphaDeg: number;
  thsDeg: number;
  n1: number;
}

// ------------------------------------------------------------------------------------------------
// The flight model
// ------------------------------------------------------------------------------------------------

export class FlightModel {
  readonly state: AircraftState;
  readonly sys: FdmSystems;
  readonly trim: TrimResult = { throttle: 0, alphaDeg: 0, thsDeg: 0, n1: 0 };
  /** Why the flight ended in a crash (the model stops), or null. */
  crashed: CrashReason | null = null;

  private readonly ground: GroundQuery;
  private readonly air: Atmosphere;
  private payload: number;

  // rigid body: the CG's position and velocity (world), attitude, body rates (aerospace axes, rad/s)
  private readonly cgPos = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private p = 0;
  private q = 0;
  private r = 0;
  private acc = 0;

  // systems
  private readonly eng: [Engine, Engine] = [
    { running: false, starting: -1, n1: 0, thrust: 0, flow: 0 },
    { running: false, starting: -1, n1: 0, thrust: 0, flow: 0 },
  ];
  private slats = 0;
  private flaps = 0;
  private selConfig = 0;
  private lastLever = 0;
  private gear = 1;
  private reverser = 0;
  private spG = 0;
  private spSb = 0;
  private ths = THS_TAKEOFF * DEG;
  private elev = 0; // rad, nose up +
  private ail = 0; // −1..1, roll right +
  private rud = 0; // −1..1, nose right +
  private nosewheel = 0; // deg
  private wheelSpin = 0;
  private brakeL = 0;
  private brakeR = 0;
  private autobrakeOn = false;
  private autobrakeArmed = false;
  private autobrakeT = 0;
  private autobrakeCmd = 0;
  private lastAutobrake: Controls['autobrake'] = 'off';
  private decel = 0;

  // control law memory
  private law: AircraftState['law'] = 'ground';
  private pitchBlend = 0; // 0 direct (ground) .. 1 flight law
  private rollBlend = 0;
  private gammaRef = 0;
  private phiRef = 0;
  private protLatched = false;
  private hsProt = false;
  private flareTheta = 0;
  private flareDown = 0;
  private sinceLiftoff = 0;
  private airborneT = 0;
  private groundT = 0;

  // contact bookkeeping
  private readonly comp: [number, number, number] = [0, 0, 0];
  private readonly prevD: [number, number, number] = [0, 0, 0];
  private readonly contact: [boolean, boolean, boolean] = [false, false, false];
  private readonly touching = new Set<BodyPointId>();
  private pendingTd: { t: number; maxG: number; ev: Extract<FdmEvent, { kind: 'touchdown' }> } | null = null;
  private wasOnGround = true;
  private noseWasDown = true;

  // scratch
  private readonly airSample: AirSample = { wind: new THREE.Vector3(), density: RHO0, soundSpeed: A0, oatC: 15 };
  private readonly wing: WingProps = { clMax: 0, dCl0: 0, dCd0: 0, alphaStall: 0 };
  private readonly R = new Float64Array(9);
  private readonly F = new THREE.Vector3();
  private readonly Mw = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly dq = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly events: FdmEvent[] = [];
  private refSample: GroundSample = { y: 0, surface: 'runway' };
  private prevIas = 0;
  private iasRate = 0;

  // per-substep air data (aerospace body axes)
  private alpha = 0;
  private beta = 0;
  private qbar = 0;
  private mach = 0;
  private rho = RHO0;
  private ge = 1; // induced-drag factor in ground effect (1 out of it)
  private Ixx = INERTIA.xx;
  private Iyy = INERTIA.yy;
  private Izz = INERTIA.zz;

  constructor(opts: { ground: GroundQuery; air: Atmosphere; payloadKg?: number; fuelKg?: number }) {
    this.ground = opts.ground;
    this.air = opts.air;
    this.payload = opts.payloadKg ?? 150 * A320.paxMass;
    const fuel = opts.fuelKg ?? A320.blockFuel;
    this.state = makeState(A320.oew + this.payload + fuel, fuel);
    this.sys = {
      ths: THS_TAKEOFF,
      spoilerL: 0,
      spoilerR: 0,
      groundSpoilers: 0,
      speedbrake: 0,
      autobrakeActive: false,
      autobrakeArmed: false,
      brakes: [0, 0],
      engineRunning: [false, false],
      engineStart: [-1, -1],
      alphaProt: false,
      highSpeedProt: false,
      v2: 0,
      vr: 0,
    };
    this.updateSpeeds();
  }

  // ---------------------------------------------------------------------------------------------- setup

  /** Passengers on board and fuel (kg). */
  setLoad(passengers: number, fuelKg: number) {
    this.payload = clamp(passengers, 0, A320.seats) * A320.paxMass;
    this.state.fuel = clamp(fuelKg, 0, A320.maxFuel);
    this.state.mass = A320.oew + this.payload + this.state.fuel;
    this.updateSpeeds();
  }

  /** Stand the aircraft on the ground at rest, gear down, flaps up, with the THS set for takeoff. */
  placeOnGround(x: number, z: number, heading: number, opts: { enginesRunning?: boolean } = {}) {
    this.reset();
    const running = opts.enginesRunning ?? false;
    for (const e of this.eng) {
      e.running = running;
      e.starting = -1;
      e.n1 = running ? A320.n1Idle : 0;
    }
    this.gear = 1;
    this.ths = THS_TAKEOFF * DEG;
    this.law = 'ground';
    this.pitchBlend = 0;
    this.rollBlend = 0;
    // settle on the struts' static deflection so a parked aircraft doesn't bounce on the first frame
    this.refSample = this.ground(x, z);
    const gy = this.refSample.y;
    const m = this.state.mass;
    const noseShare = (A320_POINTS.cg.z - A320_POINTS.mainGearL.z) / (A320_POINTS.noseGear.z - A320_POINTS.mainGearL.z);
    const dMain = staticDeflection(STRUT.main, (m * G * (1 - noseShare)) / 2);
    const dNose = staticDeflection(STRUT.nose, m * G * noseShare);
    const pitch = Math.atan2(dMain - dNose, A320.wheelbase);
    this.quat.setFromEuler(this.euler.set(pitch, -heading * DEG, 0, 'YXZ'));
    this.tmp.set(x, gy - dMain, z);
    this.setRef(this.tmp);
    this.vel.set(0, 0, 0);
    this.wasOnGround = true;
    this.noseWasDown = true;
    this.contact[0] = this.contact[1] = this.contact[2] = true;
    this.prevD[0] = dNose;
    this.prevD[1] = this.prevD[2] = dMain;
    this.derive(0, true);
  }

  /**
   * Put the aircraft in the air in trimmed, unaccelerated level flight: attitude, THS and thrust
   * solved for 1 g at this speed and configuration. `trim.throttle` is the lever position that
   * holds it (set the levers there, or let the autothrust take over).
   */
  placeInAir(x: number, z: number, altFt: number, heading: number, ias: number, flapLever: number, gearDown: boolean) {
    this.reset();
    for (const e of this.eng) {
      e.running = true;
      e.starting = -1;
    }
    this.gear = gearDown ? 1 : 0;
    const lever = clamp(Math.round(flapLever), 0, 4);
    this.selConfig = leverConfig[lever];
    this.lastLever = lever;
    this.slats = CONFIGS[this.selConfig].slats;
    this.flaps = CONFIGS[this.selConfig].flaps;
    this.law = 'flight';
    this.pitchBlend = 1;
    this.rollBlend = 1;
    this.sinceLiftoff = 1000;
    this.airborneT = 1000;
    this.wasOnGround = false;
    this.noseWasDown = false;
    this.contact[0] = this.contact[1] = this.contact[2] = false;
    const y = SEA_Y + altFt * FT;
    this.cgPos.set(x, y, z);
    this.refSample = this.ground(x, z);
    this.air.sample(this.cgPos, this.airSample);
    const rho = this.airSample.density;
    const tas = this.casToTas(ias * KT, rho, this.airSample.soundSpeed);
    const wind = this.airSample.wind;
    const hv = { x: Math.sin(heading * DEG), z: -Math.cos(heading * DEG) };

    // Solve α, thrust and THS for L + T sin α = W, T cos α = D, M = 0 (a few fixed-point passes).
    this.rho = rho;
    this.qbar = 0.5 * rho * tas * tas;
    this.mach = tas / this.airSample.soundSpeed;
    this.ge = 1;
    this.beta = 0;
    wingProps(this.slats, this.flaps, this.wing);
    const W = this.state.mass * G;
    const S = A320.wingArea;
    let alpha = 4 * DEG;
    let T = 0.08 * W;
    for (let i = 0; i < 30; i++) {
      const clReq = (W - T * Math.sin(alpha)) / (this.qbar * S);
      alpha = this.invertCl(clReq, alpha);
      const cl = this.cl(alpha);
      T = (this.qbar * S * this.cd(cl, alpha)) / Math.cos(alpha);
    }
    const sigma = rho / RHO0;
    const perEngine = T / 2 / (A320.maxThrust * lapse(this.mach, sigma));
    const n1 = this.fracToN1(perEngine);
    for (const e of this.eng) e.n1 = n1;
    // the THS that zeroes the pitching moment with the elevator neutral (thrust pitches the nose up)
    const cmNoThs = this.cmBase(alpha, 0, tas) + (T * ENGINE_BELOW_CG) / (this.qbar * S * A320.mac);
    this.ths = clamp(-cmNoThs / AERO.cmThs, -THS_DOWN * DEG, THS_UP * DEG);
    this.elev = 0;

    this.quat.setFromEuler(this.euler.set(alpha, -heading * DEG, 0, 'YXZ'));
    // the altitude is the reference point's (between the main wheels), like the state's altFt
    this.tmp.set(x, y, z);
    this.setRef(this.tmp);
    this.vel.set(hv.x * tas + wind.x, 0, hv.z * tas + wind.z);
    this.gammaRef = 0;
    this.phiRef = 0;
    this.trim.throttle = n1Lever(n1);
    this.trim.alphaDeg = alpha / DEG;
    this.trim.thsDeg = this.ths / DEG;
    this.trim.n1 = n1;
    this.derive(0, true);
    this.prevIas = this.state.ias;
  }

  /**
   * Move the aircraft along a pushback (kinematic, on the ground): the nosewheel swivels to follow
   * the tow, the wheels turn and the engines keep spooling. The next step() carries on from here.
   */
  tow(x: number, z: number, heading: number, dt: number) {
    if (this.crashed || dt <= 0) return;
    const s = this.state;
    const oldX = s.pos.x;
    const oldZ = s.pos.z;
    const dh = ((((heading - s.heading) % 360) + 540) % 360) - 180;
    this.refSample = this.ground(x, z);
    const gy = this.refSample.y;
    const pitch = s.pitch * DEG;
    this.quat.setFromEuler(this.euler.set(pitch, -heading * DEG, 0, 'YXZ'));
    this.tmp.set(x, gy - this.prevD[1], z);
    this.setRef(this.tmp);
    this.vel.set((x - oldX) / dt, 0, (z - oldZ) / dt);
    this.p = 0;
    this.q = 0;
    this.r = (dh * DEG) / dt;
    // the nose gear's velocity over the ground, in the body's frame, gives the swivel angle
    const fx = Math.sin(heading * DEG);
    const fz = -Math.cos(heading * DEG);
    const arm = -A320_POINTS.noseGear.z; // m ahead of the reference point
    const vLong = this.vel.x * fx + this.vel.z * fz;
    const vLat = this.vel.x * -fz + this.vel.z * fx + this.r * arm;
    if (Math.abs(vLong) + Math.abs(vLat) > 0.02) this.nosewheel = clamp(Math.atan(vLat / (Math.abs(vLong) > 1e-3 ? vLong : 1e-3)) / DEG, -A320.tillerMax, A320.tillerMax);
    this.wheelSpin = vLong / TYRE_R;
    for (let i = 0; i < dt / SUB - 1e-9; i++) this.engines(SUB, 0, 0, true);
    this.state.time += dt;
    this.law = 'ground';
    this.derive(dt, true);
  }

  /** Start an engine: N1 rises from 0 to idle in about 25 s (a compressed start sequence). */
  startEngine(i: 0 | 1) {
    const e = this.eng[i];
    if (e.running || e.starting >= 0) return;
    e.starting = 0;
  }

  /** Shut an engine down (fuel off): N1 spools down to zero. */
  stopEngine(i: 0 | 1) {
    const e = this.eng[i];
    e.running = false;
    e.starting = -1;
  }

  /**
   * Set the vertical speed (fpm), keeping the horizontal velocity: a hard-landing drill for the
   * tests, and what a debrief replay uses to put the aircraft back on its recorded path.
   */
  setVerticalSpeed(fpm: number) {
    this.vel.y = fpm * FPM;
    // the normal law holds the new flight path (as if the pilot had flown onto it)
    this.gammaRef = Math.asin(clamp(this.vel.y / Math.max(1, this.vel.length()), -1, 1));
    this.derive(0, true);
  }

  /**
   * Lift and drag coefficients of the configuration the surfaces are in now, at an angle of attack
   * (deg), gear as it is, out of ground effect and with the spoilers retracted: the model's polar, for the tests
   * and the speed scale.
   */
  polar(alphaDeg: number): { cl: number; cd: number } {
    const ge = this.ge;
    const spG = this.spG;
    const spSb = this.spSb;
    const beta = this.beta;
    const mach = this.mach;
    this.ge = 1;
    this.spG = 0;
    this.spSb = 0;
    this.beta = 0;
    this.mach = 0.2;
    wingProps(this.slats, this.flaps, this.wing);
    const a = alphaDeg * DEG;
    const cl = this.cl(a);
    const cd = this.cd(cl, a);
    this.ge = ge;
    this.spG = spG;
    this.spSb = spSb;
    this.beta = beta;
    this.mach = mach;
    return { cl, cd };
  }

  // ---------------------------------------------------------------------------------------------- step

  /** Advance by a frame (any dt up to 0.1 s) at the fixed internal rate. Returns what happened. */
  step(dt: number, c: Controls): FdmEvent[] {
    this.events.length = 0;
    if (this.crashed) {
      this.state.time += dt;
      return this.events;
    }
    this.acc += clamp(dt, 0, 0.1);
    while (this.acc >= SUB - 1e-9 && !this.crashed) {
      this.acc -= SUB;
      this.substep(c);
    }
    return this.events;
  }

  private substep(c: Controls) {
    const h = SUB;
    const s = this.state;
    s.time += h;
    this.air.step(h, s.time);

    // mass and inertia
    const m = s.mass;
    const ki = m / INERTIA.mass;
    this.Ixx = INERTIA.xx * ki;
    this.Iyy = INERTIA.yy * ki;
    this.Izz = INERTIA.zz * ki;

    this.rotation();
    const R = this.R;

    // ---------------------------------------------------------------- air data
    this.air.sample(this.cgPos, this.airSample);
    const as = this.airSample;
    this.rho = as.density;
    // relative wind in the body frame (three's axes), then aerospace axes
    const vx = this.vel.x - as.wind.x;
    const vy = this.vel.y - as.wind.y;
    const vz = this.vel.z - as.wind.z;
    const bx = R[0] * vx + R[3] * vy + R[6] * vz;
    const by = R[1] * vx + R[4] * vy + R[7] * vz;
    const bz = R[2] * vx + R[5] * vy + R[8] * vz;
    const u = -bz;
    const v = bx;
    const w = -by;
    const V = Math.sqrt(u * u + v * v + w * w);
    this.alpha = V > 2 ? Math.atan2(w, u) : 0;
    this.beta = V > 2 ? Math.asin(clamp(v / V, -1, 1)) : 0;
    this.qbar = 0.5 * this.rho * V * V;
    this.mach = V / as.soundSpeed;

    // ---------------------------------------------------------------- ground under the aircraft
    const ref = this.refPoint(this.tmp2);
    this.refSample = this.ground(ref.x, ref.z);
    const gyRef = this.refSample.y + bumpAt(this.refSample.surface, ref.x, ref.z);
    const raM = ref.y - gyRef;
    const hWing = Math.max(0.5, raM + 3.2);
    const ge = (16 * hWing) / A320.span;
    this.ge = (ge * ge) / (1 + ge * ge);

    // ---------------------------------------------------------------- systems
    this.systems(h, c, raM);

    // ---------------------------------------------------------------- forces (world) and moments (aerospace body axes)
    const F = this.F.set(0, -m * G, 0);
    let Mx = 0;
    let My = 0;
    let Mz = 0;

    // gear and airframe contacts
    const gearM = this.gearForces(F, raM);
    Mx += gearM.x;
    My += gearM.y;
    Mz += gearM.z;

    // thrust along the body's x axis, below and ahead of the CG
    const T0 = this.eng[0].thrust;
    const T1 = this.eng[1].thrust;
    const T = T0 + T1;
    this.addBody(F, T, 0, 0);
    My += T * ENGINE_BELOW_CG;
    Mz += (T0 - T1) * Math.abs(A320_POINTS.engineL.x);

    // aerodynamics without the controls
    const S = A320.wingArea;
    const b = A320.span;
    const cbar = A320.mac;
    wingProps(this.slats, this.flaps, this.wing);
    const alpha = this.alpha;
    const beta = this.beta;
    const cl = this.cl(alpha);
    const cd = this.cd(cl, alpha);
    const Vs = Math.max(V, 1);
    const pHat = (this.p * b) / (2 * Vs);
    const rHat = (this.r * b) / (2 * Vs);
    const sb = Math.sin(beta);
    const qS = this.qbar * S;
    const cy = AERO.cyBeta * sb;
    const clRoll = (AERO.clBeta0 + AERO.clBetaCl * clamp(cl, 0, 2)) * sb + AERO.clP * pHat + AERO.clRCl * clamp(cl, 0, 2) * rHat;
    const cn = AERO.cnBeta * sb + AERO.cnR * rHat + AERO.cnPCl * clamp(cl, 0, 2) * pHat;
    const cm = this.cmBase(alpha, this.q, Vs) + AERO.cmThs * this.ths;
    let mAx = Mx + qS * b * clRoll;
    let mAy = My + qS * cbar * cm;
    let mAz = Mz + qS * b * cn;

    // ---------------------------------------------------------------- control laws → surfaces
    this.controlLaws(h, c, mAx, mAy, mAz, raM, T);
    mAy += qS * cbar * AERO.cmElev * this.elev;
    mAx += qS * b * (AERO.clAil * this.ail + AERO.clRud * this.rud);
    mAz += qS * b * AERO.cnRud * this.rud;
    const cyTot = cy + AERO.cyRud * this.rud;

    // aerodynamic forces in body axes: lift ⟂ the relative wind, drag along it
    if (V > 1) {
      const L = qS * cl;
      const D = qS * cd;
      const Y = qS * cyTot;
      const ca = Math.cos(alpha);
      const sa = Math.sin(alpha);
      // aerospace: lift (sin α, 0, −cos α), drag −V̂, side force +y
      const fx = L * sa - (D * u) / V;
      const fy = Y - (D * v) / V;
      const fz = -L * ca - (D * w) / V;
      this.addBody(F, fx, fy, fz);
    }

    // ---------------------------------------------------------------- integrate
    const ax = F.x / m;
    const ay = F.y / m;
    const az = F.z / m;
    this.vel.x += ax * h;
    this.vel.y += ay * h;
    this.vel.z += az * h;
    this.cgPos.addScaledVector(this.vel, h);

    const Ixx = this.Ixx;
    const Iyy = this.Iyy;
    const Izz = this.Izz;
    const pd = (mAx - (Izz - Iyy) * this.q * this.r) / Ixx;
    const qd = (mAy - (Ixx - Izz) * this.r * this.p) / Iyy;
    const rd = (mAz - (Iyy - Ixx) * this.p * this.q) / Izz;
    this.p += pd * h;
    this.q += qd * h;
    this.r += rd * h;
    // body rates in three's axes: (q, −r, −p)
    const ox = this.q * h;
    const oy = -this.r * h;
    const oz = -this.p * h;
    const ang = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (ang > 1e-12) {
      const sn = Math.sin(ang / 2) / ang;
      this.dq.set(ox * sn, oy * sn, oz * sn, Math.cos(ang / 2));
      this.quat.multiply(this.dq).normalize();
    }

    // specific force along the body's up and right axes (what the passengers feel)
    const fsx = F.x / m;
    const fsy = F.y / m + G;
    const fsz = F.z / m;
    this.rotation();
    s.nz = (R[3] * fsx + R[4] * fsy + R[5] * fsz) / G;
    s.ny = (R[0] * fsx + R[1] * fsy + R[2] * fsz) / G;

    this.holdStill(T);
    this.derive(h, false);
    this.checkEvents(h);
  }

  // ---------------------------------------------------------------------------------------------- aerodynamics

  /** Lift coefficient at an angle of attack for the current wing (configuration, spoilers, ground effect). */
  private cl(alpha: number) {
    const wp = this.wing;
    const slope = A320.clAlpha * (1 + AERO.fowler * this.flaps);
    const c0 = A320.cl0 + wp.dCl0;
    const aS = wp.alphaStall * DEG;
    // the linear lift curve rounds off to CLmax at the stall angle (slope-continuous)
    let aB = (2 * (wp.clMax - c0)) / slope - aS;
    if (aB > aS - 2 * DEG) aB = aS - 2 * DEG;
    let cl: number;
    if (alpha <= aB) {
      cl = c0 + slope * Math.max(alpha, -0.22);
    } else if (alpha <= aS) {
      const clB = c0 + slope * aB;
      const k = (aS - alpha) / (aS - aB);
      cl = wp.clMax - (wp.clMax - clB) * k * k;
    } else {
      const d = alpha - aS;
      cl = Math.max(0.68 * wp.clMax, wp.clMax - 14 * d * d);
    }
    cl *= 1 + AERO.groundLift * (1 - this.ge);
    cl = cl * (1 - (1 - A320.groundSpoilerLiftFactor) * this.spG) + A320.speedbrakeDCl * this.spSb;
    return cl;
  }

  /** Drag coefficient for a lift coefficient (and the angle of attack, for the stall's drag rise). */
  private cd(cl: number, alpha: number) {
    const wp = this.wing;
    const aS = wp.alphaStall * DEG;
    let cd = A320.cd0 + wp.dCd0 + A320.gearCd0 * this.gear + A320.speedbrakeCd0 * this.spSb + A320.groundSpoilerCd0 * this.spG;
    cd += A320.k * this.ge * cl * cl;
    if (alpha > aS) cd += 1.4 * (alpha - aS);
    const sb = Math.sin(this.beta);
    cd += 0.35 * sb * sb;
    const mDiv = 0.74;
    if (this.mach > mDiv) cd += 20 * (this.mach - mDiv) ** 4;
    return cd;
  }

  /** Pitching moment coefficient without the THS and elevator. */
  private cmBase(alpha: number, q: number, V: number) {
    const aS = this.wing.alphaStall * DEG;
    let cm = AERO.cm0 + AERO.cmAlpha * alpha + AERO.cmFlaps * (this.flaps / 40) + AERO.cmQ * ((q * A320.mac) / (2 * Math.max(V, 1)));
    cm += AERO.cmGround * (1 - this.ge);
    if (alpha > aS) cm -= 0.6 * (alpha - aS); // the stall breaks nose-down
    return cm;
  }

  /** The angle of attack that gives a lift coefficient (Newton on the real curve, capped at the stall). */
  private invertCl(clReq: number, guess: number) {
    const aS = this.wing.alphaStall * DEG;
    let a = clamp(guess, -0.2, aS);
    for (let i = 0; i < 3; i++) {
      const f = this.cl(a) - clReq;
      const d = (this.cl(a + 0.002) - this.cl(a - 0.002)) / 0.004;
      a = clamp(a - f / Math.max(d, 1.2), -0.2, aS);
    }
    return a;
  }

  // ---------------------------------------------------------------------------------------------- systems

  private systems(h: number, c: Controls, raM: number) {
    const s = this.state;
    const ias = s.ias;
    const onGround = this.contact[1] || this.contact[2];

    // flaps and slats: the lever picks a configuration, the surfaces travel to it
    const lever = clamp(Math.round(c.flapLever), 0, 4);
    if (lever !== this.lastLever) {
      if (lever === 1) this.selConfig = this.lastLever === 0 ? (onGround || ias < 100 ? 2 : 1) : ias < 210 ? 2 : 1;
      else this.selConfig = leverConfig[lever];
      this.lastLever = lever;
    }
    // CONF 1+F retracts its flaps by itself at 210 kt
    if (this.selConfig === 2 && ias > 210 && !onGround) this.selConfig = 1;
    const tc = CONFIGS[this.selConfig];
    const slatUp = tc.slats > this.slats;
    const flapUp = tc.flaps > this.flaps;
    this.slats = approach(this.slats, tc.slats, surfaceRate('slats', this.slats, slatUp) * h);
    this.flaps = approach(this.flaps, tc.flaps, surfaceRate('flaps', this.flaps, flapUp) * h);

    // landing gear (the lever can't raise it with weight on the wheels)
    const gearTarget = c.gearDown || onGround ? 1 : 0;
    const before = this.gear;
    this.gear = approach(this.gear, gearTarget, h / A320.gearTravel);
    if (before < 1 && this.gear === 1) this.events.push({ kind: 'gearLocked', down: true });
    if (before > 0 && this.gear === 0) this.events.push({ kind: 'gearLocked', down: false });

    // thrust reversers: on the ground with the levers at idle
    const idle = c.throttle < 0.05;
    const wantRev = onGround && raM < 2 && idle && c.reverse > 0.05;
    this.reverser = approach(this.reverser, wantRev ? 1 : 0, h / 2);

    // engines
    this.engines(h, c.throttle, c.reverse, false);

    // ground spoilers: armed (or reverse selected) at touchdown with the levers at idle; or a rejected takeoff above 72 kt
    let wantG = this.spG > 0.5 ? 1 : 0;
    if (onGround && idle && (c.spoilersArmed || c.reverse > 0.05)) wantG = 1;
    if (c.throttle > 0.3 || (!onGround && this.airborneT > 0.5) || (!c.spoilersArmed && c.reverse <= 0.05)) wantG = 0;
    this.spG = approach(this.spG, wantG, h / 0.8);
    // speed brakes in flight: inhibited in CONF FULL, under α protection and at TOGA
    const sbInhibit = this.selConfig === 5 || this.protLatched || c.throttle > A320.detents.flx + 0.05 || onGround;
    this.spSb = approach(this.spSb, sbInhibit ? 0 : clamp(c.speedbrake, 0, 1), h / 2);

    // brakes: pedals, the parking brake, and the autobrake
    // selecting a setting arms it; it disarms on the pedals, with the levers advanced, and after takeoff
    if (c.autobrake !== this.lastAutobrake) {
      this.lastAutobrake = c.autobrake;
      this.autobrakeArmed = c.autobrake !== 'off';
      this.autobrakeOn = false;
    }
    if (this.autobrakeArmed && this.airborneT > 5 && this.airborneT < 5.1 && this.sinceLiftoff < 6) this.autobrakeArmed = false;
    const pedals = Math.max(c.brakeL, c.brakeR);
    if ((this.autobrakeOn || this.autobrakeArmed) && (pedals > 0.6 || (onGround && c.throttle > A320.detents.cl - 0.05))) {
      this.autobrakeOn = false;
      this.autobrakeArmed = false;
    }
    if (this.autobrakeArmed && this.spG > 0.5) {
      this.autobrakeOn = true;
      this.autobrakeArmed = false;
      this.autobrakeT = 0;
      this.autobrakeCmd = 0;
    }
    let auto = 0;
    if (this.autobrakeOn) {
      this.autobrakeT += h;
      const target = c.autobrake === 'lo' ? A320.autobrake.lo : c.autobrake === 'med' ? A320.autobrake.med : A320.autobrake.max;
      const delay = c.autobrake === 'lo' ? A320.autobrakeLoDelay : 0;
      if (this.autobrakeT > delay) {
        // brake pressure follows the deceleration error (stopping the aircraft and holding it there)
        const err = target - this.decel;
        this.autobrakeCmd = clamp(this.autobrakeCmd + (err * 0.9 + (s.gs < 1 ? 1 : 0)) * h, 0, 1);
        if (c.autobrake === 'max') this.autobrakeCmd = Math.max(this.autobrakeCmd, clamp(this.autobrakeT / 1.5, 0, 1));
      }
      auto = this.autobrakeCmd;
    }
    const park = c.parkingBrake ? 1 : 0;
    this.brakeL = Math.max(c.brakeL, auto, park);
    this.brakeR = Math.max(c.brakeR, auto, park);
    // the wheels are braked automatically as the gear retracts
    if (!onGround && this.gear < 1) this.wheelSpin *= Math.exp(-h * 3);
    else if (!onGround) this.wheelSpin *= Math.exp(-h * 0.15);

    // nosewheel steering: tiller ±75° (fading out by 70 kt), pedals ±6° (fading out by 130 kt)
    const gsKt = s.gs;
    const tillerK = 1 - smooth((gsKt - 20) / 50);
    const pedalK = 1 - smooth((gsKt - 40) / 90);
    const steer = this.contact[0] ? clamp(c.tiller * A320.tillerMax * tillerK + c.yaw * A320.pedalSteerMax * pedalK, -A320.tillerMax, A320.tillerMax) : 0;
    this.nosewheel = approach(this.nosewheel, steer, 30 * h);
  }

  /** N1 dynamics (start, spool up/down with the lever, reverse) and each engine's thrust and fuel flow. */
  private engines(h: number, throttle: number, reverse: number, towing: boolean) {
    const sigma = this.rho / RHO0;
    const lap = lapse(this.mach, sigma);
    const revTarget = this.reverser > 0.95 ? A320.n1Idle + clamp((reverse - 0.15) / 0.85, 0, 1) * (N1_REV - A320.n1Idle) : A320.n1Idle;
    const fwdTarget = this.reverser > 0.02 || towing ? A320.n1Idle : leverN1(throttle);
    const target = this.reverser > 0.02 ? revTarget : fwdTarget;
    let flow = 0;
    for (let i = 0; i < 2; i++) {
      const e = this.eng[i];
      if (e.starting >= 0) {
        // starter, light-off at ~8 s, then acceleration to idle
        e.starting += h;
        const t = e.starting;
        e.n1 = A320.n1Idle * (0.18 * Math.min(1, t / 6) + 0.82 * smooth((t - 7) / (ENGINE_START_S - 7)));
        if (t >= ENGINE_START_S) {
          e.starting = -1;
          e.running = true;
          e.n1 = A320.n1Idle;
        }
      } else if (e.running) {
        const tau = target > e.n1 ? A320.spoolUp : A320.spoolDown;
        // a turbofan accelerates slowly at first from idle (the fan's inertia, the FADEC's schedule)
        const slow = target > e.n1 ? 1 + 0.6 * (1 - clamp((e.n1 - A320.n1Idle) / 0.3, 0, 1)) : 1;
        e.n1 += ((target - e.n1) * h) / (tau * slow);
      } else {
        e.n1 = Math.max(0, e.n1 - e.n1 * h * 0.12 - h * 0.002);
      }
      const frac = e.starting >= 0 && e.n1 < A320.n1Idle * 0.6 ? 0 : thrustFrac(e.n1);
      const fwd = A320.maxThrust * lap * frac;
      // the reverser blocks the fan stream and turns it forward
      const revK = this.reverser;
      e.thrust = fwd * (1 - revK) - revK * A320.reverseFrac * A320.maxThrust * lap * (frac / thrustFrac(N1_REV));
      e.flow = e.running || e.starting >= 0 ? (A320.fuelIdle + (A320.fuelToga - A320.fuelIdle) * clamp((frac - A320.idleThrustFrac) / (1 - A320.idleThrustFrac), 0, 1.1)) * (0.25 + 0.75 * sigma) : 0;
      if (e.starting >= 0) e.flow *= clamp((e.starting - 7) / 10, 0, 1);
      flow += e.flow;
    }
    const s = this.state;
    s.fuel = Math.max(0, s.fuel - flow * h);
    s.mass = A320.oew + this.payload + s.fuel;
    if (s.fuel <= 0) for (const e of this.eng) e.running = false;
    s.fuelFlow = flow;
  }

  // ---------------------------------------------------------------------------------------------- gear and contacts

  /**
   * Struts (spring-damper with preload, tyres in series), tyre friction (rolling, brakes,
   * cornering) and the airframe's hard points. Adds the forces to F (world) and returns the moment
   * about the CG in aerospace body axes.
   */
  private gearForces(F: THREE.Vector3, raM: number) {
    const Mw = this.Mw.set(0, 0, 0);
    const R = this.R;
    const s = this.state;
    const ref = this.refPoint(this.tmp2);
    // forward and right on the ground (the body's −Z axis in the world: the third column of R)
    const fwx = -R[2];
    const fwz = -R[8];
    const fl = Math.hypot(fwx, fwz) || 1;
    const fx = fwx / fl;
    const fz = fwz / fl;
    const gearDown = this.gear >= 0.999;
    this.contact[0] = this.contact[1] = this.contact[2] = false;
    let driveCapacity = 0;
    if (raM < 8) {
      for (let i = 0; i < 3; i++) {
        const gp = GEAR_POINTS[i];
        const wx = ref.x + R[0] * gp.x + R[1] * gp.y + R[2] * gp.z;
        const wy = ref.y + R[3] * gp.x + R[4] * gp.y + R[5] * gp.z;
        const wz = ref.z + R[6] * gp.x + R[7] * gp.y + R[8] * gp.z;
        const gs = this.ground(wx, wz);
        const gy = gs.y + bumpAt(gs.surface, wx, wz);
        const D = gy - wy;
        if (D <= 0 || !gearDown) {
          this.comp[i] = 0;
          this.prevD[i] = Math.max(0, D);
          continue;
        }
        this.contact[i] = true;
        const st = i === 0 ? STRUT.nose : STRUT.main;
        // point velocity: v + ω × r (world)
        const rx = wx - this.cgPos.x;
        const ry = wy - this.cgPos.y;
        const rz = wz - this.cgPos.z;
        const wv = this.worldOmega(this.tmp);
        const pvx = this.vel.x + wv.y * rz - wv.z * ry;
        const pvy = this.vel.y + wv.z * rx - wv.x * rz;
        const pvz = this.vel.z + wv.x * ry - wv.y * rx;
        const Ddot = -pvy;
        // the tyre alone up to the preload, then tyre and oleo in series (sharing the deflection)
        let N: number;
        if (D <= st.preload / st.kTyre) {
          N = st.kTyre * D + st.cTyre * Ddot;
          this.comp[i] = 0;
        } else {
          const x = strokeFor(st, D, this.comp[i]);
          const kO = oleoStiffness(st, x);
          // the share of the closing rate the oleo takes (the stiffer the gas, the more the tyre gives)
          const xd = (Ddot * st.kTyre) / (st.kTyre + kO);
          const damp = xd >= 0 ? xd * (st.cl + st.cq * xd) : xd * (st.clExt - st.cqExt * xd);
          N = oleoForce(st, x) + damp + st.cTyre * (Ddot - xd);
          this.comp[i] = Math.min(x, STROKE);
        }
        N = Math.max(0, N);
        this.prevD[i] = D;
        const surf = SURF[gs.surface];
        // the wheel's rolling direction (the nosewheel steers)
        let dx = fx;
        let dz = fz;
        if (i === 0) {
          const a = this.nosewheel * DEG;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          // rotate forward towards the right by a: right = (−fz, fx)
          dx = fx * ca + -fz * sa;
          dz = fz * ca + fx * sa;
        }
        const vLong = pvx * dx + pvz * dz;
        const vLat = pvx * -dz + pvz * dx;
        const brake = i === 0 ? 0 : i === 1 ? this.brakeL : this.brakeR;
        const brakeF = brake * Math.min(surf.brake * N, (A320.maxBrakeDecel * s.mass) / 2);
        // A tyre's rolling resistance grows with speed (the carcass flexing faster), from about two
        // thirds of the rated value at walking pace; standing, a flattened tyre takes a push more to
        // break away. So an A320 needs ~35 % N1 to start rolling, then creeps faster at idle.
        const sp = Math.abs(vLong);
        const rollF = surf.roll * N * (0.65 + 0.35 * Math.min(1, sp / 20) + (sp < 0.3 ? 0.7 * (1 - sp / 0.3) : 0));
        let fLong = -((rollF + brakeF) * vLong) / Math.sqrt(vLong * vLong + 0.0016);
        // cornering: the side force builds with the slip angle (tan = vLat / vLong), saturating at μN;
        // the nose's small tyres are softer than the mains', which keeps a braked rollout stable
        const vRef = 0.15 + Math.abs(vLong) * (i === 0 ? 0.2 : 0.12);
        let fLat = (-surf.mu * N * vLat) / Math.sqrt(vLat * vLat + vRef * vRef);
        const fMax = surf.mu * N;
        const fTot = Math.hypot(fLong, fLat);
        if (fTot > fMax) {
          fLong *= fMax / fTot;
          fLat *= fMax / fTot;
        }
        driveCapacity += (i === 0 ? 0.02 : 0.02 + brake * surf.brake) * N;
        const fwX = fLong * dx + fLat * -dz;
        const fwZ = fLong * dz + fLat * dx;
        F.x += fwX;
        F.y += N;
        F.z += fwZ;
        // moment about the CG: r × F
        Mw.x += ry * fwZ - rz * N;
        Mw.y += rz * fwX - rx * fwZ;
        Mw.z += rx * N - ry * fwX;
        if (i > 0) this.wheelSpin = vLong / TYRE_R;
      }
    } else {
      this.comp[0] = this.comp[1] = this.comp[2] = 0;
    }
    this.driveCapacity = driveCapacity;

    // the airframe's hard points (tail, pods, wingtips, belly): stiff contacts with scraping friction
    if (raM < 20) {
      for (const bp of BODY_POINTS) {
        const gp = bp.p;
        const wx = ref.x + R[0] * gp.x + R[1] * gp.y + R[2] * gp.z;
        const wy = ref.y + R[3] * gp.x + R[4] * gp.y + R[5] * gp.z;
        const wz = ref.z + R[6] * gp.x + R[7] * gp.y + R[8] * gp.z;
        const gy = this.refSample.y;
        const D = gy - wy;
        if (D <= 0) {
          if (D < -0.3) this.touching.delete(bp.id);
          continue;
        }
        const rx = wx - this.cgPos.x;
        const ry = wy - this.cgPos.y;
        const rz = wz - this.cgPos.z;
        const wv = this.worldOmega(this.tmp);
        const pvx = this.vel.x + wv.y * rz - wv.z * ry;
        const pvy = this.vel.y + wv.z * rx - wv.x * rz;
        const pvz = this.vel.z + wv.x * ry - wv.y * rx;
        const N = Math.max(0, 8e6 * D - 4e5 * pvy);
        const vh = Math.hypot(pvx, pvz);
        const fr = vh > 1e-3 ? (0.5 * N) / Math.max(vh, 0.3) : 0;
        const fwX = -pvx * fr;
        const fwZ = -pvz * fr;
        F.x += fwX;
        F.y += N;
        F.z += fwZ;
        Mw.x += ry * fwZ - rz * N;
        Mw.y += rz * fwX - rx * fwZ;
        Mw.z += rx * N - ry * fwX;
        if (!this.touching.has(bp.id)) {
          this.touching.add(bp.id);
          this.bodyContact(bp.id, -pvy);
        }
      }
    }
    // world moment → three's body axes (Rᵀ·M) → aerospace (−z, x, −y)
    const mbx = R[0] * Mw.x + R[3] * Mw.y + R[6] * Mw.z;
    const mby = R[1] * Mw.x + R[4] * Mw.y + R[7] * Mw.z;
    const mbz = R[2] * Mw.x + R[5] * Mw.y + R[8] * Mw.z;
    return this.tmp.set(-mbz, mbx, -mby);
  }
  private driveCapacity = 0;

  /** Something other than the wheels hit the ground. */
  private bodyContact(id: BodyPointId, sinkMs: number) {
    const s = this.state;
    const fpm = sinkMs / FPM;
    const surface = this.refSample.surface;
    if (surface === 'water') return this.crash('ditching', fpm);
    if (surface === 'building') return this.crash('obstacle', fpm);
    if (id === 'tail') {
      this.events.push({ kind: 'tailstrike', pitch: s.pitch });
      if (fpm > 1000) this.crash('impact', fpm);
    } else if (id === 'podL' || id === 'podR') {
      this.events.push({ kind: 'podstrike', side: id === 'podL' ? 'L' : 'R' });
      if (fpm > 1000) this.crash('impact', fpm);
    } else if (id === 'tipL' || id === 'tipR') {
      this.events.push({ kind: 'wingstrike', side: id === 'tipL' ? 'L' : 'R' });
      this.crash('wingstrike', fpm);
    } else {
      // the fuselage itself: a belly landing if it was gentle and the gear isn't there, else an impact
      const gearOk = this.gear >= 0.999;
      this.crash(!gearOk && fpm < 1000 && Math.abs(s.bank) < 15 ? 'belly-landing' : gearOk && fpm < 600 ? 'gear-collapse' : 'impact', fpm);
    }
  }

  private crash(reason: CrashReason, fpm: number) {
    if (this.crashed) return;
    this.crashed = reason;
    this.events.push({ kind: 'crash', reason, ias: this.state.ias, vsFpm: Math.round(fpm) });
    this.vel.set(0, 0, 0);
    this.p = this.q = this.r = 0;
    for (const e of this.eng) e.running = false;
  }

  /**
   * Parked or held on the brakes: when the wheels can hold what the engines and the wind push
   * with, the aircraft stands still (tyres don't creep like the smooth friction model would).
   */
  private holdStill(T: number) {
    if (!(this.contact[1] && this.contact[2])) return;
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > 0.08) return;
    const push = Math.abs(T) + this.qbar * A320.wingArea * 0.05;
    if (push < this.driveCapacity) {
      this.vel.x = 0;
      this.vel.z = 0;
      this.r *= 0.5;
    }
  }

  // ---------------------------------------------------------------------------------------------- control laws

  /**
   * The flight control laws: from the sidestick, pedals and the law in force to elevator,
   * aileron and rudder. The inputs Mx/My/Mz are the moments already acting without the controls.
   */
  private controlLaws(h: number, c: Controls, Mx: number, My: number, Mz: number, raM: number, T: number) {
    const s = this.state;
    const onMains = this.contact[1] || this.contact[2];
    const raFt = raM / FT;
    const theta = s.pitch * DEG;
    const phi = s.bank * DEG;
    const Vi = Math.max(40, this.vel.length());
    const gamma = Math.asin(clamp(this.vel.y / Math.max(1, this.vel.length()), -1, 1));
    const cphi = Math.cos(phi);
    const sphi = Math.sin(phi);
    const flapsOut = this.selConfig > 0 || this.slats > 1;
    const alphaStall = this.wing.alphaStall * DEG;
    const alphaProt = alphaStall - A320.alphaProtMargin * DEG;
    const alphaMax = alphaStall - A320.alphaMaxMargin * DEG;
    const stickP = clamp(c.pitch, -1, 1);
    const stickR = clamp(c.roll, -1, 1);
    const pedal = clamp(c.yaw, -1, 1);

    // ---------------------------------------------------------------- which law
    if (onMains || this.contact[0]) {
      this.groundT += h;
      this.airborneT = 0;
    } else {
      this.airborneT += h;
      this.groundT = 0;
    }
    if (this.law === 'ground') {
      if (this.airborneT > 0.1) {
        this.law = 'flight';
        this.gammaRef = gamma;
        this.phiRef = phi;
      }
    } else if (this.law === 'flight') {
      if (this.groundT > 0.3) this.law = 'ground';
      else if (raFt < A320.flareModeFt && this.gear >= 0.999 && s.vs < -100 && this.sinceLiftoff > 15) {
        this.law = 'flare';
        this.flareTheta = theta;
        this.flareDown = 0;
      }
    } else if (this.law === 'flare') {
      if (this.groundT > 0.3) this.law = 'ground';
      else if (raFt > A320.flareModeFt + 50) {
        this.law = 'flight';
        this.gammaRef = gamma;
      }
    }
    // the flight law blends in over 5 s after liftoff (pitch) and 2 s (roll); the ground law in over ~2 s after touchdown
    const inAir = this.law !== 'ground';
    this.pitchBlend = approach(this.pitchBlend, inAir ? 1 : 0, h / (inAir ? 5 : 2));
    this.rollBlend = approach(this.rollBlend, inAir ? 1 : 0, h / (inAir ? 2 : 1));
    if (this.pitchBlend < 1e-3) {
      this.gammaRef = gamma;
      this.flareTheta = theta;
    }
    if (this.rollBlend < 1e-3) this.phiRef = phi;

    // ---------------------------------------------------------------- direct (ground) law
    const elevDirect = stickP >= 0 ? stickP * ELEV_UP * DEG : stickP * ELEV_DOWN * DEG;
    const rudLimit = this.rudderLimit(s.ias);
    const ailDirect = stickR;
    const rudDirect = pedal * rudLimit;

    // ---------------------------------------------------------------- protections
    const vmo = A320.vmo;
    const mmoSpeed = s.mach > 0.05 ? (s.ias * A320.mmo) / s.mach : Infinity;
    const vmoEff = Math.min(vmo, mmoSpeed);
    this.hsProt = inAir && s.ias > vmoEff + 6;
    if (inAir && this.alpha > alphaProt && stickP > -0.3) this.protLatched = true;
    s.alphaFloor = inAir && raFt > 100 && this.alpha > alphaStall - A320.alphaFloorMargin * DEG;

    // ---------------------------------------------------------------- pitch: flight law (C*), flare law
    const qS = this.qbar * A320.wingArea;
    let elevLaw = elevDirect;
    if (this.pitchBlend > 0 && qS > 50) {
      let qCmd: number;
      const nzMax = flapsOut ? A320.nzMax[1] : A320.nzMax[0];
      const nzMin = flapsOut ? A320.nzMin[1] : A320.nzMin[0];
      const thetaMax = (this.selConfig === 5 ? A320.pitchMaxFull : A320.pitchMax) * DEG;
      const thetaMin = A320.pitchMin * DEG;
      if (this.law === 'flare') {
        if (raFt < 30) this.flareDown = Math.min(2 * DEG, this.flareDown + ((2 * DEG) / 8) * h);
        const thetaCmd = this.flareTheta - this.flareDown + stickP * LAW.flareStick * DEG;
        qCmd = LAW.theta * (thetaCmd - theta);
        this.gammaRef = gamma;
      } else {
        // the stick demands load factor; released, the flight path holds (bank compensated to 33°)
        const dn = stickP >= 0 ? stickP * (nzMax - 1) : stickP * (1 - nzMin);
        const nNeutral = Math.cos(gamma) / Math.cos(Math.min(Math.abs(phi), 33 * DEG));
        let gRefDot = (G / Vi) * ((nNeutral + dn) * cphi - Math.cos(gamma));
        // high-speed protection: the nose comes up by itself above VMO + 6
        if (this.hsProt) gRefDot += 0.0015 * (s.ias - vmoEff - 6) * (stickP < 0 ? 1 + stickP * 0.5 : 1);
        this.gammaRef = clamp(this.gammaRef + gRefDot * h, gamma - 8 * DEG, gamma + 8 * DEG);
        let gDes = gRefDot + LAW.gamma * (this.gammaRef - gamma);
        let nzD = clamp((Math.cos(gamma) + (Vi * gDes) / G) / Math.max(0.35, cphi), nzMin, nzMax);
        // the angle of attack that makes that load factor (thrust carries a little of it)
        const clReq = (nzD * s.mass * G - T * Math.sin(this.alpha)) / qS;
        let alphaD = this.invertCl(clReq, this.alpha);
        // α protection: once latched, the stick commands α between α prot (neutral) and α max (full back)
        let alphaLim = alphaMax;
        if (this.protLatched) {
          alphaLim = alphaProt + Math.max(0, stickP) * (alphaMax - alphaProt);
          if (alphaD < alphaProt - 1 * DEG || stickP < -0.3) this.protLatched = false;
        }
        if (alphaD > alphaLim) {
          // the angle of attack, not the load factor, is what's flown now: the path follows from the
          // lift it gives (the speed decays to VαPROT/VαMAX and the aircraft sinks if it must)
          alphaD = alphaLim;
          nzD = (this.cl(alphaD) * qS + T * Math.sin(alphaD)) / (s.mass * G);
          gDes = (G / Vi) * (nzD * cphi - Math.cos(gamma));
          this.gammaRef = gamma;
        }
        const psiDot = (G * nzD * sphi) / (Vi * Math.max(0.2, Math.cos(gamma)));
        const qff = gDes * cphi + psiDot * Math.cos(theta) * sphi;
        qCmd = qff + LAW.alpha * (alphaD - this.alpha);
      }
      // pitch attitude protection
      if (theta > thetaMax - 4 * DEG) qCmd = Math.min(qCmd, 0.6 * (thetaMax - theta));
      if (theta < thetaMin + 4 * DEG) qCmd = Math.max(qCmd, 0.6 * (thetaMin - theta));
      if (theta > thetaMax || theta < thetaMin) this.gammaRef = gamma;
      // dynamic inversion: the elevator that gives q̇ = K(q_cmd − q)
      const mReq = this.Iyy * LAW.q * (qCmd - this.q) + (this.Ixx - this.Izz) * this.r * this.p;
      const ctrl = qS * A320.mac * AERO.cmElev;
      elevLaw = (mReq - My) / ctrl;
    }
    const elevCmd = clamp(this.pitchBlend * elevLaw + (1 - this.pitchBlend) * elevDirect, -ELEV_DOWN * DEG, ELEV_UP * DEG);
    this.elev = approach(this.elev, elevCmd, RATE.elev * ELEV_UP * DEG * h);

    // auto-trim: the THS takes over the elevator's steady deflection in the flight law
    const trimOk = this.law === 'flight' && this.pitchBlend > 0.99 && !this.protLatched && raFt > 50 && Math.abs(s.nz - 1) < 0.5;
    if (trimOk) {
      const want = clamp(this.elev * 0.25, -THS_RATE * DEG, THS_RATE * DEG);
      const next = clamp(this.ths + want * h, -THS_DOWN * DEG, THS_UP * DEG);
      if (!(this.hsProt && next < this.ths)) this.ths = next;
    } else if (this.law === 'ground' && this.contact[0] && s.gs < 40) {
      this.ths = approach(this.ths, THS_TAKEOFF * DEG, THS_RATE * DEG * h);
    }

    // ---------------------------------------------------------------- roll and yaw: flight law
    let ailLaw = ailDirect;
    let rudLaw = rudDirect;
    if (this.rollBlend > 0 && qS > 50) {
      const maxBank = (this.hsProt || this.protLatched ? 45 : A320.bankMax) * DEG;
      const neutralBank = (this.hsProt ? 0 : A320.bankNeutral) * DEG;
      let phiRateCmd = 0;
      if (Math.abs(stickR) > 0.02) {
        phiRateCmd = stickR * A320.rollRateMax * DEG;
        // rolling towards the bank limit the commanded rate tapers over its last few degrees, so the
        // roll stops on the limit instead of overshooting it (the real law's soft stop)
        if (phiRateCmd * this.phiRef > 0) {
          const room = Math.max(0, maxBank - Math.abs(this.phiRef));
          phiRateCmd = Math.sign(phiRateCmd) * Math.min(Math.abs(phiRateCmd), 1.2 * room);
        }
      } else if (Math.abs(this.phiRef) > neutralBank) {
        // released beyond 33° the aircraft rolls back to it, easing off as it arrives
        const excess = Math.abs(this.phiRef) - neutralBank;
        phiRateCmd = -Math.sign(this.phiRef) * Math.min(5 * DEG, 1.5 * excess + 0.2 * DEG);
      }
      const phiNext = this.phiRef + phiRateCmd * h;
      // at the bank limit the stick's roll rate stops: only the bank's own hold remains
      if (Math.abs(phiNext) >= maxBank && phiRateCmd * phiNext > 0) phiRateCmd = 0;
      this.phiRef = clamp(phiNext, -maxBank, maxBank);
      this.phiRef = clamp(this.phiRef, phi - 12 * DEG, phi + 12 * DEG);
      const phiDot = phiRateCmd + LAW.phi * (this.phiRef - phi);
      const psiDot = (G * Math.tan(clamp(phi, -1.3, 1.3))) / Vi;
      const pCmd = clamp(phiDot, -20 * DEG, 20 * DEG) - psiDot * Math.sin(theta);
      // pedals ask for sideslip (most at low speed); released, the yaw damper coordinates the turn
      const betaMax = (15 - clamp((s.ias - 160) / 190, 0, 1) * 13) * DEG;
      // (right pedal yaws the nose right: the relative wind then comes from the left, β < 0)
      const betaCmd = -pedal * betaMax;
      const rCmd = psiDot * Math.cos(theta) * cphi + LAW.beta * (this.beta - betaCmd);
      const lReq = this.Ixx * LAW.p * (pCmd - this.p) + (this.Izz - this.Iyy) * this.q * this.r;
      const nReq = this.Izz * LAW.r * (rCmd - this.r) + (this.Iyy - this.Ixx) * this.p * this.q;
      const b = A320.span;
      rudLaw = clamp((nReq - Mz) / (qS * b * AERO.cnRud), -rudLimit, rudLimit);
      ailLaw = (lReq - Mx - qS * b * AERO.clRud * rudLaw) / (qS * b * AERO.clAil);
    }
    const ailCmd = clamp(this.rollBlend * ailLaw + (1 - this.rollBlend) * ailDirect, -1, 1);
    const rudCmd = clamp(this.rollBlend * rudLaw + (1 - this.rollBlend) * rudDirect, -rudLimit, rudLimit);
    this.ail = approach(this.ail, ailCmd, RATE.ail * h);
    this.rud = approach(this.rud, rudCmd, RATE.rud * h);
  }

  /** The rudder travel limiter: full 30° up to 160 kt, closing to 3.4° at 380 kt (normalised). */
  private rudderLimit(ias: number) {
    const deg = ias <= 160 ? 30 : Math.max(3.4, 30 - ((ias - 160) * (30 - 3.4)) / (380 - 160));
    return deg / 30;
  }

  // ---------------------------------------------------------------------------------------------- events

  private checkEvents(h: number) {
    const s = this.state;
    const mains = this.contact[1] || this.contact[2];
    const any = mains || this.contact[0];
    if (any) this.sinceLiftoff = 0;
    else this.sinceLiftoff += h;

    // touchdown: report the sink rate at contact and the peak load factor over the next quarter second
    if (mains && !this.wasOnGround && this.airborneT === 0 && !this.pendingTd) {
      const sink = Math.max(0, -this.contactSink()) / FPM;
      const crab = ((((s.heading - s.track) % 360) + 540) % 360) - 180;
      this.pendingTd = {
        t: 0,
        maxG: s.nz,
        ev: { kind: 'touchdown', gear: 'main', vsFpm: Math.round(sink), g: s.nz, bank: s.bank, pitch: s.pitch, crabDeg: s.gs > 20 ? crab : 0, ias: s.ias, pos: s.pos.clone(), surface: this.refSample.surface },
      };
      if (this.refSample.surface === 'water') this.crash('ditching', sink);
      else if (this.refSample.surface === 'building') this.crash('obstacle', sink);
      else if (sink > 1400) this.crash('gear-collapse', sink);
      else if (sink > 1000) this.crash('impact', sink);
    }
    if (this.pendingTd) {
      const pt = this.pendingTd;
      pt.t += h;
      pt.maxG = Math.max(pt.maxG, s.nz);
      if (pt.t >= 0.25) {
        pt.ev.g = Math.round(pt.maxG * 100) / 100;
        this.events.push(pt.ev);
        this.pendingTd = null;
        if (pt.maxG > 3 && !this.crashed) this.crash('impact', pt.ev.vsFpm);
      }
    }
    if (this.contact[0] && !this.noseWasDown) {
      const sink = Math.max(0, -this.contactSink(0)) / FPM;
      this.events.push({ kind: 'touchdown', gear: 'nose', vsFpm: Math.round(sink), g: s.nz, bank: s.bank, pitch: s.pitch, crabDeg: 0, ias: s.ias, pos: s.pos.clone(), surface: this.refSample.surface });
      if (sink > 1000 && !this.crashed) this.crash('gear-collapse', sink);
    }
    if (this.wasOnGround && !any && this.airborneT > 0.1) {
      this.events.push({ kind: 'liftoff', ias: s.ias, pos: s.pos.clone() });
    }
    if (any) this.wasOnGround = true;
    else if (this.airborneT > 0.1) this.wasOnGround = false;
    this.noseWasDown = this.contact[0] || (this.noseWasDown && this.airborneT === 0);
    if (!any && this.airborneT > 0.1) this.noseWasDown = false;

    // touching down short of the pavement, or leaving it at speed
    if (mains && s.gs > 40 && !this.crashed) {
      const surf = this.refSample.surface;
      if (surf === 'grass' || surf === 'sand') this.crash('runway-excursion', 0);
      else if (surf === 'water') this.crash('ditching', 0);
      else if (surf === 'building') this.crash('obstacle', 0);
    }
    // beyond the dive speed the airframe comes apart
    if (s.ias > 380 && !this.crashed) this.crash('overspeed', Math.max(0, -s.vs));
  }

  /** Vertical velocity (m/s) at a wheel (0 nose, 1/2 mains: their mean). */
  private contactSink(i = 1) {
    const R = this.R;
    const gp = i === 0 ? A320_POINTS.noseGear : A320_POINTS.mainGearL;
    const ref = this.refPoint(this.tmp2);
    // the wheel on the centreline (x = 0, y = 0 in the body frame): only the body's z axis moves it
    const wx = ref.x + R[2] * gp.z;
    const wz = ref.z + R[8] * gp.z;
    const rx = wx - this.cgPos.x;
    const rz = wz - this.cgPos.z;
    const wv = this.worldOmega(this.tmp);
    return this.vel.y + wv.z * rx - wv.x * rz;
  }

  // ---------------------------------------------------------------------------------------------- state

  private reset() {
    this.crashed = null;
    this.acc = 0;
    this.p = this.q = this.r = 0;
    this.reverser = 0;
    this.spG = 0;
    this.spSb = 0;
    this.elev = 0;
    this.ail = 0;
    this.rud = 0;
    this.nosewheel = 0;
    this.wheelSpin = 0;
    this.brakeL = this.brakeR = 0;
    this.autobrakeOn = false;
    this.autobrakeArmed = false;
    this.autobrakeCmd = 0;
    this.decel = 0;
    this.selConfig = 0;
    this.lastLever = 0;
    this.slats = 0;
    this.flaps = 0;
    this.protLatched = false;
    this.hsProt = false;
    this.gammaRef = 0;
    this.phiRef = 0;
    this.flareDown = 0;
    this.sinceLiftoff = 0;
    this.airborneT = 0;
    this.groundT = 0;
    this.pendingTd = null;
    this.touching.clear();
    this.comp[0] = this.comp[1] = this.comp[2] = 0;
    this.iasRate = 0;
    this.state.time = 0;
    this.events.length = 0;
  }

  /** Rotation matrix (body → world, row-major 3×3) from the quaternion. */
  private rotation() {
    const { x, y, z, w } = this.quat;
    const R = this.R;
    R[0] = 1 - 2 * (y * y + z * z);
    R[1] = 2 * (x * y - z * w);
    R[2] = 2 * (x * z + y * w);
    R[3] = 2 * (x * y + z * w);
    R[4] = 1 - 2 * (x * x + z * z);
    R[5] = 2 * (y * z - x * w);
    R[6] = 2 * (x * z - y * w);
    R[7] = 2 * (y * z + x * w);
    R[8] = 1 - 2 * (x * x + y * y);
  }

  /** Add a force given in aerospace body axes to F (world). */
  private addBody(F: THREE.Vector3, ax: number, ay: number, az: number) {
    // aerospace (x fwd, y right, z down) → three's body (x right, y up, z back) = (ay, −az, −ax)
    const bx = ay;
    const by = -az;
    const bz = -ax;
    const R = this.R;
    F.x += R[0] * bx + R[1] * by + R[2] * bz;
    F.y += R[3] * bx + R[4] * by + R[5] * bz;
    F.z += R[6] * bx + R[7] * by + R[8] * bz;
  }

  /** Angular velocity in world axes. */
  private worldOmega(out: THREE.Vector3) {
    const R = this.R;
    const bx = this.q;
    const by = -this.r;
    const bz = -this.p;
    return out.set(R[0] * bx + R[1] * by + R[2] * bz, R[3] * bx + R[4] * by + R[5] * bz, R[6] * bx + R[7] * by + R[8] * bz);
  }

  /** The reference point (between the main wheels) in the world, from the CG. */
  private refPoint(out: THREE.Vector3) {
    const R = this.R;
    const c = A320_POINTS.cg;
    return out.set(
      this.cgPos.x - (R[0] * c.x + R[1] * c.y + R[2] * c.z),
      this.cgPos.y - (R[3] * c.x + R[4] * c.y + R[5] * c.z),
      this.cgPos.z - (R[6] * c.x + R[7] * c.y + R[8] * c.z),
    );
  }

  /** Put the CG where the reference point must be (for the current attitude). */
  private setRef(ref: THREE.Vector3) {
    this.rotation();
    const R = this.R;
    const c = A320_POINTS.cg;
    this.cgPos.set(ref.x + R[0] * c.x + R[1] * c.y + R[2] * c.z, ref.y + R[3] * c.x + R[4] * c.y + R[5] * c.z, ref.z + R[6] * c.x + R[7] * c.y + R[8] * c.z);
  }

  private casToTas(cas: number, rho: number, a: number) {
    // impact pressure from CAS at sea level, then TAS at the local static pressure
    const qc = P0 * ((1 + 0.2 * (cas / A0) ** 2) ** 3.5 - 1);
    const p = rho * R_AIR * ((a * a) / (1.4 * R_AIR));
    const mach = Math.sqrt(5 * ((qc / p + 1) ** (2 / 7) - 1));
    return mach * a;
  }

  private fracToN1(frac: number) {
    const x = Math.max(0, (frac - A320.idleThrustFrac) / (1 - A320.idleThrustFrac)) ** (1 / A320.thrustExp);
    return A320.n1Idle + x * (A320.n1Toga - A320.n1Idle);
  }

  /** Everything AircraftState shows, from the rigid body and systems. */
  private derive(h: number, resample: boolean) {
    const s = this.state;
    this.rotation();
    const R = this.R;
    this.refPoint(s.pos);
    s.vel.copy(this.vel);
    s.quat.copy(this.quat);
    this.euler.setFromQuaternion(this.quat, 'YXZ');
    s.pitch = this.euler.x / DEG;
    s.bank = -this.euler.z / DEG;
    s.heading = ((-this.euler.y / DEG) % 360 + 360) % 360;
    const gsMs = Math.hypot(this.vel.x, this.vel.z);
    s.gs = gsMs / KT;
    s.track = gsMs > 0.5 ? ((Math.atan2(this.vel.x, -this.vel.z) / DEG) + 360) % 360 : s.heading;
    s.fpa = Math.atan2(this.vel.y, Math.max(gsMs, 0.01)) / DEG;
    s.p = this.p / DEG;
    s.q = this.q / DEG;
    s.r = this.r / DEG;

    // air data
    const as = this.airSample;
    if (resample) this.air.sample(this.cgPos, as);
    const vx = this.vel.x - as.wind.x;
    const vy = this.vel.y - as.wind.y;
    const vz = this.vel.z - as.wind.z;
    const tas = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const bx = R[0] * vx + R[3] * vy + R[6] * vz;
    const by = R[1] * vx + R[4] * vy + R[7] * vz;
    const bz = R[2] * vx + R[5] * vy + R[8] * vz;
    s.alpha = tas > 2 ? Math.atan2(-by, -bz) / DEG : 0;
    s.beta = tas > 2 ? Math.asin(clamp(bx / tas, -1, 1)) / DEG : 0;
    s.tas = tas / KT;
    const a = as.soundSpeed;
    s.mach = tas / a;
    // CAS from the impact pressure at the local static pressure
    const pStatic = as.density * R_AIR * (as.oatC + 273.15);
    const qc = pStatic * ((1 + 0.2 * s.mach * s.mach) ** 3.5 - 1);
    s.ias = (A0 * Math.sqrt(5 * ((qc / P0 + 1) ** (2 / 7) - 1))) / KT;
    if (h > 0) {
      const rate = (s.ias - this.prevIas) / h;
      this.iasRate += (rate - this.iasRate) * Math.min(1, h / 1.2);
      this.prevIas = s.ias;
    }
    s.iasTrend = this.iasRate * 10;
    // deceleration along the track (for the autobrake)
    const along = gsMs > 0.3 ? (this.F.x * this.vel.x + this.F.z * this.vel.z) / (gsMs * s.mass) : 0;
    this.decel += (-along - this.decel) * Math.min(1, h / 0.3);
    s.vs = this.vel.y / FPM;
    s.altFt = (s.pos.y - SEA_Y) / FT;
    const gy = this.refSample.y;
    s.radioAltFt = Math.max(0, (s.pos.y - gy) / FT);

    // engines and systems
    s.n1[0] = this.eng[0].n1;
    s.n1[1] = this.eng[1].n1;
    s.thrust[0] = this.eng[0].thrust;
    s.thrust[1] = this.eng[1].thrust;
    s.reverser = this.reverser;
    s.flapsDeg = this.flaps;
    s.slatsDeg = this.slats;
    s.config = this.selConfig;
    s.gear = this.gear;
    s.spoilers = Math.max(this.spG, this.spSb);
    s.elevator = this.elev >= 0 ? this.elev / (ELEV_UP * DEG) : this.elev / (ELEV_DOWN * DEG);
    s.aileron = this.ail;
    s.rudder = this.rud;
    s.nosewheel = this.nosewheel;
    s.wheelSpin = this.wheelSpin;
    // the whole deflection (oleo and tyre): the 3D model raises each wheel by it into its leg, so
    // with its rigid tyres the wheels rest exactly on the ground
    for (let i = 0; i < 3; i++) s.compression[i] = this.contact[i] ? Math.min(this.prevD[i], STROKE) : 0;
    s.onGround = this.contact[0] || this.contact[1] || this.contact[2];
    s.noseOnGround = this.contact[0];
    s.surface = this.refSample.surface;
    s.law = this.law;
    this.updateSpeeds();
    const alphaStall = this.wing.alphaStall || CONFIGS[this.selConfig].alphaStall;
    s.stallWarning = !s.onGround && s.alpha > alphaStall - A320.alphaMaxMargin + 0.5;
    s.overspeed = s.ias > s.speeds.vmax + 4;

    const sys = this.sys;
    sys.ths = this.ths / DEG;
    const roll = clamp((Math.abs(this.ail) - 0.1) / 0.9, 0, 1);
    sys.spoilerL = Math.max(this.spG, this.spSb, this.ail < 0 ? roll : 0);
    sys.spoilerR = Math.max(this.spG, this.spSb, this.ail > 0 ? roll : 0);
    sys.groundSpoilers = this.spG;
    sys.speedbrake = this.spSb;
    sys.autobrakeActive = this.autobrakeOn && this.autobrakeCmd > 0.05;
    sys.autobrakeArmed = this.autobrakeArmed || this.autobrakeOn;
    sys.brakes[0] = this.brakeL;
    sys.brakes[1] = this.brakeR;
    for (let i = 0; i < 2; i++) {
      sys.engineRunning[i] = this.eng[i].running;
      sys.engineStart[i] = this.eng[i].starting >= 0 ? this.eng[i].starting / ENGINE_START_S : -1;
    }
    sys.alphaProt = this.protLatched;
    sys.highSpeedProt = this.hsProt;
  }

  /** The characteristic speeds for the mass and configuration (kt IAS ≈ EAS at these heights). */
  private updateSpeeds() {
    const s = this.state;
    const sp = s.speeds;
    const W = s.mass * G;
    const S = A320.wingArea;
    const vAt = (cl: number) => Math.sqrt((2 * W) / (RHO0 * S * Math.max(cl, 0.1))) / KT;
    const wp = wingProps(this.slats, this.flaps, this.wing);
    sp.vs1g = vAt(wp.clMax);
    // the lift curve at α prot / α max (out of ground effect, spoilers in)
    const ge = this.ge;
    const spG = this.spG;
    const spSb = this.spSb;
    this.ge = 1;
    this.spG = 0;
    this.spSb = 0;
    sp.vaprot = vAt(this.cl((wp.alphaStall - A320.alphaProtMargin) * DEG));
    sp.vamax = vAt(this.cl((wp.alphaStall - A320.alphaMaxMargin) * DEG));
    this.ge = ge;
    this.spG = spG;
    this.spSb = spSb;
    const takeoff = this.sinceLiftoff < 120 && this.selConfig === 2;
    sp.vls = sp.vs1g * (takeoff ? 1.13 : 1.23);
    // VMAX: VMO/MMO, the flaps' VFE (for the surfaces out now) and VLE with the gear down
    const mmoKt = s.mach > 0.05 ? (s.ias * A320.mmo) / s.mach : Infinity;
    let vfe = Infinity;
    if (this.flaps > 0.5) vfe = this.flaps > 20.5 ? A320.vfe[4] : this.flaps > 15.5 ? A320.vfe[3] : this.flaps > 10.5 ? A320.vfe[2] : A320.vfe1F;
    else if (this.slats > 0.5) vfe = A320.vfe[1];
    sp.vmax = Math.min(A320.vmo, mmoKt, vfe, this.gear > 0.01 ? A320.vle : Infinity);
    // green dot (best lift/drag, clean), S (1.23 VS1g clean), F (1.22 VS1g in CONF 1+F)
    const vClean = vAt(CONFIGS[0].clMax);
    sp.greenDot = Math.sqrt((2 * W) / (RHO0 * S)) * (A320.k / A320.cd0) ** 0.25 / KT;
    sp.s = 1.23 * vClean;
    const v1F = vAt(CONFIGS[2].clMax);
    sp.f = 1.22 * v1F;
    this.sys.v2 = Math.round(1.16 * v1F);
    this.sys.vr = Math.round(1.16 * v1F - 3);
  }
}

/** Grass and sand are bumpy (a few centimetres), the pavement is smooth. */
function bumpAt(surface: Surface, x: number, z: number) {
  const k = SURF[surface].bump;
  if (k === 0) return 0;
  return k * (Math.sin(0.73 * x + 1.3) * Math.sin(0.91 * z) + 0.5 * Math.sin(2.1 * x + 0.37 * z + 0.4));
}

/** The gas spring's force (N) at a stroke x (m); beyond the stroke the strut bottoms on its stops. */
function oleoForce(st: Strut, x: number) {
  const xs = Math.min(x, STROKE);
  const f = st.preload * (st.gas / (st.gas - xs)) ** POLY;
  return x > STROKE ? f + K_BOTTOM * (x - STROKE) : f;
}

/** The gas spring's stiffness dF/dx (N/m). */
function oleoStiffness(st: Strut, x: number) {
  if (x > STROKE) return K_BOTTOM;
  return (oleoForce(st, x) * POLY) / (st.gas - x);
}

/** The oleo stroke at which strut and tyre carry the same force for a total deflection D (Newton on x + F(x)/kTyre = D). */
function strokeFor(st: Strut, D: number, guess: number) {
  let x = clamp(guess, 0, D);
  for (let i = 0; i < 4; i++) {
    const g = x + oleoForce(st, x) / st.kTyre - D;
    x = clamp(x - g / (1 + oleoStiffness(st, x) / st.kTyre), 0, D);
  }
  return x;
}

/** How far a strut and its tyres deflect under a static load (m). */
function staticDeflection(st: Strut, load: number) {
  if (load <= st.preload) return load / st.kTyre;
  const x = Math.min(STROKE, st.gas * (1 - (st.preload / load) ** (1 / POLY)));
  return x + load / st.kTyre;
}

function makeState(mass: number, fuel: number): AircraftState {
  return {
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    pitch: 0,
    bank: 0,
    heading: 0,
    track: 0,
    fpa: 0,
    q: 0,
    p: 0,
    r: 0,
    alpha: 0,
    beta: 0,
    ias: 0,
    tas: 0,
    gs: 0,
    mach: 0,
    iasTrend: 0,
    vs: 0,
    altFt: 0,
    radioAltFt: 0,
    nz: 1,
    ny: 0,
    n1: [0, 0],
    thrust: [0, 0],
    fuelFlow: 0,
    reverser: 0,
    mass,
    fuel,
    flapsDeg: 0,
    slatsDeg: 0,
    config: 0,
    gear: 1,
    spoilers: 0,
    aileron: 0,
    elevator: 0,
    rudder: 0,
    nosewheel: 0,
    wheelSpin: 0,
    compression: [0, 0, 0],
    onGround: true,
    noseOnGround: true,
    surface: 'runway',
    law: 'ground',
    stallWarning: false,
    alphaFloor: false,
    overspeed: false,
    speeds: { vls: 0, vaprot: 0, vamax: 0, vmax: 0, greenDot: 0, f: 0, s: 0, vs1g: 0 },
    time: 0,
  };
}
