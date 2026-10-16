// Creators' Valley out on the ground: the arch over the Valley Road, its lamps, the Coaster
// Workshop's kiosk, the eight plots, and the coasters members built running on them. Released
// coasters come and go live: the park's state (session.creations) says which runs on which plot,
// and each one's design is fetched and built as it arrives.
import * as THREE from 'three';
import { api, plotId, PLOT_IDS, type CreationDetail, type ParkCreation, type PlotId } from '../account/api';
import type { Coaster } from '../world/attractions/coaster';
import { shadowed, staticBox, staticCylinder, std, type Attraction, type Ctx } from '../world/context';
import { PARK, plotPlace, plotPoint, VALLEY } from '../world/layout';
import { hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../world/textures';
import { playerCoaster } from './player-coaster';

/** A coaster running on a plot: the creation, the coaster, and its track from above (for the maps). */
export interface PlotCoaster {
  plot: PlotId;
  creation: ParkCreation;
  detail: CreationDetail;
  coaster: Coaster;
  track: [number, number][];
}

/** Creators' Valley's colour (its district's, on the maps). */
const ROSE = '#e05aa8';
/** Where the arch stands on the Valley Road, just outside the west gate. */
const ARCH_X = -Math.sqrt((PARK.r + 14) ** 2 - (VALLEY.road.z - PARK.z) ** 2);

export class Valley implements Attraction {
  private running = new Map<PlotId, PlotCoaster>();
  /** What each plot should run (the park's latest word), and the fetch in flight for it. */
  private wanted = new Map<PlotId, string>();
  private loading = new Map<PlotId, string>();
  /** "Your coaster here?" on each empty plot. */
  private emptySigns = new Map<PlotId, THREE.Group>();
  /** A coaster taken out while someone rides it: it stays until they're off (see release). */
  private retiring = new Set<Coaster>();
  /** The coaster the visitor is riding, if it's one of these. */
  busy: Coaster | null = null;
  /** A plot's coaster opened or closed (the zones, the maps and the lists follow). */
  onChange: ((plot: PlotId) => void) | null = null;

  constructor(private ctx: Ctx) {
    this.buildArch();
    this.buildLamps();
    this.buildKiosk();
    for (let n = 1; n <= PLOT_IDS.length; n++) this.buildPlot(n);
  }

  /** The coaster on a plot, when one runs there. */
  on(plot: PlotId) {
    return this.running.get(plot) ?? null;
  }

  /** Every coaster running in the valley. */
  get coasters() {
    return [...this.running.values()];
  }

  /** The plot a coaster runs on (null once it's been taken out). */
  plotOf(coaster: Coaster): PlotId | null {
    for (const [plot, r] of this.running) if (r.coaster === coaster) return plot;
    return null;
  }

  /** The park's latest word on what runs where: coasters released, replaced or taken out. */
  sync(creations: readonly ParkCreation[]) {
    for (const plot of PLOT_IDS) {
      const c = creations.find((x) => plotId(x.plot) === plot) ?? null;
      const now = this.running.get(plot);
      if (c) this.wanted.set(plot, c.id);
      else this.wanted.delete(plot);
      if (now && now.creation.id !== c?.id) this.takeDown(plot);
      if (c && now?.creation.id !== c.id && this.loading.get(plot) !== c.id) void this.load(plot, c);
    }
  }

  private async load(plot: PlotId, c: ParkCreation) {
    this.loading.set(plot, c.id);
    let detail: CreationDetail | null = null;
    for (let attempt = 0; attempt < 3 && !detail; attempt++) {
      try {
        detail = await api.creation(c.id);
      } catch {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
      if (this.wanted.get(plot) !== c.id) break;
    }
    if (this.loading.get(plot) === c.id) this.loading.delete(plot);
    // gone (or replaced) while it was on its way
    if (!detail || this.wanted.get(plot) !== c.id || this.running.get(plot)?.creation.id === c.id) return;
    if (this.running.has(plot)) this.takeDown(plot);
    const at = plotPlace(PLOT_IDS.indexOf(plot) + 1);
    const { coaster, data } = playerCoaster(this.ctx, { id: `creation-${c.id}`, design: detail.data, creator: c.creator, at });
    const track: [number, number][] = [];
    for (let i = 0; i < data.pos.length; i += 4) track.push([data.pos[i].x, data.pos[i].z]);
    this.running.set(plot, { plot, creation: c, detail, coaster, track });
    this.emptySigns.get(plot)!.visible = false;
    this.onChange?.(plot);
  }

  private takeDown(plot: PlotId) {
    const r = this.running.get(plot);
    if (!r) return;
    this.running.delete(plot);
    if (r.coaster === this.busy) this.retiring.add(r.coaster);
    else r.coaster.dispose();
    this.emptySigns.get(plot)!.visible = true;
    this.onChange?.(plot);
  }

  /** The visitor got off: a coaster taken out under them can go now. */
  release() {
    const c = this.busy;
    this.busy = null;
    if (c && this.retiring.delete(c)) c.dispose();
  }

  update(dt: number) {
    for (const r of this.running.values()) r.coaster.update(dt);
    for (const c of this.retiring) c.update(dt);
  }

  // ------------------------------------------------------------------ the scenery

  /** The arch over the Valley Road, just outside the west gate. */
  private buildArch() {
    const x = ARCH_X;
    const g = new THREE.Group();
    const iron = std('#2c2433', { metalness: 0.7, roughness: 0.4 });
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 7.4, 12), std(ROSE, { roughness: 0.5 }));
      post.position.set(0, 3.7, side * 5.4);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), std(PALETTE.mustard, { metalness: 0.8, roughness: 0.25 }));
      cap.position.set(0, 7.55, side * 5.4);
      g.add(post, cap);
      staticCylinder(this.ctx, x, VALLEY.road.z + side * 5.4, 0.35, 4);
    }
    const tex = signTexture("CREATORS' VALLEY", { sub: '🛠️ Coaster Workshop · coasters built by members', border: ROSE, width: 1280, height: 384 });
    const mat = signMaterial(tex);
    for (const side of [0, Math.PI]) {
      const board = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 2.88), mat);
      board.position.set(side ? -0.08 : 0.08, 6.2, 0);
      board.rotation.y = side + Math.PI / 2;
      g.add(board);
    }
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.12, 3, 9.8), iron);
    back.position.y = 6.2;
    g.add(back);
    g.position.set(x, 0, VALLEY.road.z);
    shadowed(g);
    this.ctx.scene.add(g);
  }

  /** Lamp posts down both sides of the Valley Road. */
  private buildLamps() {
    // one side then the other every 13 m, so each side has one every 26 m; none in front of the kiosk
    const spots: [number, number][] = [];
    let side = -1;
    for (let x = ARCH_X - 9; x > VALLEY.walk.x1 + 4; x -= 13, side = -side) {
      if (side < 0 && Math.abs(x - VALLEY.kiosk.x) < 6) continue;
      spots.push([x, VALLEY.road.z + side * 6.3]);
    }
    const iron = std('#2c2433', { metalness: 0.75, roughness: 0.35 });
    const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 4.2, 10).translate(0, 2.1, 0), iron, spots.length);
    const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.3, 16, 12), new THREE.MeshBasicMaterial({ color: hdr('#ffd59a', 6) }), spots.length);
    const m = new THREE.Matrix4();
    spots.forEach(([x, z], i) => {
      poles.setMatrixAt(i, m.makeTranslation(x, 0, z));
      lamps.setMatrixAt(i, m.makeTranslation(x, 4.38, z));
      staticCylinder(this.ctx, x, z, 0.2, 4);
    });
    poles.castShadow = true;
    this.ctx.scene.add(poles, lamps);
  }

  /** The Coaster Workshop: a striped hut with a counter facing the road, and a sign on its roof. */
  private buildKiosk() {
    const { x, z } = VALLEY.kiosk;
    const g = new THREE.Group();
    const wood = std('#b98a5a', { roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3, 3.6), std('#ffffff', { map: stripeTexture(ROSE, PALETTE.cream, 10), roughness: 0.8 }));
    body.position.y = 1.5;
    const counter = new THREE.Mesh(new THREE.BoxGeometry(5.4, 1.1, 0.7), wood);
    counter.position.set(0, 0.55, 2.1);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.14, 1.6), std(PALETTE.mustard, { roughness: 0.6 }));
    awning.position.set(0, 3.1, 2.3);
    awning.rotation.x = 0.18;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.3, 4), std(PALETTE.ink, { roughness: 0.7 }));
    roof.position.y = 3.15;
    // a little coaster hill on the roof, for show
    const hill = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.08, 6, 24, Math.PI), std(PALETTE.candy, { metalness: 0.5, roughness: 0.35 }));
    hill.position.set(-1.1, 3.3, 0);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.8, 1.44), signMaterial(signTexture('COASTER WORKSHOP', { sub: 'Build your own coaster 🛠️', border: ROSE })));
    sign.position.set(0, 4.3, 0.2);
    const signBack = new THREE.Mesh(new THREE.BoxGeometry(4.9, 1.5, 0.12), std(ROSE, { roughness: 0.6 }));
    signBack.position.set(0, 4.3, 0.12);
    // tools hanging behind the counter
    for (const [tx, h] of [[-1.6, 0.7], [-1.1, 0.55], [1.3, 0.8]] as const) {
      const tool = new THREE.Mesh(new THREE.BoxGeometry(0.1, h, 0.06), std('#8d8a99', { metalness: 0.8, roughness: 0.3 }));
      tool.position.set(tx, 2.1, 1.82);
      g.add(tool);
    }
    g.add(body, counter, awning, roof, hill, sign, signBack);
    g.position.set(x, 0, z);
    shadowed(g, true);
    this.ctx.scene.add(g);
    staticBox(this.ctx, x, 1.5, z + 0.35, 2.7, 1.5, 2.15);
  }

  /** A plot: a low kerb round its edge, its number, and the "Your coaster here?" sign while it's empty. */
  private buildPlot(n: number) {
    const at = plotPlace(n);
    const half = VALLEY.size / 2;
    const g = new THREE.Group();
    const kerb = std('#d9cbb2', { roughness: 0.9 });
    for (const [w, d, lx, lz] of [
      [VALLEY.size, 0.35, 0, -half],
      [VALLEY.size, 0.35, 0, half],
      [0.35, VALLEY.size, -half, 0],
      [0.35, VALLEY.size, half, 0],
    ]) {
      const k = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), kerb);
      k.position.set(lx, 0.11, lz);
      k.receiveShadow = true;
      g.add(k);
    }
    // the plot's number on a post at its front corner
    const post = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.84), signMaterial(signTexture(`PLOT ${n}`, { width: 512, height: 288, border: ROSE, bulbs: false })));
    post.position.set(half - 3, 1.35, half - 0.32);
    const postBack = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.9, 0.08), std(ROSE, { roughness: 0.6 }));
    postBack.position.set(half - 3, 1.35, half - 0.4);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1), std('#2c2433'));
    leg.position.set(half - 3, 0.5, half - 0.45);
    g.add(post, postBack, leg);
    g.position.set(at.x, 0, at.z);
    g.rotation.y = at.yaw;
    this.ctx.scene.add(g);

    // "Your coaster here?" while nothing runs on it
    const empty = new THREE.Group();
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(7.2, 2.7),
      signMaterial(signTexture('YOUR COASTER HERE?', { sub: 'Build one at the Coaster Workshop 🛠️', border: ROSE, width: 1024, height: 384 })),
    );
    board.position.y = 3.6;
    const back = new THREE.Mesh(new THREE.BoxGeometry(7.4, 2.9, 0.14), std(ROSE, { roughness: 0.6 }));
    back.position.set(0, 3.6, -0.09);
    for (const side of [-1, 1]) {
      const leg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 3.6), std('#2c2433', { metalness: 0.6, roughness: 0.4 }));
      leg2.position.set(side * 3.1, 1.8, -0.15);
      empty.add(leg2);
    }
    empty.add(board, back);
    const p = plotPoint(n, 0, half - 6);
    empty.position.set(p.x, 0, p.z);
    empty.rotation.y = at.yaw;
    shadowed(empty);
    this.ctx.scene.add(empty);
    this.emptySigns.set(plotId(n), empty);
  }
}
