// The whole flight attraction (world/attractions/flight.ts) in the world as Game builds it: both
// airfields, Funfair International's terminal and Palm Cay's, both airsides with the tug, the AI
// traffic and (for the gate shots) the travellers. The round is started from the booking card's
// choices and flown by the scripted crew (world/flight/crew.ts) through the real Flight screen, run
// ahead before the first frame until the moment asked for, then shown with the game's own HUD, the
// cockpit and (touch=1) the touch controls.
//
//   ?scene=flight&phase=offer                        the booking card at gate 3
//   ?scene=flight&phase=boarding                     passengers walking on, from the gate window
//   ?scene=flight&phase=pushback&cam=chase           the tug pushing back, engines starting
//   ?scene=flight&phase=taxi                         taxiing out on the greens, the taxi guide
//   ?scene=flight&phase=lineup                       lined up on the runway
//   ?scene=flight&phase=rotate&cam=chase             rotation
//   ?scene=flight&phase=climb                        climbing out
//   ?scene=flight&phase=cruise&cam=chase             cruising over the sea
//   ?scene=flight&phase=final                        2 NM final at Palm Cay
//   ?scene=flight&phase=goaround                     climbing away from a go-around at 500 ft: FMA, hint
//   ?scene=flight&phase=flare                        the flare
//   ?scene=flight&phase=rollout                      the rollout
//   ?scene=flight&phase=deplane                      passengers leaving at Palm Cay
//   ?scene=flight&phase=report                       the flight report card on the stand
//   ?scene=flight&phase=ditch&cam=chase              a ditching's aftermath: afloat, slides out (at=seconds after)
//   ?scene=flight&phase=abandon                      Esc in the cruise: exit(), the hero back on its stand, stats logged
//   &tod=night (dawn, day, dusk), &leg=back (FA102 from Palm Cay), &touch=1 (phone controls),
//   &cam=cockpit|chase|wing|tower|cabin, &extra=<s> more real-time seconds after the moment
import * as THREE from 'three';
import type { PreviewApi, PreviewScene } from '../main';
import '../../styles.css';
import { AIRFIELDS } from '../../aviation/airports';
import { Traffic } from '../../aviation/traffic';
import { phaseIndex } from '../../aviation/nav';
import { NM } from '../../world/geo';
import type { Region } from '../../world/geo';
import type { TimeOfDay } from '../../aviation/types';
import { Airfield } from '../../world/airport/airfield';
import { Airside, reservedStands } from '../../world/airport/airside';
import { HomeTerminal } from '../../world/airport/terminal';
import { IslandTerminal } from '../../world/island/island-terminal';
import { createA320 } from '../../world/airport/a320-model';
import { Flight, type FlightDeps } from '../../world/attractions/flight';
import { Crew } from '../../world/flight/crew';
import { flightGround } from '../../world/flight/ground';
import { CAM_ORDER, type CamMode } from '../../world/flight/cameras';
import { cockpitFontReady } from '../../world/flight/instruments/display';
import type { Post } from '../../world/post';
import type { UI } from '../../world/ui';
import type { Boarding, Travellers } from '../../world/crowd/travellers';

type Phase = 'offer' | 'boarding' | 'pushback' | 'taxi' | 'lineup' | 'rotate' | 'climb' | 'cruise' | 'final' | 'flare' | 'rollout' | 'deplane' | 'report' | 'ditch' | 'goaround' | 'abandon';

/** The game's HUD markup that the flight hangs its overlays on (index.html's #hud, #panel and #touch). */
function hudDom(touch: boolean) {
  const hud = document.createElement('div');
  hud.className = 'hud';
  hud.id = 'hud';
  hud.innerHTML = `<div id="ride-exit" class="ride-exit"><button type="button" class="btn btn-small btn-cream">Exit ride <kbd>Esc</kbd></button></div>
<button type="button" class="hud-icon hud-info" aria-label="Info (I)">i</button>
<aside id="panel" class="panel" hidden></aside>
<div class="touch" id="touch"${touch ? '' : ' hidden'}>
<div class="stick" id="stick"><span class="stick-knob"></span></div>
<button type="button" class="touch-action" id="touch-action" aria-label="Play">E</button>
<div class="touch-lift" id="touch-lift"></div>
</div>`;
  document.body.append(hud);
  return hud;
}

/** Enough of ctx.ui for the flight: the HUD element, the card and the intro. */
function previewUi(hud: HTMLElement): UI {
  const panel = hud.querySelector('#panel') as HTMLElement;
  let key = '';
  const api = {
    hud,
    panel(k: string, html: string) {
      key = k;
      panel.innerHTML = `<button class="close" type="button" aria-label="Close">✕</button>${html}`;
      panel.hidden = false;
    },
    hidePanel() {
      panel.hidden = true;
      key = '';
    },
    get panelOpenKey() {
      return panel.hidden ? '' : key;
    },
    get panelElement() {
      return panel;
    },
    setIntro(k: string, _title: string, html: string) {
      api.panel(k, html);
      return true;
    },
  };
  return new Proxy(api, { get: (t, k) => (k in t ? Reflect.get(t, k) : () => undefined) }) as unknown as UI;
}

/** Passengers who are already aboard (or gone) at once: the far phases don't need the crowd. */
function quickTravellers(): Travellers {
  const done: Boarding = { progress: 1, done: true, skip: () => undefined };
  return { board: () => done, deplane: () => done, update: () => undefined, setNight: () => undefined } as unknown as Travellers;
}

const preview: PreviewScene = async (p: PreviewApi) => {
  const { ctx, params } = p;
  const env = p.env;
  if (!env) throw new Error('the flight scene needs env=1');
  const phase = (params.get('phase') ?? 'taxi') as Phase;
  const tod = (params.get('tod') ?? 'day') as TimeOfDay;
  const from: Region = params.get('leg') === 'back' ? 'island' : 'home';
  const touch = params.get('touch') === '1';
  ctx.mobile = touch;
  const hud = hudDom(touch);
  ctx.ui = previewUi(hud);
  if (touch) document.body.classList.add('is-touch');

  // the world as Game builds it
  const fields: Record<Region, Airfield> = { home: new Airfield(ctx, AIRFIELDS.home), island: new Airfield(ctx, AIRFIELDS.island) };
  const home = new HomeTerminal(ctx);
  const island = new IslandTerminal(ctx);
  const airside: Record<Region, Airside> = {
    home: new Airside(ctx, AIRFIELDS.home, { reserved: reservedStands('home') }),
    island: new Airside(ctx, AIRFIELDS.island, { reserved: reservedStands('island') }),
  };
  ctx.scene.add(fields.home.group, fields.island.group, home.group, island.group, airside.home.group, airside.island.group);
  const traffic = new Traffic(ctx, {
    createPlane: (o) => createA320(o),
    onStand: (r, id, state) => {
      if (id === AIRFIELDS[r].playerStand) return;
      if (r === 'home') home.bridges[id]?.dock(state === 'arrived');
      airside[r].setStandService(id, state === 'arrived');
    },
  });
  ctx.scene.add(traffic.group);
  const gate = phase === 'boarding' || phase === 'deplane' || phase === 'offer';
  let travellers = quickTravellers();
  if (gate) {
    const [{ GLTFLoader }, people, isle, crowd] = await Promise.all([
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('../../world/crowd/people'),
      import('../../world/island/island'),
      import('../../world/crowd/travellers'),
    ]);
    const loader = new GLTFLoader();
    const [guests, anims] = await Promise.all([loader.loadAsync(people.GUESTS_URL), loader.loadAsync(people.GUEST_ANIMS_URL)]);
    const palmCay = new isle.PalmCay(ctx);
    ctx.scene.add(palmCay.group);
    for (let i = 0; i < 200; i++) {
      home.update(1 / 30, i / 30, ctx.camera);
      island.update(1 / 30, i / 30);
    }
    travellers = new crowd.Travellers(ctx, new people.PeopleFactory(guests, anims), { home, island, palmCay, shadows: ctx.quality.shadows, tier: ctx.quality.tier });
  }
  const ground = flightGround({ home: (x, z) => fields.home.surfaceAt(x, z), island: (x, z) => fields.island.surfaceAt(x, z) });
  const post = { setAOEnabled: () => undefined } as unknown as Post;
  const deps: FlightDeps = { env, post, airfields: fields, homeTerminal: home, islandTerminal: island, airside, traffic, travellers, ground };
  const flight = new Flight(ctx, deps);
  const sky = ctx.scene.children.find((o) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.ShaderMaterial).uniforms?.sunPosition);

  // the booking card, then the round
  const card = () => {
    ctx.ui.panel('flight-offer-1', flight.offerHtml(from));
    flight.wireOffer(ctx.ui.panelElement, () => undefined);
  };
  card();
  if (tod !== 'day') (ctx.ui.panelElement.querySelector(`[data-fl-tod="${tod}"]`) as HTMLButtonElement | null)?.click();

  let t = 0;
  const region = () => flight.region;
  const frame = (dt: number, heavy: boolean) => {
    t += dt;
    traffic.update(dt, t, flight.trafficPlayer, region());
    flight.update(dt, t);
    if (heavy) {
      const n = env.night;
      for (const r of ['home', 'island'] as const) {
        airside[r].setAircraft(traffic.bodies(r));
        airside[r].setNight(n);
        airside[r].update(dt, t, ctx.camera);
        fields[r].update(dt, t, ctx.camera);
      }
      traffic.setNight(n);
      home.setNight(n);
      island.setNight(n);
      home.update(dt, t, ctx.camera);
      island.update(dt, t);
      travellers.setNight(n);
      travellers.update(dt, t, ctx.camera, region());
    }
  };

  if (phase === 'offer') {
    const spot = from === 'home' ? { x: -30, z: 524 } : { x: -30, z: 40612 };
    p.view({ x: spot.x + 6, y: 1.7, z: spot.z + (from === 'home' ? -8 : 8) }, { x: spot.x, y: 1.4, z: spot.z + (from === 'home' ? 20 : -20) });
    p.onFrame((dt) => {
      sky?.position.copy(ctx.camera.position);
      frame(dt, true);
    });
    return;
  }
  ctx.ui.hidePanel();
  flight.start();
  const sim = flight.simulation!;
  const crew = new Crew(sim, { skipTaxiIn: true, goAroundFt: phase === 'goaround' ? 500 : 0 });
  flight.pilotOverride = crew.frame;

  // run ahead to the moment
  const dt = 1 / 30;
  const s = sim.state;
  const reached = (): boolean => {
    const st = sim.stage;
    const r = sim.route;
    switch (phase) {
      case 'boarding':
        return sim.realT > Number(params.get('at') ?? 9);
      case 'pushback':
        return st === 'push' && sim.towing && sim.stageT > 30;
      case 'taxi':
        return st === 'taxi' && sim.routeKind === 'out' && !!r && r.along > 260;
      case 'lineup':
        return st === 'taxi' && sim.routeKind === 'lineup' && !!r && Math.abs(((s.heading - sim.depRw.heading + 540) % 360) - 180) < 3;
      case 'rotate':
        return !s.onGround || (st === 'flight' && s.pitch > 6);
      case 'climb':
        return !s.onGround && s.altFt > 2200 && sim.nav.phase === 'climb';
      case 'cruise':
        return sim.nav.phase === 'cruise' && Math.abs(s.pos.z - (from === 'home' ? 18000 : 22000)) < 400;
      case 'final':
        return st === 'flight' && (sim.nav.phase === 'approach' || sim.nav.phase === 'final') && sim.finalDistance() < 2 * NM && sim.finalDistance() > 0 && Math.abs(s.pos.z - sim.arrRw.threshold.z) < 300;
      case 'flare':
        return st === 'flight' && phaseIndex(sim.nav.phase) >= phaseIndex('final') && !s.onGround && s.radioAltFt < 28;
      case 'rollout':
        return s.onGround && phaseIndex(sim.nav.phase) >= phaseIndex('landing') && s.gs < 95 && s.gs > 50;
      case 'deplane':
        return st === 'deplaning' && sim.stageT > Number(params.get('at') ?? 5);
      case 'report':
        return st === 'done';
      case 'goaround':
        return sim.nav.goArounds > 0 && s.radioAltFt > 1200;
      case 'abandon':
        return sim.nav.phase === 'cruise';
      case 'ditch':
        return st === 'failed' && sim.stageT > Number(params.get('at') ?? 4);
      default:
        return true;
    }
  };
  const fast = !gate;
  let n = 0;
  let ditched = false;
  while (!reached() && n < 30 * 60 * 40) {
    // the ditching: from the cruise, put down on the sea with the gear up
    if (phase === 'ditch' && !ditched && sim.nav.phase === 'cruise') {
      ditched = true;
      flight.pilotOverride = (fdt) => {
        sim.pilot.throttle = 0;
        sim.pilot.pitch = s.radioAltFt < 40 ? 0.2 : -0.15;
        void fdt;
      };
      if (sim.ap.fcu.ap) sim.ap.toggleAp();
      if (sim.ap.fcu.athr) sim.ap.toggleAthr();
      sim.fm.placeInAir(s.pos.x, s.pos.z, 300, s.heading, 150, 3, false);
    }
    // the long, quiet parts at four times the speed, as the visitor may fly them
    if (fast && sim.warpAllowed() && phase !== 'climb' && phase !== 'rotate') sim.warp = 4;
    frame(dt, gate);
    n++;
  }
  console.warn(`[flight] ${phase}: ${reached() ? 'reached' : 'NOT reached'} after ${(n * dt).toFixed(0)} s real, ${sim.t.toFixed(0)} s sim · ${sim.stage}/${sim.nav.phase} · ${s.altFt.toFixed(0)} ft ${s.ias.toFixed(0)} kt · score ${sim.scorer.score()}`);
  sim.warp = 1;
  if (phase === 'deplane' || phase === 'report') flight.pilotOverride = null;
  if (phase === 'abandon') {
    flight.exit();
    const f = flight.focus;
    console.warn(`[flight] abandoned: completed ${flight.completed}, arrival ${JSON.stringify(flight.arrival)}, focus ${f.x.toFixed(0)},${f.z.toFixed(0)} (${flight.region}), stats ${JSON.stringify(flight.roundStats())}, hud ${document.body.classList.contains('is-piloting') ? 'piloting' : 'off'}`);
    const a = flight.arrival ?? { x: f.x, z: f.z };
    p.view({ x: a.x + 10, y: 4, z: a.z + (from === 'home' ? -6 : 6) }, { x: f.x, y: 4, z: f.z });
    p.onFrame((fdt) => {
      frame(fdt, true);
      sky?.position.copy(ctx.camera.position);
    });
    return;
  }

  const cam = params.get('cam') as CamMode | null;
  // the round starts in the captain's seat: step round to the camera asked for
  if (cam && CAM_ORDER.includes(cam)) for (let i = 0; i < CAM_ORDER.indexOf(cam); i++) flight.cycleCamera();
  await cockpitFontReady();
  const extra = Number(params.get('extra') ?? 0);
  for (let i = 0; i < extra * 30; i++) frame(dt, true);

  const camPos = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  p.onFrame((fdt) => {
    frame(fdt, true);
    flight.updateCamera(ctx.camera, fdt);
    sky?.position.copy(ctx.camera.position);
    // the harness's environment (shadows, grass) follows its focus: keep that on the aircraft
    camPos.copy(ctx.camera.position);
    camQ.copy(ctx.camera.quaternion);
    p.view(camPos, flight.focus);
    ctx.camera.quaternion.copy(camQ);
  });
};
export default preview;
