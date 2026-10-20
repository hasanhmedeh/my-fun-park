// The integrated standby instrument (ISIS) on the centre panel: its own small attitude, speed and
// altitude, the pilots' cross-check when the main displays disagree. Drawn plainer than the PFD,
// as the real one is.

import { C, Display, line, pad, poly, text } from './display';
import type { CockpitData } from './types';

const D2R = Math.PI / 180;
const CX = 500;
const CY = 480;
const PPD = 16;

export class Standby {
  readonly display: Display;

  constructor(className: string, hz = 15) {
    this.display = new Display(className, hz);
  }

  update(dt: number, d: CockpitData) {
    if (!this.display.due(dt) || !this.display.begin()) return;
    const g = this.display.g;
    const s = d.s;
    // attitude across the whole face
    g.save();
    g.beginPath();
    g.rect(170, 70, 660, 820);
    g.clip();
    g.translate(CX, CY);
    g.rotate(-s.bank * D2R);
    g.translate(0, s.pitch * PPD);
    g.fillStyle = C.sky;
    g.fillRect(-900, -2000, 1800, 2000);
    g.fillStyle = C.ground;
    g.fillRect(-900, 0, 1800, 2000);
    line(g, -900, 0, 900, 0, C.white, 6);
    for (let p = Math.ceil((s.pitch - 20) / 5) * 5; p <= s.pitch + 20; p += 5) {
      if (p === 0) continue;
      const w = p % 10 === 0 ? 110 : 55;
      line(g, -w, -p * PPD, w, -p * PPD, C.white, 6);
      if (p % 10 === 0) text(g, String(Math.abs(p)), w + 40, -p * PPD, C.white, 48);
    }
    g.restore();
    // the bank pointer and the aircraft symbol
    poly(g, [CX, 110, CX - 24, 150, CX + 24, 150], C.yellow);
    poly(g, [CX - 230, CY - 12, CX - 90, CY - 12, CX - 90, CY + 40, CX - 112, CY + 40, CX - 112, CY + 12, CX - 230, CY + 12], C.black, C.yellow, 6);
    poly(g, [CX + 230, CY - 12, CX + 90, CY - 12, CX + 90, CY + 40, CX + 112, CY + 40, CX + 112, CY + 12, CX + 230, CY + 12], C.black, C.yellow, 6);
    g.fillStyle = C.yellow;
    g.fillRect(CX - 14, CY - 14, 28, 28);
    // speed and altitude as plain readouts at the sides
    g.fillStyle = C.black;
    g.fillRect(0, 0, 170, 1000);
    g.fillRect(830, 0, 170, 1000);
    g.fillRect(0, 890, 1000, 110);
    g.fillRect(0, 0, 1000, 70);
    poly(g, [8, CY - 50, 160, CY - 50, 160, CY + 50, 8, CY + 50], C.black, C.yellow, 5);
    text(g, s.ias < 30 ? '---' : pad(s.ias, 3), 84, CY, C.white, 70);
    poly(g, [840, CY - 50, 994, CY - 50, 994, CY + 50, 840, CY + 50], C.black, C.yellow, 5);
    text(g, String(Math.round(s.altFt / 20) * 20), 917, CY, C.white, s.altFt >= 10000 ? 52 : 62);
    text(g, 'KT', 84, CY + 100, C.cyan, 42);
    text(g, 'FT', 917, CY + 100, C.cyan, 42);
    text(g, `${Math.round(d.weather.qnh)}`, CX, 945, C.cyan, 56);
    text(g, 'ISIS', CX, 36, C.grey, 40);
  }

  dispose() {
    this.display.dispose();
  }
}
