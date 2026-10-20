// The cockpit overlay (world/flight/instruments) over the real world, fed by the real flight model,
// autopilot and navigator: each case places the A320, flies it for a few seconds with scripted
// inputs so every display shows genuine data, then freezes the moment for the screenshot.
//
//   ?scene=cockpit&case=takeoff&hour=13       the takeoff roll at Funfair International, MAN TOGA / SRS / RWY
//   ?scene=cockpit&case=climb                 climbing out over the sea in a turn, hand-flown on the flight director
//   ?scene=cockpit&case=cruise                5000 ft, AP and A/THR on, NAV to the island's initial approach fix
//   ?scene=cockpit&case=final                 2 NM final at Palm Cay, AP on the ILS, a little left and high
//   ?scene=cockpit&case=warning               gear up at 700 ft on the approach: master warning, ECAM, GPWS
//   ?scene=cockpit&case=taxi                  taxiing out on A (ROSE NAV, the T.O memo)
//   ?scene=cockpit&case=rollout               a rejected takeoff at 110 kt: idle, full reverse, autobrake (REV on the EWD)
//   &view=outside   the chase camera with the compact strip instead of the flight deck
//   &solo=pfd       one display unit (pfd, nd, ewd, isis) blown up in the middle, to inspect it
//   &yaw=70         the cockpit camera turned by this many degrees (e.g. 70: the side window, 180: the rear wall)
//   &env=1 &hour=23 night; &far=60000&near=2 (the scene sets these itself)
//   &touch=1        the real HUD round the deck as a phone has it while piloting: the park's stylesheet,
//                   #hud with the cockpit mount first, the flight's own HUD lines, Exit ride and the ℹ️,
//                   and #touch with the stick, the E button and the flight's thrust lever and buttons
//                   (body.is-piloting), to check the touch layout against the panel
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import { A320, A320_POINTS } from '../../aviation/a320';
import { AIRFIELDS, flightPlan } from '../../aviation/airports';
import { Autopilot } from '../../aviation/autopilot';
import { FlightModel } from '../../aviation/fdm';
import { Navigator } from '../../aviation/nav';
import { neutralControls, type Controls, type GroundQuery, type TimeOfDay } from '../../aviation/types';
import { Air, makeWeather } from '../../aviation/weather';
import { Airfield } from '../../world/airport/airfield';
import { createA320, LIVERIES } from '../../world/airport/a320-model';
import { FT, NM, SEA_Y, shoreDist, type Region } from '../../world/geo';
import { Cockpit } from '../../world/flight/instruments/cockpit';
import { cockpitFontReady } from '../../world/flight/instruments/display';
import { FlightHud } from '../../world/flight/flight-hud';
import { FlightTouch } from '../../world/flight/touch';
import type { CockpitData } from '../../world/flight/instruments/types';
import { geography } from './flight-view';

type Case = 'takeoff' | 'climb' | 'cruise' | 'final' | 'warning' | 'taxi' | 'rollout';

const D2R = Math.PI / 180;

const scene: PreviewScene = async (p: PreviewApi) => {
  const { ctx } = p;
  const q = p.params;
  const kase = (q.get('case') ?? 'final') as Case;
  const hour = Number(q.get('hour') ?? 13);
  const tod: TimeOfDay = hour < 5.5 || hour > 19.5 ? 'night' : hour < 8.5 ? 'dawn' : hour > 16.5 ? 'dusk' : 'day';
  const weather = makeWeather(11, tod);
  weather.windFrom = 250;
  weather.windKt = 12;
  weather.gustKt = 0;
  weather.turbulence = 0.05;
  const region: Region = kase === 'final' || kase === 'warning' ? 'island' : 'home';

  const field = new Airfield(ctx, AIRFIELDS[region]);
  ctx.scene.add(field.group);
  field.setWind(weather.windFrom, weather.windKt);
  const ground: GroundQuery = (x, z) => (shoreDist(x, z) > 0 ? { y: 0, surface: field.surfaceAt(x, z) ?? 'grass' } : { y: SEA_Y, surface: 'water' });
  const air = new Air(weather, ground, 3);
  const fm = new FlightModel({ ground, air });
  fm.setLoad(156, A320.blockFuel);
  const plan = flightPlan('home', '27', '27');
  const nav = new Navigator(plan);
  nav.setArrivalWind(weather.windFrom, weather.windKt);
  const ap = new Autopilot(nav);
  const pilot: Controls = { ...neutralControls(), parkingBrake: false, spoilersArmed: true, autobrake: 'med' };
  const out = neutralControls();
  const s = fm.state;
  let warnings: CockpitData['warnings'] = [];
  let memos: string[] = ['SEAT BELTS', 'NO SMOKING'];
  let masterWarning = false;

  const fly = (seconds: number, each?: (t: number) => void) => {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      each?.(t);
      nav.update(dt, s);
      const ctl = ap.update(dt, s, pilot, out);
      fm.step(dt, ctl);
    }
  };

  switch (kase) {
    case 'takeoff': {
      const rw = AIRFIELDS.home.runways['27'];
      fm.placeOnGround(rw.threshold.x - 60, rw.threshold.z, 270, { enginesRunning: true });
      nav.phase = 'takeoff';
      ap.setAlt(5000);
      ap.pushHdg();
      ap.toggleAthr();
      Object.assign(pilot, { throttle: A320.detents.toga, flapLever: 1, autobrake: 'max' });
      // stop the clock where the roll is about to rotate
      for (let t = 0; s.ias < 128 && t < 60; t += 0.25) fly(0.25);
      break;
    }
    case 'climb': {
      fm.placeInAir(1200, 4200, 2400, 195, 245, 0, false);
      ap.syncAirborne(s);
      nav.update(0, s);
      nav.phase = 'climb';
      ap.setAlt(5000);
      ap.pullAlt();
      ap.setHdg(230);
      ap.pullHdg();
      ap.toggleAthr();
      Object.assign(pilot, { throttle: A320.detents.cl, flapLever: 0, gearDown: false });
      fly(2.2, () => (pilot.roll = 0.75));
      pilot.roll = 0;
      fly(1.5, () => (pilot.pitch = Math.max(-0.4, Math.min(0.4, ((ap.fcu.fdPitch ?? s.pitch) - s.pitch) * 0.15))));
      break;
    }
    case 'cruise': {
      fm.placeInAir(2500, 21000, 5000, 160, 250, 0, false);
      ap.syncAirborne(s);
      nav.update(0, s);
      nav.phase = 'cruise';
      nav.directTo(nav.arrivalRunway.iaf);
      ap.setAlt(5000);
      ap.pushHdg();
      ap.toggleAthr();
      ap.toggleAp();
      Object.assign(pilot, { throttle: A320.detents.cl, flapLever: 0, gearDown: false });
      fly(6);
      break;
    }
    case 'final':
    case 'warning': {
      const rw = AIRFIELDS.island.runways['27'];
      const dist = (kase === 'final' ? 2.1 : 1.15) * NM;
      const tch = (dist + 300) * Math.tan(3 * D2R);
      const alt = AIRFIELDS.island.elevationFt + tch / FT + (kase === 'final' ? -12 : 40);
      const warn = kase === 'warning';
      fm.placeInAir(rw.threshold.x + dist, rw.threshold.z + 28, alt, 272, warn ? 150 : 140, warn ? 3 : 4, !warn);
      ap.syncAirborne(s);
      nav.update(0, s);
      nav.phase = 'approach';
      nav.directTo(`RW${rw.ident}`);
      ap.setAlt(3000);
      ap.toggleAthr();
      ap.pushAppr();
      if (!warn) ap.toggleAp();
      Object.assign(pilot, { throttle: A320.detents.cl, flapLever: warn ? 3 : 4, gearDown: !warn });
      fly(warn ? 1.5 : 9);
      if (warn) {
        warnings = [{ text: 'L/G GEAR NOT DOWN', level: 'warning' }];
        memos = ['SEAT BELTS', 'NO SMOKING'];
        masterWarning = true;
      }
      break;
    }
    case 'rollout': {
      const rw = AIRFIELDS.home.runways['27'];
      fm.placeOnGround(rw.threshold.x - 60, rw.threshold.z, 270, { enginesRunning: true });
      nav.phase = 'takeoff';
      ap.setAlt(5000);
      ap.pushHdg();
      Object.assign(pilot, { throttle: A320.detents.toga, flapLever: 1, autobrake: 'max' });
      for (let t = 0; s.ias < 110 && t < 60; t += 0.25) fly(0.25);
      Object.assign(pilot, { throttle: 0, reverse: 1, brakeL: 0.8, brakeR: 0.8 });
      fly(4.5);
      break;
    }
    case 'taxi': {
      fm.placeOnGround(-260, AIRFIELDS.home.geo.taxiwayZ, 90, { enginesRunning: true });
      nav.phase = 'taxi-out';
      ap.setAlt(5000);
      ap.pushHdg();
      Object.assign(pilot, { throttle: 0.24, flapLever: 1, autobrake: 'max', spoilersArmed: false });
      fly(14, () => (pilot.throttle = s.gs > 14 ? 0 : 0.24));
      break;
    }
  }

  // the world: the 60 km view, the haze, the airfield's lights at night
  geography(p);
  // the environment works out its night only once it has run a frame: take it from the hour
  const night = hour < 5.5 || hour > 19.5 ? 1 : 0;
  field.setLights(night);

  const outside = q.get('view') === 'outside';
  const mount = document.createElement('div');
  const touch = q.get('touch') === '1' ? await touchHud(mount, kase === 'final' ? 'Follow the flight director down the glide path' : 'Thrust levers to TOGA') : null;
  if (!touch) {
    mount.style.cssText = 'position:fixed;inset:0;pointer-events:none';
    document.body.appendChild(mount);
  }
  const cockpit = new Cockpit(ctx, mount);
  cockpit.setView(outside ? 'outside' : 'cockpit');
  const solo = q.get('solo');
  if (solo) {
    const st = document.createElement('style');
    st.textContent = `.ck-du-${solo}{position:fixed!important;left:50%;top:50%;width:860px!important;height:860px!important;transform:translate(-50%,-50%);z-index:9}`;
    document.head.append(st);
  }

  let plane: ReturnType<typeof createA320> | null = null;
  if (outside) {
    plane = createA320({ livery: LIVERIES.funfair, detail: 'hero', shadows: ctx.quality.shadows }, { spotLight: false });
    ctx.scene.add(plane.group);
    plane.setNight(night);
  }

  const hh = Math.floor(hour) % 24;
  const mm = Math.floor((hour % 1) * 60);
  const data: CockpitData = {
    s,
    fcu: ap.fcu,
    ils: nav.ils(s),
    nav,
    traffic: [
      { callsign: 'CDY23', x: s.pos.x + 5200, z: s.pos.z - 2600, altFt: s.altFt + 1200, vs: -900 },
      { callsign: 'SUN41', x: s.pos.x - 7400, z: s.pos.z - 9000, altFt: s.altFt - 400, vs: 0 },
    ],
    weather,
    phase: nav.phase,
    warnings,
    memos,
    utc: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:14`,
    chronoS: kase === 'final' ? 372 : null,
    timeWarp: 1,
    night,
    sys: fm.sys,
    controls: pilot,
    speedTarget: ap.speedTarget,
    lvrClb: ap.lvrClb,
    athrActive: ap.athrActive,
    masterWarning,
    masterCaution: false,
    knob: kase === 'climb' ? 'hdg' : null,
  };

  // the camera: at the captain's eye looking 7° below the nose (the 2D panel hides the real one), or a chase view
  const look = Number(q.get('yaw') ?? 0);
  const eye = new THREE.Vector3(A320_POINTS.eye.x, A320_POINTS.eye.y, A320_POINTS.eye.z);
  const camQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-7 * D2R, -look * D2R, 0, 'YXZ'));
  const cam = ctx.camera;
  cam.fov = Number(q.get('fov') ?? 60);
  cam.updateProjectionMatrix();
  const place = () => {
    if (outside) {
      const off = new THREE.Vector3(-14, 9, 46).applyQuaternion(s.quat);
      cam.position.copy(s.pos).add(off);
      cam.lookAt(s.pos.x, s.pos.y + 3, s.pos.z);
    } else {
      cam.position.copy(eye).applyQuaternion(s.quat).add(s.pos);
      cam.quaternion.copy(s.quat).multiply(camQ);
    }
  };
  place();
  p.view(cam.position.clone(), s.pos.clone());
  place();
  await cockpitFontReady();

  p.onFrame((dt, t) => {
    data.night = p.env?.night ?? night;
    place();
    field.update(dt, t, cam);
    if (plane) {
      plane.group.position.copy(s.pos);
      plane.group.quaternion.copy(s.quat);
      plane.setVisual(
        {
          flapsDeg: s.flapsDeg,
          slatsDeg: s.slatsDeg,
          gear: s.gear,
          aileron: s.aileron,
          elevator: s.elevator,
          rudder: s.rudder,
          spoilerL: fm.sys.spoilerL,
          spoilerR: fm.sys.spoilerR,
          reverser: s.reverser,
          n1: s.n1,
          nosewheel: s.nosewheel,
          wheelSpin: s.wheelSpin,
          compression: s.compression,
          doorL1: 0,
          doorL2: 0,
          cargo: 0,
          lights: { nav: true, beacon: true, strobe: !s.onGround, landing: s.altFt < 3000, taxi: s.onGround, logo: night > 0.3, cabin: night > 0.3 },
        },
        dt,
        t,
      );
    }
    cockpit.update(dt, data);
    touch?.update(pilot.throttle, { gear: pilot.gearDown, ap: ap.fcu.ap, athr: ap.fcu.athr, speedbrake: pilot.speedbrake > 0.05, warp: 1, flaps: pilot.flapLever });
  });
};

/**
 * The Game's HUD as it stands while piloting on a phone, built from the same markup (index.html) and
 * stylesheets (styles.css, flight.css), with the cockpit mount first in it as the flight puts it.
 */
async function touchHud(mount: HTMLDivElement, hint: string) {
  await import('../../styles.css');
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.className = 'hud';
  hud.innerHTML = `
    <div id="ride-exit" class="ride-exit"><button type="button" class="btn btn-small btn-cream">Exit ride <kbd>Esc</kbd></button></div>
    <button type="button" id="info-toggle" class="hud-icon hud-info" aria-label="Info (I)">i</button>
    <div class="touch" id="touch">
      <div class="stick" id="stick"><span class="stick-knob" id="stick-knob"></span></div>
      <button type="button" class="touch-action" id="touch-action" aria-label="Play">E</button>
    </div>`;
  hud.insertBefore(mount, hud.firstChild);
  document.body.appendChild(hud);
  document.body.classList.add('is-piloting');
  const fh = new FlightHud(hud, true);
  fh.show(true);
  fh.hint({ text: hint }, true);
  fh.camera('Cockpit');
  return new FlightTouch(hud.querySelector<HTMLElement>('#touch')!, () => {});
}
export default scene;
