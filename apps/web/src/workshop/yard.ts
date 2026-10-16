// The Builder's Yard: the flat 70 × 70 m plot where members build their coasters, away from the
// park. It's drawn on a render layer of its own, so only the sky and the far hills keep it company.
// The coaster being built stands on it (rebuilt a moment after each change), with a ribbon along its
// track that shows the piece being edited and anything wrong, and that clicks pick pieces by.
import * as THREE from 'three';
import type { Coaster } from '../world/attractions/coaster';
import { std, type Ctx } from '../world/context';
import { PARK } from '../world/layout';
import { DISPLAY_FONT, hdr, PALETTE } from '../world/textures';
import { CONNECTOR_PIECE, MAX_HEIGHT, MAX_PIECES, PLOT_EDGE, PLOT_SIZE, STATION_AREA, STATION_PIECE, type Design, type Track } from './rules';
import { playerCoaster, type Placement } from './player-coaster';

/** The render layer the yard (and only the yard, the sky and the hills) is drawn on. */
export const YARD_LAYER = 1;
/** Where the yard stands: in the middle of everything, on its own layer. */
export const YARD: Placement = { x: PARK.x, z: PARK.z, yaw: 0 };
/** How long after a change the coaster is built again (the ribbon follows at once). */
const REBUILD_MS = 140;
/** How far the pointer may move and still count as a click (pixels). */
const CLICK_SLOP = 6;

const HALF = PLOT_SIZE / 2;
const RIBBON_HALF = 1.6;
const RIBBON_DROP = 0.5;

/** The pad's surface: a 5 m grid, the edge the track keeps off, the station's ground, and the front. */
function padTexture() {
  const px = 1400;
  const k = px / PLOT_SIZE;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const at = (m: number) => (m + HALF) * k;
  g.fillStyle = '#d8ccb4';
  g.fillRect(0, 0, px, px);
  // a little grit
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(90,70,40,0.06)' : 'rgba(255,255,255,0.08)';
    g.fillRect(Math.random() * px, Math.random() * px, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
  for (let m = -HALF; m <= HALF + 0.01; m += 5) {
    const major = Math.round(m) % 10 === 0;
    g.strokeStyle = major ? 'rgba(60,44,90,0.28)' : 'rgba(60,44,90,0.13)';
    g.lineWidth = major ? 3 : 2;
    g.beginPath();
    g.moveTo(at(m), 0);
    g.lineTo(at(m), px);
    g.moveTo(0, at(m));
    g.lineTo(px, at(m));
    g.stroke();
  }
  // the station's ground (no track low over it)
  const A = STATION_AREA;
  g.fillStyle = 'rgba(46,196,182,0.18)';
  g.fillRect(at(A.x0), at(A.z0), (A.x1 - A.x0) * k, (A.z1 - A.z0) * k);
  // the edge the track keeps off
  g.setLineDash([22, 14]);
  g.strokeStyle = 'rgba(255,77,109,0.75)';
  g.lineWidth = 5;
  const e = HALF - PLOT_EDGE;
  g.strokeRect(at(-e), at(-e), 2 * e * k, 2 * e * k);
  g.setLineDash([]);
  // the front, where guests will come in
  g.fillStyle = 'rgba(29,18,56,0.55)';
  g.font = `${Math.round(k * 1.6)}px ${DISPLAY_FONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('▼  FRONT · GUESTS COME IN HERE  ▼', px / 2, at(HALF - 0.75));
  g.fillText('BACK', px / 2, at(-HALF + 0.75));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Yard {
  readonly group = new THREE.Group();
  /** The coaster as it stands now (null until there's a design). */
  coaster: Coaster | null = null;
  private design: Design | null = null;
  private track: Track | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private ribbon: THREE.Mesh;
  private ribbonMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  private arrow: THREE.Group;
  private limits: THREE.LineSegments;
  private selected: number | null = null;
  private faulty = new Set<number>();
  private raycaster = new THREE.Raycaster();
  // the orbit camera
  private target = new THREE.Vector3();
  private yaw = 0.35;
  private pitch = 0.62;
  private dist = 100;
  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private snapped = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private press: { x: number; y: number; moved: boolean; pan: boolean } | null = null;
  private pinch = 0;
  private snapshotWanted: ((url: string | null) => void) | null = null;
  private on = false;
  /** A click on the track (a piece's index, STATION_PIECE or CONNECTOR_PIECE), or on nothing (null). */
  onPick: ((piece: number | null) => void) | null = null;

  /**
   * The yard has the pointer (it's open, with no ride or dialog over it). The builder's aids (the
   * ribbon, the arrow, the height limit) only show then: not from the train on a test ride.
   */
  get active() {
    return this.on;
  }
  set active(on: boolean) {
    this.on = on;
    this.ribbon.visible = this.limits.visible = this.arrow.visible = on;
    if (on) this.placeArrow();
  }

  constructor(private ctx: Ctx) {
    this.group.position.set(YARD.x, 0, YARD.z);
    this.group.rotation.y = YARD.yaw;
    ctx.scene.add(this.group);

    // the pad, its kerb, and the open ground round it
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(PLOT_SIZE, PLOT_SIZE).rotateX(-Math.PI / 2), std('#ffffff', { map: padTexture(), roughness: 0.95 }));
    pad.position.y = 0.06;
    pad.receiveShadow = true;
    const apron = new THREE.Mesh(new THREE.RingGeometry(HALF * 1.45, 260, 64, 1).rotateX(-Math.PI / 2), std('#3f6e4a', { roughness: 1 }));
    apron.position.y = 0;
    apron.receiveShadow = true;
    const gravel = new THREE.Mesh(new THREE.PlaneGeometry(PLOT_SIZE + 14, PLOT_SIZE + 14).rotateX(-Math.PI / 2), std('#a89a86', { roughness: 1 }));
    gravel.position.y = 0.03;
    gravel.receiveShadow = true;
    this.group.add(pad, apron, gravel);
    const kerb = std('#f3e9d6', { roughness: 0.85 });
    for (const [w, d, x, z] of [
      [PLOT_SIZE + 0.8, 0.4, 0, -HALF - 0.2],
      [PLOT_SIZE + 0.8, 0.4, 0, HALF + 0.2],
      [0.4, PLOT_SIZE, -HALF - 0.2, 0],
      [0.4, PLOT_SIZE, HALF + 0.2, 0],
    ]) {
      const k = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), kerb);
      k.position.set(x, 0.15, z);
      k.receiveShadow = k.castShadow = true;
      this.group.add(k);
    }
    // site lights and a few cones, so it feels like a building site
    const pole = std('#2c2433', { metalness: 0.6, roughness: 0.4 });
    const lamp = new THREE.MeshBasicMaterial({ color: hdr('#ffd59a', 5) });
    for (const [x, z] of [
      [-HALF - 4, -HALF - 4],
      [HALF + 4, -HALF - 4],
      [-HALF - 4, HALF + 4],
      [HALF + 4, HALF + 4],
    ]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.2, 12, 10), pole);
      p.position.set(x, 6, z);
      p.castShadow = true;
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 0.8), lamp);
      head.position.set(x, 12.2, z);
      this.group.add(p, head);
    }
    const cone = new THREE.ConeGeometry(0.3, 0.8, 14);
    const orange = std(PALETTE.orange, { roughness: 0.6 });
    for (let i = 0; i < 10; i++) {
      const c = new THREE.Mesh(cone, orange);
      const a = (i / 10) * Math.PI * 2;
      c.position.set(Math.cos(a) * (HALF + 5), 0.4, Math.sin(a) * (HALF + 5));
      c.castShadow = true;
      this.group.add(c);
    }

    // the height limit: the edges of the box the track has to stay in
    const e = HALF - PLOT_EDGE;
    const box = new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * e, MAX_HEIGHT, 2 * e));
    box.translate(0, MAX_HEIGHT / 2, 0);
    this.limits = new THREE.LineSegments(box, new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false }));
    this.group.add(this.limits);

    // the ribbon along the track (filled in by show)
    this.ribbon = new THREE.Mesh(new THREE.BufferGeometry(), this.ribbonMat);
    this.ribbon.renderOrder = 2;
    this.ribbon.frustumCulled = false;
    this.group.add(this.ribbon);
    // where the next piece goes
    this.arrow = new THREE.Group();
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 18).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: hdr(PALETTE.mustard, 1.6) }));
    tip.position.z = -2.2;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.3, 0.14, 8, 32), new THREE.MeshBasicMaterial({ color: hdr(PALETTE.mustard, 1.6) }));
    this.arrow.add(tip, ring);
    this.group.add(this.arrow);

    this.setLayer(this.group);
    this.raycaster.layers.set(YARD_LAYER);
    this.target.set(0, 7, 4);
    this.listen();
  }

  private setLayer(o: THREE.Object3D) {
    o.traverse((c) => c.layers.set(YARD_LAYER));
  }

  // ------------------------------------------------------------------ the coaster

  /**
   * Shows a design: the ribbon at once, the coaster itself a moment later (or at once with `now`,
   * as when the yard opens). `selected` is the piece being edited; `faulty` the ones with a problem.
   */
  show(design: Design, track: Track, selected: number | null, faulty: Iterable<number>, now = false) {
    const changed = this.track !== track;
    this.design = design;
    this.track = track;
    this.selected = selected;
    this.faulty = new Set(faulty);
    this.paintRibbon(changed);
    this.placeArrow();
    if (!changed && this.coaster) return;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    if (now || !this.coaster) this.rebuild();
    else this.rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_MS);
  }

  /** Just the colours, cars or mode changed: the coaster is built again, the track stays. */
  restyle(design: Design) {
    this.design = design;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_MS);
  }

  /** The coaster is about to be ridden: whatever's pending is built now. */
  flush() {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
      this.rebuild();
    }
    return this.coaster;
  }

  private rebuild() {
    this.rebuildTimer = null;
    if (!this.design || !this.track) return;
    this.coaster?.dispose();
    // (the coaster is laid out in the world's coordinates, so it goes straight into the scene)
    this.coaster = playerCoaster(this.ctx, { id: 'yard', design: this.design, creator: null, at: YARD, track: this.track, layer: YARD_LAYER }).coaster;
  }

  /** Out of the yard for good (another member signed in, say): the coaster comes down. */
  clear() {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.coaster?.dispose();
    this.coaster = null;
    this.design = null;
    this.track = null;
  }

  /** Sets the selection and the faulty pieces without rebuilding anything. */
  highlight(selected: number | null, faulty: Iterable<number>) {
    this.selected = selected;
    this.faulty = new Set(faulty);
    this.paintRibbon(false);
    this.placeArrow();
  }

  /** The strip along the track: faint, the selected piece in gold, faulty ones (and the way home) marked. */
  private paintRibbon(rebuild: boolean) {
    const t = this.track;
    if (!t) return;
    const geo = this.ribbon.geometry;
    if (rebuild || !geo.getAttribute('position') || geo.getAttribute('position').count !== (t.n + 1) * 2) {
      const pos = new Float32Array((t.n + 1) * 6);
      for (let k = 0; k <= t.n; k++) {
        const i = k % t.n;
        for (const [side, o] of [
          [-1, 0],
          [1, 3],
        ] as const) {
          for (let c = 0; c < 3; c++) pos[k * 6 + o + c] = t.pos[i * 3 + c] - t.up[i * 3 + c] * RIBBON_DROP + t.right[i * 3 + c] * RIBBON_HALF * side;
        }
      }
      const idx: number[] = [];
      for (let k = 0; k < t.n; k++) {
        const a = k * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array((t.n + 1) * 8), 4));
      g.setIndex(idx);
      geo.dispose();
      this.ribbon.geometry = g;
    }
    const col = this.ribbon.geometry.getAttribute('color') as THREE.BufferAttribute;
    const gold = new THREE.Color(PALETTE.mustard).multiplyScalar(1.4);
    const red = new THREE.Color('#ff3355').multiplyScalar(1.3);
    const white = new THREE.Color('#ffffff');
    const teal = new THREE.Color(PALETTE.teal);
    for (let k = 0; k <= t.n; k++) {
      const p = t.piece[k % t.n];
      const [c, a] =
        p === this.selected
          ? [gold, 0.78]
          : this.faulty.has(p)
            ? [red, 0.62]
            : p === CONNECTOR_PIECE
              ? [white, (k >> 2) % 2 ? 0.42 : 0.12]
              : p === STATION_PIECE
                ? [teal, 0.25]
                : [white, 0.14];
      for (const v of [k * 2, k * 2 + 1]) col.setXYZW(v, c.r, c.g, c.b, a);
    }
    col.needsUpdate = true;
  }

  /** The gold arrow where a new piece would go: after the selected one, or at the end. */
  private placeArrow() {
    const t = this.track;
    if (!t || !this.design) return;
    let i = -1;
    if (this.selected !== null && this.selected >= 0) i = t.piece.lastIndexOf(this.selected);
    const at = i >= 0 ? new THREE.Vector3(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]) : new THREE.Vector3(...t.end.pos);
    const dir = i >= 0 ? new THREE.Vector3(t.tan[i * 3], t.tan[i * 3 + 1], t.tan[i * 3 + 2]) : new THREE.Vector3(...t.end.tan);
    this.arrow.position.copy(at);
    // the arrow points down its local -z: turn that onto the track's direction
    const up = Math.abs(dir.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    this.arrow.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up));
    this.arrow.visible = this.on && this.design.pieces.length < MAX_PIECES;
  }

  // ------------------------------------------------------------------ the camera

  private listen() {
    const canvas = this.ctx.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      canvas.setPointerCapture(e.pointerId);
      if (this.pointers.size === 1) this.press = { x: e.clientX, y: e.clientY, moved: false, pan: e.button === 2 || e.shiftKey };
      else {
        if (this.press) this.press.moved = true;
        this.pinch = this.pinchSpan();
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!this.active || !p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size >= 2) {
        // two fingers: pinch to zoom, move together to pan
        const span = this.pinchSpan();
        if (this.pinch > 0 && span > 0) this.zoomBy(this.pinch / span);
        this.pinch = span;
        this.panBy(dx / 2, dy / 2);
        return;
      }
      const press = this.press;
      if (!press) return;
      if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_SLOP) return;
      press.moved = true;
      if (press.pan) this.panBy(dx, dy);
      else {
        const k = 4 / Math.max(1, canvas.clientHeight);
        this.yaw -= dx * k;
        this.pitch = THREE.MathUtils.clamp(this.pitch + dy * k, 0.08, 1.45);
      }
    });
    const end = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      const press = this.press;
      if (this.pointers.size === 0) {
        this.press = null;
        if (this.active && press && !press.moved && e.type === 'pointerup') this.pick(e.clientX, e.clientY);
      }
      this.pinch = this.pointers.size >= 2 ? this.pinchSpan() : 0;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('contextmenu', (e) => this.active && e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.active) return;
        this.zoomBy(Math.exp(e.deltaY * 0.0012));
      },
      { passive: true },
    );
  }

  private pinchSpan() {
    const [a, b] = [...this.pointers.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  zoomBy(k: number) {
    this.dist = THREE.MathUtils.clamp(this.dist * k, 18, 170);
  }

  private panBy(dx: number, dy: number) {
    const k = this.dist / Math.max(1, this.ctx.renderer.domElement.clientHeight);
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.target.addScaledVector(right, -dx * k).addScaledVector(fwd, dy * k);
    this.target.x = THREE.MathUtils.clamp(this.target.x, -HALF - 10, HALF + 10);
    this.target.z = THREE.MathUtils.clamp(this.target.z, -HALF - 10, HALF + 10);
  }

  /** Back to the view of the whole plot. */
  resetView() {
    this.target.set(0, 7, 4);
    this.yaw = 0.35;
    this.pitch = 0.62;
    this.dist = 100;
  }

  /** Frames a piece (after picking it from the list). */
  focusPiece(piece: number) {
    const t = this.track;
    if (!t) return;
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < t.n; i++) if (t.piece[i] === piece) box.expandByPoint(p.set(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]));
    if (box.isEmpty()) return;
    box.getCenter(this.target);
    this.dist = THREE.MathUtils.clamp(box.getSize(p).length() * 1.6 + 26, 30, 120);
  }

  /** Where the camera's looking (for the shadows), in the world. */
  get focus() {
    return this.camLook.clone().setY(0);
  }

  updateCamera(camera: THREE.PerspectiveCamera, dt: number) {
    const cp = Math.cos(this.pitch);
    const look = this.target.clone().add(this.group.position);
    const pos = look.clone().add(new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(this.dist));
    pos.y = Math.max(pos.y, 1.5);
    const k = this.snapped ? 1 - Math.exp(-dt * 8) : 1;
    this.snapped = true;
    this.camPos.lerp(pos, k);
    this.camLook.lerp(look, k);
    camera.up.set(0, 1, 0);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
  }

  /** The next updateCamera jumps straight to the view instead of gliding. */
  snap() {
    this.snapped = false;
  }

  private pick(clientX: number, clientY: number) {
    const canvas = this.ctx.renderer.domElement;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.ctx.camera);
    const hit = this.track ? this.raycaster.intersectObject(this.ribbon, false)[0] : undefined;
    const t = this.track;
    if (!hit || !t || hit.faceIndex === undefined || hit.faceIndex === null) return this.onPick?.(null);
    const sample = Math.min(t.n - 1, Math.floor(hit.faceIndex / 2));
    this.onPick?.(t.piece[sample]);
  }

  update(dt: number) {
    this.coaster?.update(dt);
  }

  // ------------------------------------------------------------------ the picture for staff

  /** A picture of the coaster for its submission (taken on the next frame; see takeSnapshot). */
  snapshot(): Promise<string | null> {
    this.flush();
    return new Promise((resolve) => {
      this.snapshotWanted?.(null);
      this.snapshotWanted = resolve;
    });
  }

  /**
   * Takes a picture asked for by snapshot: renders the yard from the front corner with the park's
   * tone mapping straight onto the canvas, and copies a 640 × 400 crop of it before the frame's own
   * render covers it again (so nobody sees it). Called by the game loop just before it renders.
   */
  takeSnapshot(scene: THREE.Scene) {
    const done = this.snapshotWanted;
    if (!done) return;
    this.snapshotWanted = null;
    const r = this.ctx.renderer;
    const canvas = r.domElement;
    const t = this.track;
    try {
      // frame the whole track (or the plot), seen from the front-right and above
      const box = new THREE.Box3();
      const p = new THREE.Vector3();
      if (t) for (let i = 0; i < t.n; i += 4) box.expandByPoint(p.set(t.pos[i * 3], t.pos[i * 3 + 1], t.pos[i * 3 + 2]));
      if (box.isEmpty()) box.set(new THREE.Vector3(-HALF, 0, -HALF), new THREE.Vector3(HALF, 10, HALF));
      const centre = box.getCenter(new THREE.Vector3()).add(this.group.position);
      const radius = Math.max(18, box.getSize(p).length() / 2);
      const cam = new THREE.PerspectiveCamera(38, canvas.width / canvas.height, 0.5, 2400);
      cam.layers.set(YARD_LAYER);
      const dir = new THREE.Vector3(0.55, 0.5, 0.67).normalize();
      // far enough that the radius fits the crop's height (1.6:1 out of the canvas's aspect)
      const cropAspect = 1.6;
      const fitV = cam.aspect >= cropAspect ? 1 : cam.aspect / cropAspect;
      const half = THREE.MathUtils.degToRad(cam.fov / 2);
      const d = radius / Math.sin(Math.atan(Math.tan(half) * fitV)) + 4;
      cam.position.copy(centre).addScaledVector(dir, d);
      cam.lookAt(centre);
      cam.updateMatrixWorld();
      const ribbon = this.ribbon.visible;
      const arrow = this.arrow.visible;
      const limits = this.limits.visible;
      this.ribbon.visible = this.arrow.visible = this.limits.visible = false;
      // (the post pipeline renders with autoClear off and does its own tone mapping)
      const tone = r.toneMapping;
      const autoClear = r.autoClear;
      r.toneMapping = THREE.ACESFilmicToneMapping;
      r.autoClear = true;
      r.setRenderTarget(null);
      r.render(scene, cam);
      r.toneMapping = tone;
      r.autoClear = autoClear;
      this.ribbon.visible = ribbon;
      this.arrow.visible = arrow;
      this.limits.visible = limits;
      // the middle 1.6:1 of the canvas, down to 640 × 400
      let sw = canvas.width;
      let sh = Math.round(sw / cropAspect);
      if (sh > canvas.height) {
        sh = canvas.height;
        sw = Math.round(sh * cropAspect);
      }
      const out = document.createElement('canvas');
      out.width = 640;
      out.height = 400;
      out.getContext('2d')!.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, 640, 400);
      let url = out.toDataURL('image/webp', 0.82);
      // browsers without WebP fall back to PNG: JPEG keeps it small
      if (!url.startsWith('data:image/webp')) url = out.toDataURL('image/jpeg', 0.84);
      for (let q = 0.7; url.length > 150_000 && q > 0.3; q -= 0.15) url = out.toDataURL(url.startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg', q);
      done(url.length <= 150_000 ? url : null);
    } catch {
      done(null);
    }
  }

}
