// The flight attraction's logic, gate to gate, in node: FA101 from Funfair International to Palm
// Cay and FA102 back, each flown by the scripted crew (world/flight/crew.ts) through the real
// FlightSim (world/flight/sim.ts): boarding, the pushback with the engine start, the taxi along
// ATC's route to the holding point, waiting at the red stop bar for the AI traffic, the takeoff,
// the climb and cruise on the autopilot (with time warp), the descent, the ILS, the manual landing,
// the rollout, the taxi-in to the stand and the deplaning. The ground is the real airfields'
// pavement, the terrain and the sea; the traffic is the real AI traffic on stub models.
// A third flight (FA101 again) goes around from 500 ft on the first approach and must come round,
// land and park. On every flight the load factor must read what a passenger feels (1 g level,
// 1 / cos bank in a level turn), so the comfort score means something.
//   node scripts/flight-check.mjs [tod=day] [skip] [verbose] [trace=s] [YYYY-MM-DD] [leg=0|1|2] [flare]
// tod: dawn | day | dusk | night; skip: skip the taxi-in; verbose: print the radio; leg: fly only that one;
// flare: trace the last 150 ft of each landing.
import { createServer } from 'vite';

const args = process.argv.slice(2);
const tod = args.find((a) => ['dawn', 'day', 'dusk', 'night'].includes(a)) ?? 'day';
const skip = args.includes('skip');
const verbose = args.includes('verbose');
const flare = args.includes('flare');
const trace = Number((args.find((a) => a.startsWith('trace=')) ?? 'trace=0').slice(6));
const dateArg = args.find((a) => /^\d{4}-\d\d-\d\d$/.test(a));
const date = dateArg ? new Date(`${dateArg}T12:00:00`) : new Date();
const onlyLeg = args.find((a) => a.startsWith('leg='));

const server = await createServer({ root: process.cwd(), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failed++;
};
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
try {
  const THREE = await server.ssrLoadModule('three');
  const { bookFlight, metars } = await server.ssrLoadModule('/src/world/flight/booking.ts');
  const { FlightSim } = await server.ssrLoadModule('/src/world/flight/sim.ts');
  const { Crew } = await server.ssrLoadModule('/src/world/flight/crew.ts');
  const { flightGround, planPavement } = await server.ssrLoadModule('/src/world/flight/ground.ts');
  const { AIRFIELDS } = await server.ssrLoadModule('/src/aviation/airports.ts');
  const { Traffic } = await server.ssrLoadModule('/src/aviation/traffic.ts');
  const { Sfx } = await server.ssrLoadModule('/src/world/audio.ts');
  const { regionAt } = await server.ssrLoadModule('/src/world/geo.ts');

  const ground = flightGround({ home: planPavement(AIRFIELDS.home), island: planPavement(AIRFIELDS.island) });
  const camera = new THREE.PerspectiveCamera();
  const ctx = { camera, quality: { shadows: false }, sfx: { trafficJet() {} } };
  const createPlane = (o) => ({ group: new THREE.Group(), livery: o.livery, setVisual() {}, setCockpitView() {}, setNight() {}, dispose() {} });
  const sfx = new Sfx();

  const legs = [{ from: 'home' }, { from: 'island' }, { from: 'home', goAroundFt: 500 }];
  for (const [li, leg] of legs.entries()) {
    if (onlyLeg && Number(onlyLeg.slice(4)) !== li) continue;
    const { from, goAroundFt = 0 } = leg;
    const info = bookFlight(from, tod, date);
    const m = metars(info);
    const name = `${info.flightNo}${goAroundFt ? ' (go-around)' : ''}`;
    console.log(`\n=== ${name} ${AIRFIELDS[from].geo.name} → ${AIRFIELDS[info.to].geo.name}, ${tod} (${info.hour}h), ${info.passengers} pax, runway ${info.depRunway} → ${info.arrRunway}`);
    console.log(`    ${m.dep}`);
    const traffic = new Traffic(ctx, { createPlane, seed: info.seed });
    traffic.setWeather(info.weather);
    // the airports have been busy all morning
    for (let i = 0; i < 600; i++) traffic.update(0.5, i * 0.5, null, from);
    const sim = new FlightSim({ info, ground, sfx, traffic });
    traffic.onRadioAt = (u, region, station) => sim.hear(u, region, station);
    const crew = new Crew(sim, { skipTaxiIn: skip, goAroundFt });
    const stages = [];
    sim.onStage = (st) => stages.push(`${st}@${mmss(sim.t)}`);
    const notes = [];
    sim.onNote = (n) => notes.push(`${mmss(sim.t)} ${n}`);
    // the radio log and the cabin's, apart: no PA or passenger line may reach the radio log
    let radioCabin = 0;
    let paLines = 0;
    sim.speech.onLine = (u) => {
      if (u.speaker === 'pa' || u.speaker === 'cabin' || /^(Ladies and gentlemen|Cabin crew,)/.test(u.text)) radioCabin++;
      if (verbose) console.log(`  ${mmss(sim.t)} [${u.from}] ${u.text}`);
    };
    sim.speech.onCabin = (u) => {
      paLines++;
      if (verbose) console.log(`  ${mmss(sim.t)} (cabin) [${u.from}] ${u.text}`);
    };
    const toasts = [];
    sim.onScore = (it) => toasts.push(`${it.points > 0 ? '+' : it.points < 0 ? '−' : ''}${Math.abs(it.points) || ''} ${it.label}`);
    let redCross = false;
    let maxBank = 0;
    // the worst gap, away from the ground, between the load factor and what the bank and the climb's
    // change give: (1 + vertical acceleration / g) / cos bank (the body's up axis, not the world's)
    let gErr = 0;
    let gErrAt = '';
    // what the hint says on the missed approach (it once offered the arrival's stale direct-to)
    const gaHints = new Set();
    let lastVs = 0;
    let lastT = -1;
    let warpS = 0;
    const dt = 1 / 30;
    let t = 300;
    let boardT = 0;
    for (let i = 0; i < 3600 * 30 && sim.stage !== 'done'; i++) {
      // boarding: the passengers take ~20 s to watch, then the visitor skips
      if (sim.stage === 'boarding') {
        boardT += dt;
        sim.boarding(Math.min(1, boardT / 20));
      }
      if (sim.warp === 1 && sim.warpAllowed() && sim.stage === 'flight') {
        sim.cycleWarp();
        sim.cycleWarp();
      }
      if (sim.warp > 1) warpS += dt;
      const s = sim.state;
      traffic.update(dt * sim.warp, t, s, regionAt(s.pos.x, s.pos.z));
      t += dt * sim.warp;
      sim.step(dt, crew.frame);
      if (trace && i % Math.round(trace * 30) === 0) {
        const c = sim.pilot;
        const r = sim.route;
        console.log(`  ${mmss(sim.t)} ${sim.stage}/${sim.nav.phase} pos ${s.pos.x.toFixed(0)},${s.pos.z.toFixed(0)} hdg ${s.heading.toFixed(0)} gs ${s.gs.toFixed(1)} ias ${s.ias.toFixed(0)} alt ${s.altFt.toFixed(0)} n1 ${(s.n1[0] * 100).toFixed(0)}/${(s.n1[1] * 100).toFixed(0)} thr ${c.throttle.toFixed(2)} brk ${c.brakeL.toFixed(2)} pb ${c.parkingBrake} til ${c.tiller.toFixed(2)} flap ${c.flapLever} gear ${s.gear.toFixed(1)} ra ${s.radioAltFt.toFixed(0)} vs ${s.vs.toFixed(0)} ${r ? `route ${sim.routeKind} ${r.index}/${r.nodes.length} ${r.along.toFixed(0)}/${r.lengthM.toFixed(0)} adv ${sim.guide.adviceKt.toFixed(0)}` : ''} ${sim.ap.fcu.fma.lateral}/${sim.ap.fcu.fma.vertical} ap ${sim.ap.fcu.ap} ga ${sim.nav.goArounds}${sim.nav.goingAround ? "*" : ""} leg ${sim.nav.activeIndex} atc ${sim.atc.stage}${sim.atc.clearance.approach ? "+appr" : ""} dis ${sim.scorer.discomfort.toFixed(1)} bank ${s.bank.toFixed(0)} pitch ${s.pitch.toFixed(0)} beta ${s.beta.toFixed(1)} ny ${s.ny.toFixed(2)} nz ${s.nz.toFixed(2)}${crew.exitPath ? ` exit ${crew.exitPath.index}/${crew.exitPath.along.toFixed(0)}/${crew.exitPath.lengthM.toFixed(0)} tgt ${crew.tgt.x.toFixed(0)},${crew.tgt.z.toFixed(0)}` : ''}${(() => { const g = sim.nav.ils(s); return g ? ` ils ${g.valid ? '' : 'invalid '}loc ${g.locM.toFixed(0)} m gs ${g.gsFt.toFixed(0)} ft dme ${g.dme.toFixed(1)} arm ${sim.ap.fcu.fma.armedLateral}/${sim.ap.fcu.fma.armedVertical}` : ''; })()}`);
      }
      if (flare && sim.stage === 'flight' && !crew.log.touchdown && !s.onGround && s.radioAltFt < 150 && ['final', 'landing'].includes(sim.nav.phase) && i % 3 === 0) {
        const c = sim.pilot;
        console.log(`  ${mmss(sim.t)} ra ${s.radioAltFt.toFixed(1)} vs ${s.vs.toFixed(0)} ias ${s.ias.toFixed(0)} pitch ${s.pitch.toFixed(1)} q ${s.q.toFixed(3)} stick ${c.pitch.toFixed(2)} thr ${c.throttle.toFixed(2)} n1 ${(s.n1[0] * 100).toFixed(0)} ${sim.ap.fcu.fma.vertical} ap ${sim.ap.fcu.ap} bank ${s.bank.toFixed(1)} roll ${c.roll.toFixed(2)} wind ${sim.air?.surfaceWind?.().kt.toFixed(0) ?? ''}`);
      }
      if (!s.onGround) maxBank = Math.max(maxBank, Math.abs(s.bank));
      if (!s.onGround && s.radioAltFt > 1500 && Math.abs(s.pitch) < 12 && lastT >= 0 && sim.t > lastT) {
        const az = ((s.vs - lastVs) * 0.3048) / 60 / (sim.t - lastT);
        const want = (1 + az / 9.80665) / Math.cos((s.bank * Math.PI) / 180);
        const e = Math.abs(s.nz - want);
        if (e > gErr) [gErr, gErrAt] = [e, `${mmss(sim.t)}: ${s.nz.toFixed(2)} g for ${want.toFixed(2)}, ${s.bank.toFixed(0)}° bank, ${Math.round(s.vs)} fpm`];
      }
      [lastVs, lastT] = [s.vs, sim.t];
      if (sim.nav.goingAround && i % 30 === 0) gaHints.add(sim.hint()?.text ?? '');
      // crossing the departure's holding point with its bar still red
      const clr = sim.atc.clearance;
      const hold = clr.taxi ? AIRFIELDS[from].nodes[clr.taxi.holdShort] : null;
      if (hold && sim.holdRed && Math.abs(s.pos.z - hold.z) < 3 && Math.abs(s.pos.x - hold.x) < 30 && Math.abs(s.pos.z - AIRFIELDS[from].geo.runway.z) < Math.abs(hold.z - AIRFIELDS[from].geo.runway.z) - 2) redCross = true;
    }
    const sc = sim.scorer;
    const st = sc.stats();
    const l = sc.landing;
    const td = crew.log.touchdown;
    console.log(`    stages: ${stages.join(' → ')}`);
    console.log(`    block ${mmss(sc.blockTimeS)} (schedule ${mmss(sc.scheduleS)}, plan ${mmss(info.plan.blockTimeS)}), ${mmss(sim.t)} simulated, ${mmss(sim.realT)} real (${mmss(warpS)} warped), waited ${Math.round(crew.log.waitedAtHoldS)} s at the hold`);
    console.log(`    score ${st.score} ★${st.stars} comfort ${st.comfort}; landing ${l ? `${Math.round(l.fpm)} fpm ${l.g.toFixed(2)} g, ${Math.round(l.touchdownM)} m in, ${l.centrelineM.toFixed(1)} m off, crab ${l.crabDeg.toFixed(1)}°` : 'none'}`);
    console.log(`    stats ${JSON.stringify(st)}`);
    console.log(`    toasts: ${toasts.join(' | ')}`);
    if (notes.length) console.log(`    notes: ${notes.join(' | ')}`);
    const d = sc.debrief();
    console.log(`    debrief: ${d.title}`);
    for (const line of d.lines) console.log(`      ${line}`);
    const parkedAt = sim.arrStand;
    const s = sim.state;
    check(sim.stage === 'done' && !sim.failed, `${name}: gate to gate (${sim.failure ?? sim.stage})`);
    if (goAroundFt) check(sim.nav.goArounds === 1 && !!l && notes.some((n) => n.endsWith('NAV: direct ' + sim.arrRw.iaf)) && !toasts.some((t) => t.includes('GPWS')), `${name}: one go-around without a GPWS warning, round on NAV to ${sim.arrRw.iaf}, landed from the next approach (${sim.nav.goArounds})`);
    if (goAroundFt) {
      const directs = [...gaHints].filter((h) => h.startsWith('Going around: direct'));
      check(directs.every((h) => h.includes(` ${sim.arrRw.iaf} `)) && [...gaHints].some((h) => /heading \d{3}/.test(h)) && ![...gaHints].some((h) => h.startsWith('Going around') && !/heading \d{3}|direct/.test(h)), `${name}: the missed approach's hints give ATC's heading, then direct ${sim.arrRw.iaf} (${[...gaHints].filter((h) => h.startsWith('Going around')).join(' / ')})`);
    }
    check(gErr < 0.12, `${name}: the load factor reads the bank and the climb (worst ${gErr.toFixed(2)} g off, ${gErrAt})`);
    check(st.comfort >= 50, `${name}: passenger comfort ≥ 50 % (${st.comfort})`);
    // the go-around flight tests the go-around: its second landing, hand-flown by the scripted crew
    // from a different configuration history, gets a looser bar (a firm but safe arrival, and the score
    // of one)
    const maxFpm = goAroundFt ? 450 : 360;
    const minScore = goAroundFt ? 60 : 75;
    check(!!td && td.vsFpm <= maxFpm && !!l && l.touchdownM >= sim.arrRw.tdz.from && l.touchdownM <= sim.arrRw.tdz.to, `${name}: touchdown in the TDZ ≤ ${maxFpm} fpm (${td ? Math.round(td.vsFpm) : 'none'})`);
    check(Math.hypot(s.pos.x - parkedAt.x, s.pos.z - parkedAt.z) < 1 && Math.abs(((s.heading - parkedAt.heading + 540) % 360) - 180) < 2, `${name}: parked on stand ${parkedAt.id}`);
    check(!redCross, `${name}: never crossed a red stop bar`);
    check(radioCabin === 0 && paLines >= 10, `${name}: the cabin on its own channel (${paLines} cabin lines, ${radioCabin} in the radio log)`);
    check(st.score >= minScore, `${name}: score ≥ ${minScore} (${st.score})`);
    check(maxBank < 30, `${name}: bank < 30° (${maxBank.toFixed(1)}°)`);
    check(Math.abs(crew.log.maxAltFt - info.plan.cruiseFt) < 200, `${name}: cruise ${info.plan.cruiseFt} ft (max ${Math.round(crew.log.maxAltFt)})`);
    // a go-around costs its time: the schedule only holds for the straight-in flights
    if (!goAroundFt) check(sc.blockTimeS <= sc.scheduleS, `${name}: on time`);
  }
} finally {
  await server.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
