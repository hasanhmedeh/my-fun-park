// The Airbus A320neo (A320-251N, two CFM LEAP-1A26), as the flight model and the 3D model both
// need it: published dimensions, weights, engine and speed limits, the flap/slat configurations
// and the aerodynamic targets the model is tuned to. Sources: Airbus A320 Aircraft Characteristics
// (Airport and Maintenance Planning), the A320 FCOM limitations chapter, CFM LEAP-1A data.
//
// The body frame (shared by the 3D model, the flight model and the cameras): forward is −Z, up is
// +Y, right is +X, in metres. Its origin is the REFERENCE POINT: on the ground, midway between the
// two main gear's tyre contact points, with the oleos fully extended. A parked aircraft stands
// with its reference point at ground height; on the ground it pitches about it (rotation).
//
// World attitude: Euler order 'YXZ' with x = pitch (nose up +), y = −heading (radians, heading
// clockwise from north), z = −bank (right wing down = positive bank).

export const A320 = {
  type: 'Airbus A320neo',
  icaoType: 'A20N',

  // ---------------------------------------------------------------- dimensions (m)
  length: 37.57,
  span: 35.8, // with sharklets
  height: 11.76,
  wingArea: 122.6, // m²
  mac: 4.29, // mean aerodynamic chord
  aspectRatio: 10.45,
  fuselageWidth: 3.95,
  fuselageHeight: 4.14,
  wheelbase: 12.64,
  track: 7.59,

  // ---------------------------------------------------------------- weights (kg)
  mtow: 79000,
  mlw: 67400,
  mzfw: 64300,
  oew: 44300,
  maxFuel: 18730, // 23,859 L at 0.785 kg/L
  seats: 180,
  /** Mass per passenger with carry-on and checked bag, as airlines plan it. */
  paxMass: 95,
  /** Fuel loaded for the 40 km hop: trip, alternate, final reserve and taxi. */
  blockFuel: 5200,

  // ---------------------------------------------------------------- engines (LEAP-1A26)
  engines: 2,
  /** Static sea-level thrust per engine at TOGA (N). */
  maxThrust: 120600,
  /** Thrust lapse with Mach at constant N1: T/T0 ≈ 1 − lapseM·M + lapseM2·M² (high-bypass turbofan). */
  lapseM: 1.0,
  lapseM2: 0.6,
  /** And with air density: T ∝ σ^densityExp. */
  densityExp: 0.75,
  /** N1 (fraction of 100 %) at ground idle, and at TOGA. Thrust ∝ ((N1 − idle) / (TOGA − idle))^thrustExp, plus idle residual. */
  n1Idle: 0.205,
  n1Toga: 0.985,
  thrustExp: 1.8,
  idleThrustFrac: 0.035,
  /** Spool-up time constant (s) from idle; spooling down is quicker. Idle → TOGA takes ~6–8 s. */
  spoolUp: 2.2,
  spoolDown: 1.4,
  /** Thrust lever detents (lever position 0..1) and what they command. */
  detents: { idle: 0, cl: 0.62, flx: 0.82, toga: 1 },
  /** Max reverse thrust as a fraction of forward max (effective, with cascade losses). */
  reverseFrac: 0.33,
  /** Fuel flow per engine (kg/s): at idle and at TOGA, roughly linear in thrust between. */
  fuelIdle: 0.11,
  fuelToga: 1.15,

  // ---------------------------------------------------------------- speeds (knots, IAS)
  vmo: 350,
  mmo: 0.82,
  /** Below 10,000 ft (FL100) ATC speed limit. */
  speedLimitLow: 250,
  /** Max flap/slat extended speeds per lever position (0 = clean). */
  vfe: [Infinity, 230, 200, 185, 177],
  /** CONF 1+F (lever 1 on takeoff, flaps 10°) is limited to 215 kt; the flaps auto-retract to 0 at 210 kt. */
  vfe1F: 215,
  vlo: { extend: 250, retract: 220 },
  vle: 280,
  /** Max tyre speed (kt ground speed). */
  tyreSpeed: 195,

  // ---------------------------------------------------------------- configurations
  /**
   * Flap lever 0..4 = 0, 1, 2, 3, FULL. Lever 1 gives CONF 1 (slats only) in flight and CONF 1+F
   * (slats and flaps) below 100 kt / on takeoff. Angles in degrees.
   */
  configs: [
    { lever: '0', slats: 0, flaps: 0, clMax: 1.5, dCl0: 0, dCd0: 0, alphaStall: 15.0 },
    { lever: '1', slats: 18, flaps: 0, clMax: 1.85, dCl0: 0.08, dCd0: 0.006, alphaStall: 18.5 },
    { lever: '1+F', slats: 18, flaps: 10, clMax: 2.05, dCl0: 0.3, dCd0: 0.012, alphaStall: 17.5 },
    { lever: '2', slats: 22, flaps: 15, clMax: 2.3, dCl0: 0.48, dCd0: 0.024, alphaStall: 17.0 },
    { lever: '3', slats: 22, flaps: 20, clMax: 2.5, dCl0: 0.62, dCd0: 0.035, alphaStall: 16.5 },
    { lever: 'FULL', slats: 27, flaps: 40, clMax: 2.83, dCl0: 0.92, dCd0: 0.064, alphaStall: 15.5 },
  ],
  /** Time for the flaps/slats to travel between neighbouring positions (s). */
  flapTravel: 9,
  /** Landing gear retraction / extension (s). */
  gearTravel: 10,

  // ---------------------------------------------------------------- aerodynamics (whole aircraft, trimmed)
  /** Lift-curve slope per radian of body angle of attack, out of ground effect. */
  clAlpha: 5.3,
  /** Lift coefficient at zero body angle of attack, clean (the wing is set at an incidence). */
  cl0: 0.23,
  cd0: 0.021,
  /** Induced drag factor k = 1 / (π · AR · e), e ≈ 0.77. */
  k: 0.0395,
  gearCd0: 0.02,
  /** Speed brakes fully out in flight: extra drag and lost lift. */
  speedbrakeCd0: 0.03,
  speedbrakeDCl: -0.15,
  /** Ground spoilers on the rollout. */
  groundSpoilerCd0: 0.09,
  groundSpoilerLiftFactor: 0.45,
  /** Ground effect below one span: induced drag falls and lift rises (k_ge ∝ (16h/b)² / (1 + (16h/b)²)). */
  groundEffect: true,

  // ---------------------------------------------------------------- flight control laws (normal law)
  /** Load factor limits clean / with flaps out. */
  nzMax: [2.5, 2.0],
  nzMin: [-1.0, 0.0],
  pitchMax: 30, // degrees nose up (25 in CONF FULL)
  pitchMaxFull: 25,
  pitchMin: -15,
  bankMax: 67,
  /** Bank held with the stick released: beyond this the aircraft rolls back to it. */
  bankNeutral: 33,
  rollRateMax: 15, // °/s at full stick
  /** Alpha protection and max alpha are this far below the configuration's stall alpha (°). */
  alphaProtMargin: 3.5,
  alphaMaxMargin: 1.5,
  /** Alpha floor: A/THR commands TOGA above this alpha (° below stall). */
  alphaFloorMargin: 2.5,
  /** Flare law: below this radio height (ft) the stick commands pitch attitude; from 30 ft the nose is lowered 2° over 8 s. */
  flareModeFt: 50,
  /** Max nosewheel steering: tiller ±75°, rudder pedals ±6°. */
  tillerMax: 75,
  pedalSteerMax: 6,
  rudderMax: 30,

  // ---------------------------------------------------------------- ground
  rollingFriction: 0.015,
  /** Max braking deceleration on a dry runway (m/s²), and the autobrake settings. */
  maxBrakeDecel: 4.6,
  autobrake: { lo: 1.7, med: 3.0, max: 4.6 },
  /** Autobrake LO is delayed after touchdown (s). */
  autobrakeLoDelay: 4,

  // ---------------------------------------------------------------- reference performance (for the flight model's tests)
  /** At 66 t, sea level, ISA: what the tuned model should reproduce (tolerances in the tests). */
  targets: {
    mass: 66000,
    vs1gClean: 147, // kt
    vs1gFull: 107,
    v2Conf1F: 146,
    vappFull: 137,
    /** Takeoff ground roll at TOGA, CONF 1+F, rotate at 144 kt (m). */
    groundRollToga: 1150,
    /** Initial climb at 250 kt, CL thrust, clean, 2,000 ft (ft/min). */
    climb250: 3600,
    /** N1 on a 3° ILS at Vapp, CONF FULL, gear down. */
    approachN1: 0.57,
    /** Landing roll from 50 ft to stop with autobrake MED, reversers idle (m). */
    landingRollMed: 1150,
  },
} as const;

/**
 * Points on the airframe in the body frame (metres from the reference point). The 3D model is
 * built to match them; the flight model uses them for gear contact and for strikes.
 */
export const A320_POINTS = {
  noseTip: { x: 0, y: 3.55, z: -17.7 },
  tailTip: { x: 0, y: 5.4, z: 19.87 },
  /** Nose gear tyre contact (centre between the twin wheels). */
  noseGear: { x: 0, y: 0, z: -12.64 },
  mainGearL: { x: -3.795, y: 0, z: 0 },
  mainGearR: { x: 3.795, y: 0, z: 0 },
  /** Oleo stroke: how far the gear can compress (m). */
  gearStroke: 0.42,
  /** Centre of gravity (mid of the range). */
  cg: { x: 0, y: 3.4, z: -1.5 },
  /** Fuselage centreline height at the wing, cabin floor height. */
  fuselageY: 3.85,
  floorY: 3.35,
  /** The captain's eye (left seat). */
  eye: { x: -0.53, y: 4.62, z: -15.35 },
  /** Door sills: L1 (front left, used for boarding), L2 (rear left), R1, R2. */
  doorL1: { x: -1.98, y: 3.4, z: -12.8 },
  doorL2: { x: -1.98, y: 3.4, z: 13.2 },
  doorR1: { x: 1.98, y: 3.4, z: -12.8 },
  doorR2: { x: 1.98, y: 3.4, z: 13.2 },
  /** The lowest point of the tail cone: it touches the runway at about 11.5° of pitch on the main gear. */
  tailStrike: { x: 0, y: 2.95, z: 13.5 },
  /** The lowest point of each engine nacelle: a pod strike at about 6–7° of bank on the ground. */
  podL: { x: -5.75, y: 0.68, z: -8.0 },
  podR: { x: 5.75, y: 0.68, z: -8.0 },
  /** Wing tips (with sharklets, their lowest point). */
  tipL: { x: -17.9, y: 4.05, z: 3.4 },
  tipR: { x: 17.9, y: 4.05, z: 3.4 },
  /** Engine centres (fan face), for the jet blast, sound and camera. */
  engineL: { x: -5.75, y: 1.88, z: -9.4 },
  engineR: { x: 5.75, y: 1.88, z: -9.4 },
  /** Landing and taxi light positions (wing roots, nose gear). */
  landingLightL: { x: -4.2, y: 2.4, z: -4.0 },
  landingLightR: { x: 4.2, y: 2.4, z: -4.0 },
  taxiLight: { x: 0, y: 1.6, z: -12.6 },
} as const;

/** The flap lever's five positions and their display names. */
export const FLAP_LEVER = ['0', '1', '2', '3', 'FULL'] as const;
