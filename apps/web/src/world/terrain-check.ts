// Checks on the land and the sea that the airports, the flight and the island games rely on (run
// by scripts/terrain-check.mjs in node). Each returns a row for the table: name, pass, numbers.

import { AIRPORTS, ISLAND, SEA_Y, homeCoastZ, homeShoreDist, islandShoreDist } from './geo';
import { ISLAND_HILLS, forestAt, groundY, islandClear, islandDepth, jungleAt, lagoonSdf, meshY, onLand, reefAt } from './terrain-land';
import { waveY, setSwell } from './sea-waves';

interface Row {
  name: string;
  ok: boolean;
  detail: string;
}

function scan(x0: number, x1: number, z0: number, z1: number, step: number, fn: (x: number, z: number) => void) {
  for (let x = x0; x <= x1; x += step) for (let z = z0; z <= z1; z += step) fn(x, z);
}

export function runTerrainChecks(): Row[] {
  const rows: Row[] = [];
  const add = (name: string, ok: boolean, detail: string) => rows.push({ name, ok, detail });
  const home = AIRPORTS.home;
  const isl = AIRPORTS.island;

  // ---- the home airport's ground is flat at y = 0, from z 250 to the beach ----
  {
    let worst = 0;
    let mesh = 0;
    let n = 0;
    scan(-2700, 2700, 250, 1400, 25, (x, z) => {
      if (homeShoreDist(x, z) < 25) return;
      n++;
      worst = Math.max(worst, Math.abs(groundY(x, z)));
      mesh = Math.max(mesh, Math.abs(meshY(x, z)));
    });
    add('home airport ground flat (y = 0)', worst === 0 && mesh < 1e-9, `${n} points, max |groundY| ${worst.toFixed(4)} m, max |meshY| ${mesh.toFixed(4)} m`);
  }
  // ---- the runway strip stays well clear of the water ----
  {
    let minS = Infinity;
    scan(home.runway.x0 - 300, home.runway.x1 + 300, home.runway.z - home.runway.strip, home.runway.z + home.runway.strip, 20, (x, z) => (minS = Math.min(minS, homeShoreDist(x, z))));
    add('home strip ≥ 80 m from the water', minS >= 80, `closest shore ${minS.toFixed(0)} m`);
  }
  // ---- the park and its surroundings stay level ----
  {
    let worst = 0;
    scan(-200, 200, -250, 150, 10, (x, z) => {
      if (Math.hypot(x, z + 50) < 200) worst = Math.max(worst, Math.abs(groundY(x, z)));
    });
    add('park ground level', worst === 0, `max |groundY| inside r 200: ${worst.toFixed(3)} m`);
  }
  // ---- obstacle corridors: ≤ 10 m within 300 m of each extended centreline for 12 km ----
  for (const [ap, label] of [[home, 'home'], [isl, 'island']] as const) {
    let worst = 0;
    let trees = 0;
    const rw = ap.runway;
    for (const side of [-1, 1])
      for (let k = 0; k <= 12000; k += 40)
        for (let off = -300; off <= 300; off += 30) {
          const x = side < 0 ? rw.x0 - k : rw.x1 + k;
          const z = rw.z + off;
          worst = Math.max(worst, groundY(x, z));
          if (label === 'home' && forestAt(x, z, groundY(x, z)) > 0.01) trees++;
          if (label === 'island' && islandShoreDist(x, z) > 0 && !islandClear(x, z) && jungleAt(x, z, islandShoreDist(x, z), groundY(x, z)) > 0.01) trees++;
        }
    add(`${label} approach corridors ≤ 10 m`, worst <= 10 && trees === 0, `highest ground ${worst.toFixed(1)} m, forest/jungle points ${trees}`);
  }
  // ---- nothing new above 25 m within 2 km of the home runway (the park's own ring hills excepted) ----
  {
    let worst = 0;
    const rw = home.runway;
    scan(rw.x0 - 2000, rw.x1 + 2000, rw.z - 2000, rw.z + 2000, 40, (x, z) => {
      if (Math.hypot(x, z + 50) < 1100) return;
      const dx = Math.max(rw.x0 - x, 0, x - rw.x1);
      if (Math.hypot(dx, z - rw.z) > 2000) return;
      worst = Math.max(worst, groundY(x, z));
    });
    add('home: ≤ 25 m within 2 km of the runway', worst <= 25, `highest ${worst.toFixed(1)} m (outside the ring hills)`);
  }
  // ---- the hills reach far enough to hide the world's edge from altitude ----
  {
    let north = 0;
    for (let x = -20000; x <= 20000; x += 250) north = Math.max(north, groundY(x, -30000));
    let mid = 0;
    for (let x = -8000; x <= 8000; x += 100) mid = Math.max(mid, groundY(x, -4000));
    add('mountains to the north', north > 250 && mid > 30, `max at z −30 km ${north.toFixed(0)} m, at z −4 km ${mid.toFixed(0)} m`);
  }
  // ---- the shore profile ----
  {
    const xs = [-30000, -2000, 0, 1500, 22000];
    let err = 0;
    for (const x of xs) {
      const c = homeCoastZ(x);
      err = Math.max(err, Math.abs(groundY(x, c) - SEA_Y), Math.abs(groundY(x, c - 25)), Math.abs(groundY(x, c - 60)));
    }
    let mono = true;
    // stepping seaward (z grows) the ground never rises
    for (let d = 60; d > -300; d -= 1) if (groundY(500, homeCoastZ(500) - d + 1) > groundY(500, homeCoastZ(500) - d) + 1e-9) mono = false;
    add('mainland shore profile', err < 1e-6 && mono, `edge error ${err.toExponential(1)}, falls away monotonically ${mono}`);
  }
  // ---- Palm Cay: the airport, the park and the dry beach are flat; the hills as briefed ----
  {
    let worst = 0;
    const walks = [...isl.walk, ISLAND.park, { x0: isl.runway.x0 - 200, x1: isl.runway.x1 + 200, z0: isl.runway.z - 160, z1: isl.apron.z1 }];
    let n = 0;
    for (const w of walks)
      scan(w.x0, w.x1, w.z0, w.z1, 10, (x, z) => {
        if (islandShoreDist(x, z) < 22) return;
        n++;
        worst = Math.max(worst, Math.abs(groundY(x, z)));
      });
    add('island airport/park/beach level', worst <= 0.06, `${n} points ≥ 22 m from the water, max |y| ${worst.toFixed(3)} m`);
    let peak = { h: 0, x: 0, z: 0 };
    scan(-2600, 2600, 39800, 41700, 20, (x, z) => {
      const h = groundY(x, z);
      if (h > peak.h) peak = { h, x, z };
    });
    let northOk = true;
    scan(-2600, 2600, 39800, 40900, 20, (x, z) => {
      if (groundY(x, z) > 12) northOk = false;
    });
    const hillsOk = peak.h <= 60 && peak.h > 30 && Math.abs(peak.x) >= 700 && peak.z > 40900 && northOk && ISLAND_HILLS.every((p) => Math.abs(p.x) >= 700);
    add('island hills ≤ 60 m, south of z 40900, |x| ≥ 700', hillsOk, `peak ${peak.h.toFixed(1)} m at (${peak.x}, ${peak.z}); nothing over 12 m north of 40900: ${northOk}`);
  }
  // ---- the lagoon is a shallow, calm pool behind a reef ----
  {
    const L = ISLAND.lagoon;
    let dMin = Infinity;
    let dMax = 0;
    scan(L.x0 + 40, L.x1 - 40, L.z0 + 30, L.z1 - 40, 20, (x, z) => {
      // (the beach shelves gently into the lagoon: measure the pool itself)
      const u = -islandShoreDist(x, z);
      if (u <= 70) return;
      const d = islandDepth(x, z, u);
      dMin = Math.min(dMin, d);
      dMax = Math.max(dMax, d);
    });
    let crest = Infinity;
    let reefN = 0;
    for (let x = L.x0 - 90; x <= L.x1 + 90; x += 10)
      for (let z = L.z0; z <= L.z1 + 120; z += 10)
        if (reefAt(x, z) > 0.9) {
          reefN++;
          crest = Math.min(crest, islandDepth(x, z, -islandShoreDist(x, z)));
        }
    const ocean = islandDepth(0, L.z1 + 300, -islandShoreDist(0, L.z1 + 300));
    add('lagoon 1.2–4.8 m, reef crest < 1.1 m, ocean beyond', dMin > 1.2 && dMax < 4.8 && crest < 1.1 && reefN > 50 && ocean > 25, `lagoon ${dMin.toFixed(1)}–${dMax.toFixed(1)} m, reef crest ${crest.toFixed(2)} m (${reefN} pts), ocean ${ocean.toFixed(0)} m, sdf(0,41935) ${lagoonSdf(0, 41935).toFixed(0)}`);
  }
  // ---- onLand agrees with the shore distance ----
  {
    const ok = onLand(0, 600) && !onLand(0, 1400) && onLand(0, 40740) && !onLand(0, 41800) && onLand(0, 41520, 0) && !onLand(0, 41520, 60);
    add('onLand', ok, `home (0,600) ${onLand(0, 600)}, sea (0,1400) ${onLand(0, 1400)}, island centre ${onLand(0, 40740)}, lagoon ${onLand(0, 41800)}`);
  }
  // ---- the swell: calm in the lagoon, livelier offshore, never above the dry land ----
  {
    setSwell(240, 18);
    let lag = 0;
    let off = 0;
    let shore = -Infinity;
    for (let t = 0; t < 60; t += 0.7) {
      lag = Math.max(lag, Math.abs(waveY(100, 41900, t) - SEA_Y));
      off = Math.max(off, Math.abs(waveY(3000, 30000, t) - SEA_Y));
      shore = Math.max(shore, waveY(0, homeCoastZ(0) - 25, t));
    }
    add('swell: lagoon calm, offshore lively', lag < 0.2 && off > 0.4 && off < 1.6 && shore < -0.4, `lagoon ±${lag.toFixed(2)} m, open sea ±${off.toFixed(2)} m, highest at the dry sand ${shore.toFixed(2)} m`);
  }
  // ---- cost: the flight model asks for the ground every substep ----
  {
    const n = 200000;
    let acc = 0;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) acc += groundY(-3000 + (i % 1000) * 6, 600 + Math.floor(i / 1000) * 3);
    const t1 = performance.now();
    for (let i = 0; i < n; i++) acc += groundY(-1500 + (i % 1000) * 3, 39900 + Math.floor(i / 1000) * 8);
    const t2 = performance.now();
    for (let i = 0; i < n; i++) acc += waveY(-1500 + (i % 1000) * 3, 41700 + Math.floor(i / 1000) * 8, i * 0.01);
    const t3 = performance.now();
    const us = (a: number, b: number) => ((b - a) * 1000) / n;
    add('cost per call', us(t0, t1) < 3 && us(t1, t2) < 3 && us(t2, t3) < 3, `groundY home ${us(t0, t1).toFixed(2)} µs, island ${us(t1, t2).toFixed(2)} µs, waveY ${us(t2, t3).toFixed(2)} µs (${acc > 0 ? '' : ''}${Number.isFinite(acc) ? 'ok' : 'NaN'})`);
  }
  return rows;
}
