import { DISTRICTS, ZONES, type ZoneId } from './layout';
import { MAP_PLACES, fairBounds, onMap, paintFair, paintTrain, paintVisitor } from './minimap';
import { PALETTE } from './textures';
import { escapeHtml } from './ui';

type Visitor = { x: number; z: number; heading: number };
type Train = { x: number; z: number; color: string };

/** Pixels per metre at the closest zoom. */
const MAX_PPM = 14;
/** Labels stay hidden below this zoom (except hovered / selected) so they don't pile up. */
const LABEL_PPM = 4.5;
/** Nice round lengths for the scale bar, in metres. */
const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000];

/**
 * The full-screen park map, opened from the minimap or with M, like the pause map in an
 * open-world game: drag to pan, scroll or pinch to zoom, pick a place (on the map or in
 * the legend) and fast travel there.
 */
export class WorldMap {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** The fair itself, repainted only when the view moves; trains and the visitor go on top each frame. */
  private base = document.createElement('canvas');
  private baseKey = '';
  private pins = new Map<ZoneId, HTMLButtonElement>();
  private items = new Map<ZoneId, HTMLButtonElement>();
  private card: HTMLElement;
  private you: HTMLElement;
  private scaleBar: HTMLElement;
  private scaleLabel: HTMLElement;
  private bounds = fairBounds();
  private w = 0;
  private h = 0;
  private dpr = 1;
  private view = { x: 0, z: 0, ppm: 2 };
  private target = { x: 0, z: 0, ppm: 2 };
  private visitor: Visitor = { x: 0, z: 0, heading: 0 };
  private selected: ZoneId | null = null;
  private hovered: ZoneId | null = null;
  private near: ZoneId | null = null;
  /** Attractions closed for maintenance, each with its sign (null for the default wording). */
  private closed = new Map<ZoneId, string | null>();
  private pointers = new Map<number, { x: number; y: number }>();
  private dragDist = 0;
  private pinch: { d: number; ppm: number } | null = null;
  private keys = new Set<string>();
  private returnFocus: HTMLElement | null = null;
  private t = 0; // drives the route line's march
  isOpen = false;
  canOpen: () => boolean = () => true;
  onToggle: ((open: boolean) => void) | null = null;
  onTravel: ((id: ZoneId) => void) | null = null;

  constructor(private root: HTMLElement) {
    this.canvas = root.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    this.card = root.querySelector('.wm-card')!;
    this.you = root.querySelector('.wm-you')!;
    // the visitor's arrow sits above the pins so a nearby attraction never hides it
    const arrow = this.you.querySelector('canvas')!.getContext('2d')!;
    arrow.setTransform(2, 0, 0, 2, 32, 32);
    paintVisitor(arrow, 0, 1.5);
    this.scaleBar = root.querySelector('.wm-scale i')!;
    this.scaleLabel = root.querySelector('.wm-scale span')!;
    this.buildPlaces();
    this.refreshPlaces();

    root.querySelector('.wm-close')!.addEventListener('click', () => this.close());
    root.querySelector('[data-wm-locate]')!.addEventListener('click', () => this.flyTo(this.visitor.x, this.visitor.z));
    root.querySelectorAll<HTMLElement>('[data-wm-zoom]').forEach((b) =>
      b.addEventListener('click', () => this.zoomAt(this.w / 2, this.h / 2, Number(b.dataset.wmZoom) > 0 ? 1.6 : 1 / 1.6)),
    );
    this.card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-wm-travel]') && this.selected) this.travel(this.selected);
    });
    this.setupPointer();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.isOpen && this.resize());
  }

  private buildPlaces() {
    const pinLayer = this.root.querySelector('.wm-pins')!;
    const list = this.root.querySelector('.wm-legend ul')!;
    let district = '';
    for (const p of MAP_PLACES) {
      // a heading for each district, in its colour
      if (p.district !== district) {
        district = p.district;
        const d = DISTRICTS[p.district];
        const head = document.createElement('li');
        head.className = 'wm-group';
        head.style.setProperty('--district', d.color);
        head.innerHTML = `<span aria-hidden="true">${d.icon}</span>${escapeHtml(d.name)}`;
        list.appendChild(head);
      }
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'wm-pin';
      pin.tabIndex = -1; // the legend is the keyboard route; pins are for pointing
      pin.setAttribute('aria-label', p.label);
      pin.innerHTML = `<span class="wm-pin-icon">${p.icon}<span class="wm-pin-badge" aria-hidden="true">🚧</span></span><span class="wm-pin-label">${escapeHtml(p.label)}</span>`;
      pin.addEventListener('pointerdown', (e) => e.stopPropagation());
      pin.addEventListener('click', () => this.pick(p.id, false));
      pin.addEventListener('pointerenter', () => (this.hovered = p.id));
      pin.addEventListener('pointerleave', () => this.hovered === p.id && (this.hovered = null));
      pinLayer.appendChild(pin);
      this.pins.set(p.id, pin);

      const li = document.createElement('li');
      const item = document.createElement('button');
      item.type = 'button';
      item.innerHTML = `<span class="wm-item-icon">${p.icon}</span><span class="wm-item-label">${escapeHtml(p.label)}</span><span class="wm-item-closed">Maintenance</span><span class="wm-item-here">Here</span>`;
      item.addEventListener('click', () => this.pick(p.id, true));
      item.addEventListener('pointerenter', () => (this.hovered = p.id));
      item.addEventListener('pointerleave', () => this.hovered === p.id && (this.hovered = null));
      li.appendChild(item);
      list.appendChild(li);
      this.items.set(p.id, item);
    }
  }

  /**
   * Creators' Valley changed (a coaster opened or closed on a plot): each place's name, the plots
   * on the map and in the legend (only those with a coaster), and the valley painted again.
   */
  refreshPlaces() {
    for (const p of MAP_PLACES) {
      const shown = onMap(p.id);
      const pin = this.pins.get(p.id);
      const item = this.items.get(p.id);
      if (pin) {
        pin.hidden = !shown;
        pin.querySelector('.wm-pin-label')!.textContent = p.label;
        pin.setAttribute('aria-label', this.closed.has(p.id) ? `${p.label}, under maintenance` : p.label);
      }
      if (item) {
        item.parentElement!.hidden = !shown;
        item.querySelector('.wm-item-label')!.textContent = p.label;
      }
    }
    if (this.selected && !onMap(this.selected)) this.select(null, false);
    this.baseKey = '';
    if (this.isOpen) this.renderCard();
  }

  open() {
    if (this.isOpen || !this.canOpen()) return;
    this.isOpen = true;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    this.resize();
    // open centred on the visitor, framing the park, with a short zoom-out flourish
    // (never so far out on a phone that the pins pile up)
    const fit = Math.max(1.8, Math.min(this.w, this.h) / 440);
    this.target = { x: this.visitor.x, z: this.visitor.z, ppm: this.clampPpm(fit) };
    this.view = { ...this.target, ppm: this.clampPpm(fit * 1.6) };
    this.clampCentre(this.target);
    this.select(this.selected, false);
    this.onToggle?.(true);
    (this.root.querySelector('.wm-close') as HTMLElement).focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.keys.clear();
    this.pointers.clear();
    this.pinch = null;
    this.hovered = null;
    this.onToggle?.(false);
    this.returnFocus?.focus?.({ preventScroll: true });
    this.returnFocus = null;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** The zone the visitor is standing in, marked "Here" in the legend. */
  setNear(id: ZoneId | null) {
    if (id === this.near) return;
    this.near = id;
    for (const [k, el] of this.items) el.classList.toggle('is-here', k === id);
    if (this.isOpen) this.renderCard();
  }

  /** Attractions closed for maintenance get a 🚧 on their pin, a tag in the legend, and their sign on the card. */
  setClosed(closed: ReadonlyMap<ZoneId, string | null>) {
    this.closed = new Map(closed);
    for (const p of MAP_PLACES) {
      const shut = this.closed.has(p.id);
      const label = shut ? `${p.label}, under maintenance` : p.label;
      this.pins.get(p.id)?.classList.toggle('is-closed', shut);
      this.pins.get(p.id)?.setAttribute('aria-label', label);
      this.items.get(p.id)?.classList.toggle('is-closed', shut);
    }
    if (this.isOpen) this.renderCard();
  }

  private travel(id: ZoneId) {
    this.close();
    this.onTravel?.(id);
  }

  /** First pick selects a place; picking it again travels there. */
  private pick(id: ZoneId, fly: boolean) {
    if (this.selected === id) this.travel(id);
    else this.select(id, fly);
  }

  private select(id: ZoneId | null, fly: boolean) {
    this.selected = id;
    for (const [k, el] of this.pins) el.classList.toggle('is-selected', k === id);
    for (const [k, el] of this.items) {
      el.classList.toggle('is-selected', k === id);
      el.setAttribute('aria-pressed', String(k === id));
    }
    if (id && fly) this.flyTo(ZONES[id].x, ZONES[id].z, Math.max(this.target.ppm, 3.5));
    this.renderCard();
  }

  private renderCard() {
    const id = this.selected;
    if (!id) {
      this.card.hidden = true;
      return;
    }
    const p = MAP_PLACES.find((m) => m.id === id)!;
    const z = ZONES[id];
    const here = this.near === id;
    const d = Math.hypot(z.x - this.visitor.x, z.z - this.visitor.z);
    const sign = this.closed.get(id);
    const dist = here ? 'You are here' : d < 1000 ? `${Math.round(d / 5) * 5} m away` : `${(d / 1000).toFixed(1)} km away`;
    this.card.innerHTML = `
      <span class="wm-card-icon" aria-hidden="true">${p.icon}</span>
      <div class="wm-card-text">
        <p class="wm-card-dist">${dist}</p>
        <h3>${escapeHtml(p.label)}</h3>
        <p>${escapeHtml(p.blurb)}</p>${
          this.closed.has(id) ? `<p class="wm-card-closed">🚧 Under maintenance${sign ? `: ${escapeHtml(sign)}` : '. Back soon!'}</p>` : ''
        }
      </div>
      <button type="button" class="btn btn-primary wm-travel" data-wm-travel>Fast travel <kbd>Enter</kbd></button>`;
    this.card.hidden = false;
  }

  private flyTo(x: number, z: number, ppm = this.target.ppm) {
    this.target = { x, z, ppm: this.clampPpm(ppm) };
    this.clampCentre(this.target);
  }

  private get minPpm() {
    const b = this.bounds;
    return Math.min(this.w / ((b.x1 - b.x0) * 1.1), this.h / ((b.z1 - b.z0) * 1.1));
  }

  private clampPpm(ppm: number) {
    return Math.min(MAX_PPM, Math.max(this.minPpm, ppm));
  }

  private clampCentre(v: { x: number; z: number }) {
    const b = this.bounds;
    v.x = Math.min(b.x1, Math.max(b.x0, v.x));
    v.z = Math.min(b.z1, Math.max(b.z0, v.z));
  }

  /** Zooms by `factor`, keeping the world point under (mx, my) where it is. */
  private zoomAt(mx: number, my: number, factor: number) {
    const t = this.target;
    const wx = t.x + (mx - this.w / 2) / t.ppm;
    const wz = t.z + (my - this.h / 2) / t.ppm;
    t.ppm = this.clampPpm(t.ppm * factor);
    t.x = wx - (mx - this.w / 2) / t.ppm;
    t.z = wz - (my - this.h / 2) / t.ppm;
    this.clampCentre(t);
  }

  /** Pans by a screen-space offset, immediately (no easing) so drags stick to the finger. */
  private panBy(dx: number, dy: number) {
    for (const v of [this.view, this.target]) {
      v.x -= dx / this.target.ppm;
      v.z -= dy / this.target.ppm;
      this.clampCentre(v);
    }
  }

  private setupPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 1) this.dragDist = 0;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ppm: this.target.ppm };
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const r = c.getBoundingClientRect();
        const factor = (this.pinch.ppm * (Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.d)) / this.target.ppm;
        this.zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, factor);
        this.view.ppm = this.target.ppm;
        this.panBy(dx / 2, dy / 2);
        this.dragDist = Infinity;
        return;
      }
      this.dragDist += Math.hypot(dx, dy);
      this.panBy(dx, dy);
    });
    const end = (e: PointerEvent) => {
      if (!this.pointers.delete(e.pointerId)) return;
      if (this.pointers.size < 2) this.pinch = null;
      // a tap on empty map clears the selection
      if (e.type === 'pointerup' && this.pointers.size === 0 && this.dragDist < 6) this.select(null, false);
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    this.root.addEventListener(
      'wheel',
      (e) => {
        if ((e.target as HTMLElement).closest('.wm-legend')) return; // let the legend scroll
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // not while typing, nor from inside a dialog (the sign-up form)
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest?.('dialog'))) return;
    if (!this.isOpen) {
      if (e.code === 'KeyM' && !e.repeat && !target?.closest?.('.time-panel')) this.open();
      return;
    }
    if (e.code === 'KeyM' || e.code === 'Escape') {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.code === 'Enter' && this.selected && target?.tagName !== 'BUTTON') {
      e.preventDefault();
      this.travel(this.selected);
      return;
    }
    if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'KeyE') this.zoomAt(this.w / 2, this.h / 2, 1.4);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'KeyQ') this.zoomAt(this.w / 2, this.h / 2, 1 / 1.4);
    else if (e.code === 'KeyC' || e.code === 'Space') this.flyTo(this.visitor.x, this.visitor.z);
    else if (e.code === 'Tab') return; // keep normal focus order through the legend
    const pan = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (pan.includes(e.code) || e.code === 'Space') e.preventDefault();
    if (pan.includes(e.code)) this.keys.add(e.code);
  };

  private resize() {
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    for (const c of [this.canvas, this.base]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.baseKey = '';
    this.target.ppm = this.clampPpm(this.target.ppm);
  }

  /** Called every frame with the visitor and the trains; draws only while the map is open. */
  update(dt: number, visitor: Visitor, trains: Train[]) {
    this.visitor = visitor;
    if (!this.isOpen) return;
    this.resize();
    if (!this.w || !this.h) return;
    this.t += dt;

    // keyboard panning, at a constant speed on screen whatever the zoom
    const k = this.keys;
    const kx = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const kz = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('KeyZ') || k.has('ArrowUp') ? 1 : 0);
    if (kx || kz) this.panBy(-kx * 700 * dt, -kz * 700 * dt);

    // ease towards the target view (zoom in log space so it feels even)
    const e = 1 - Math.exp(-dt * 10);
    const v = this.view;
    const t = this.target;
    v.x += (t.x - v.x) * e;
    v.z += (t.z - v.z) * e;
    v.ppm = Math.exp(Math.log(v.ppm) + (Math.log(t.ppm) - Math.log(v.ppm)) * e);

    this.paintBase();
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    // a dashed route to the chosen place, like a waypoint
    if (this.selected && this.selected !== this.near) {
      const a = this.toScreen(visitor.x, visitor.z);
      const b = this.toScreen(ZONES[this.selected].x, ZONES[this.selected].z);
      g.save();
      g.setLineDash([10, 8]);
      g.lineDashOffset = -this.t * 30;
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(29, 18, 56, 0.55)';
      g.lineWidth = 6;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      g.strokeStyle = PALETTE.mustard;
      g.lineWidth = 3;
      g.stroke();
      g.restore();
    }

    for (const tr of trains) {
      const p = this.toScreen(tr.x, tr.z);
      paintTrain(g, p.x, p.y, tr.color, 5);
    }

    const c = this.toScreen(visitor.x, visitor.z);
    this.you.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) rotate(${-visitor.heading}rad)`;

    this.placePins();
    this.updateScale();
  }

  private toScreen(x: number, z: number) {
    const v = this.view;
    return { x: this.w / 2 + (x - v.x) * v.ppm, y: this.h / 2 + (z - v.z) * v.ppm };
  }

  private paintBase() {
    const v = this.view;
    const key = `${v.x.toFixed(2)},${v.z.toFixed(2)},${v.ppm.toFixed(4)},${this.w},${this.h}`;
    if (key === this.baseKey) return;
    this.baseKey = key;
    const g = this.base.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#c9a774';
    g.fillRect(0, 0, this.w, this.h);
    // a faint survey grid every 50 m gives the eye something to track while panning
    const step = v.ppm < 1.2 ? 250 : v.ppm < 3 ? 100 : 50;
    g.strokeStyle = 'rgba(29, 18, 56, 0.08)';
    g.lineWidth = 1;
    g.beginPath();
    const x0 = Math.floor((v.x - this.w / 2 / v.ppm) / step) * step;
    const z0 = Math.floor((v.z - this.h / 2 / v.ppm) / step) * step;
    for (let x = x0; x < v.x + this.w / 2 / v.ppm; x += step) {
      const sx = Math.round(this.toScreen(x, 0).x) + 0.5;
      g.moveTo(sx, 0);
      g.lineTo(sx, this.h);
    }
    for (let z = z0; z < v.z + this.h / 2 / v.ppm; z += step) {
      const sy = Math.round(this.toScreen(0, z).y) + 0.5;
      g.moveTo(0, sy);
      g.lineTo(this.w, sy);
    }
    g.stroke();
    paintFair(g, (x) => this.toScreen(x, 0).x, (z) => this.toScreen(0, z).y, v.ppm);
    // zoomed out (where the places' own labels are hidden), each district's name across its plaza
    if (v.ppm < LABEL_PPM) {
      const size = Math.round(Math.min(22, Math.max(12, v.ppm * 5.5)));
      g.font = `${size}px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      for (const d of Object.values(DISTRICTS)) {
        const p = this.toScreen(d.label[0], d.label[1]);
        const label = d.name.toUpperCase();
        g.lineWidth = Math.max(3, size * 0.32);
        g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
        g.strokeText(label, p.x, p.y);
        g.fillStyle = d.color;
        g.fillText(label, p.x, p.y);
      }
    }
  }

  private placePins() {
    const showLabels = this.view.ppm >= LABEL_PPM;
    for (const [id, pin] of this.pins) {
      const p = this.toScreen(ZONES[id].x, ZONES[id].z);
      pin.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      pin.classList.toggle('show-label', showLabels || id === this.hovered || id === this.selected);
      pin.classList.toggle('is-hovered', id === this.hovered);
    }
  }

  private updateScale() {
    // the longest round length that fits in ~120 px
    const m = SCALE_STEPS.filter((s) => s * this.view.ppm <= 120).pop() ?? SCALE_STEPS[0];
    this.scaleBar.style.width = `${(m * this.view.ppm).toFixed(1)}px`;
    this.scaleLabel.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  }
}
