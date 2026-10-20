import { FIXES } from '../aviation/airports';
import { ISLAND, regionAt, type Region } from './geo';
import { canTravel, DISTRICTS, REGION_INFO, ZONE_REGION, ZONES, type ZoneId } from './layout';
import { AIRPORT_MARKS, paintFix, paintTrain, paintVisitor, paintWorld, regionBounds, type MapView } from './map-paint';
import { drawTiles } from './map-tiles';
import { MAP_PLACES, onMap } from './minimap';
import { PALETTE } from './textures';
import { escapeHtml } from './ui';
import './world-map.css';

type Visitor = { x: number; z: number; heading: number };
type Train = { x: number; z: number; color: string };

/** Pixels per metre at the closest zoom. */
const MAX_PPM = 14;
/** Labels stay hidden below this zoom (except hovered / selected) so they don't pile up. */
const LABEL_PPM = 4.5;
/** Below this zoom the districts' names give way to the regions' (and the pins to the airports'). */
const REGION_PPM = 0.25;
/** Below this zoom (in device pixels per metre) the map is drawn from the shared tiles rather than painted live. */
const TILE_PPM = 3.4;
/** Nice round lengths for the scale bar, in metres. */
const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** The map's tabs: each landmass, and the world with the sea between. */
const VIEWS: { id: MapView; label: string; kicker: string; title: string }[] = [
  { id: 'home', label: '🎪 The Funfair', kicker: 'Park map', title: REGION_INFO.home.name },
  { id: 'island', label: '🌴 Palm Cay', kicker: 'Island map', title: REGION_INFO.island.name },
  { id: 'world', label: '🌍 World', kicker: 'World map', title: 'The Funfair & Palm Cay' },
];

/**
 * Where the World view writes each landmass's name: off its outer edge (north of the fair, south of
 * Palm Cay) and a few pixels further out, so it never sits on the airports' pins and codes, which
 * face the sea between them.
 */
const REGION_LABELS: Record<Region, { x: number; z: number; dy: number; name: string }> = {
  home: { x: 0, z: -900, dy: -14, name: REGION_INFO.home.name },
  island: { x: 0, z: ISLAND.centre.z + ISLAND.rz, dy: 30, name: REGION_INFO.island.name },
};

/** The route the flights fly between the airports (FA101 south; FA102 comes back the same way), for the World view. */
const ROUTE = ['TOFFY', 'CORAL', 'PALMS'].map((n) => FIXES[n]);

/**
 * The full-screen map, opened from the minimap or with M, like the pause map in an open-world
 * game: drag to pan, scroll or pinch to zoom, pick a place (on the map or in the legend) and fast
 * travel there. One tab per landmass (the fair and its airport; Palm Cay) and a World tab with
 * the sea between; fast travel stays on the landmass the visitor stands on, and a place across
 * the sea offers the way there instead: the flight from this side's airport.
 */
export class WorldMap {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  /** The world under the pins, repainted only when the view moves; trains and the visitor go on top each frame. */
  private base = document.createElement('canvas');
  private baseKey = '';
  private pins = new Map<ZoneId, HTMLButtonElement>();
  private items = new Map<ZoneId, HTMLButtonElement>();
  /** The legend's headings: each region's, and each district's (shown with their region's places). */
  private headings: { el: HTMLElement; region: Region }[] = [];
  private tabs = new Map<MapView, HTMLButtonElement>();
  private card: HTMLElement;
  private you: HTMLElement;
  private scaleBar: HTMLElement;
  private scaleLabel: HTMLElement;
  private kicker: HTMLElement;
  private title: HTMLElement;
  /** Which tab is showing, and the box it frames. */
  private region: MapView = 'home';
  private bounds = regionBounds('home');
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
  /** Fast travel to a place (always one on the visitor's own landmass: see canTravel). */
  onTravel: ((id: ZoneId) => void) | null = null;

  constructor(private root: HTMLElement) {
    this.canvas = root.querySelector('canvas')!;
    this.g = this.canvas.getContext('2d')!;
    this.card = root.querySelector('.wm-card')!;
    this.you = root.querySelector('.wm-you')!;
    this.kicker = root.querySelector('.wm-kicker')!;
    this.title = root.querySelector('.wm-head h2')!;
    // the visitor's arrow sits above the pins so a nearby attraction never hides it
    const arrow = this.you.querySelector('canvas')!.getContext('2d')!;
    arrow.setTransform(2, 0, 0, 2, 32, 32);
    paintVisitor(arrow, 0, 1.5);
    this.scaleBar = root.querySelector('.wm-scale i')!;
    this.scaleLabel = root.querySelector('.wm-scale span')!;
    this.buildTabs();
    this.buildPlaces();
    this.refreshPlaces();

    root.querySelector('.wm-close')!.addEventListener('click', () => this.close());
    root.querySelector('[data-wm-locate]')!.addEventListener('click', () => this.locate());
    root.querySelectorAll<HTMLElement>('[data-wm-zoom]').forEach((b) =>
      b.addEventListener('click', () => this.zoomAt(this.w / 2, this.h / 2, Number(b.dataset.wmZoom) > 0 ? 1.6 : 1 / 1.6)),
    );
    this.card.addEventListener('click', (e) => {
      const go = (e.target as HTMLElement).closest<HTMLElement>('[data-wm-travel]');
      if (go && this.selected) this.travel(this.selected);
    });
    this.setupPointer();
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('resize', () => this.isOpen && this.resize());
  }

  /** The landmass the visitor stands on. */
  private get here(): Region {
    return regionAt(this.visitor.x, this.visitor.z);
  }

  private buildTabs() {
    const nav = document.createElement('nav');
    nav.className = 'wm-tabs';
    nav.setAttribute('aria-label', 'Map regions');
    for (const v of VIEWS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wm-tab';
      b.textContent = v.label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.setRegion(v.id, true));
      nav.appendChild(b);
      this.tabs.set(v.id, b);
    }
    this.root.querySelector('.wm-head')!.appendChild(nav);
    this.root.classList.add('has-tabs');
  }

  private buildPlaces() {
    const pinLayer = this.root.querySelector('.wm-pins')!;
    const list = this.root.querySelector('.wm-legend ul')!;
    let district = '';
    let region: Region | '' = '';
    for (const p of MAP_PLACES) {
      const d = DISTRICTS[p.district];
      // a heading for each region (shown in the World view, where both are listed)…
      if (d.region !== region) {
        region = d.region;
        const head = document.createElement('li');
        head.className = 'wm-region';
        head.textContent = REGION_INFO[region].name;
        list.appendChild(head);
        this.headings.push({ el: head, region });
      }
      // …and one for each district, in its colour
      if (p.district !== district) {
        district = p.district;
        const head = document.createElement('li');
        head.className = 'wm-group';
        head.style.setProperty('--district', d.color);
        head.innerHTML = `<span aria-hidden="true">${d.icon}</span>${escapeHtml(d.name)}`;
        list.appendChild(head);
        this.headings.push({ el: head, region: d.region });
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
      item.innerHTML = `<span class="wm-item-icon">${p.icon}</span><span class="wm-item-label">${escapeHtml(p.label)}</span><span class="wm-item-closed">Maintenance</span><span class="wm-item-here">Here</span><span class="wm-item-away">✈️ Fly</span>`;
      item.addEventListener('click', () => this.pick(p.id, true));
      item.addEventListener('pointerenter', () => (this.hovered = p.id));
      item.addEventListener('pointerleave', () => this.hovered === p.id && (this.hovered = null));
      li.appendChild(item);
      list.appendChild(li);
      this.items.set(p.id, item);
    }
  }

  /**
   * Creators' Valley changed (a coaster opened or closed on a plot), or the tab or the visitor's
   * landmass did: each place's name, which places the map and the legend show (the tab's region;
   * plots only with a coaster), which are across the sea, and the map painted again.
   */
  refreshPlaces() {
    const here = this.here;
    for (const p of MAP_PLACES) {
      const inTab = this.region === 'world' || ZONE_REGION[p.id] === this.region;
      const shown = onMap(p.id);
      const away = !canTravel(here, p.id);
      const pin = this.pins.get(p.id);
      const item = this.items.get(p.id);
      if (pin) {
        pin.hidden = !shown;
        pin.classList.toggle('is-away', away);
        pin.querySelector('.wm-pin-label')!.textContent = p.label;
        pin.setAttribute('aria-label', this.closed.has(p.id) ? `${p.label}, under maintenance` : away ? `${p.label}, across the sea` : p.label);
      }
      if (item) {
        item.parentElement!.hidden = !shown || !inTab;
        item.classList.toggle('is-away', away);
        item.querySelector('.wm-item-label')!.textContent = p.label;
      }
    }
    // the districts' headings with their region's places; the regions' own only where both are listed
    for (const h of this.headings) h.el.hidden = h.el.classList.contains('wm-region') ? this.region !== 'world' : this.region !== 'world' && h.region !== this.region;
    if (this.selected && !onMap(this.selected)) this.select(null, false);
    this.baseKey = '';
    if (this.isOpen) this.renderCard();
  }

  /**
   * Shows a tab: one landmass (its places in the legend, the view framed on it) or the World.
   * `fly` eases the view over to it; otherwise it only frames the bounds (open() places the view).
   */
  setRegion(r: MapView, fly = false) {
    this.region = r;
    this.bounds = regionBounds(r);
    const v = VIEWS.find((k) => k.id === r)!;
    this.kicker.textContent = v.kicker;
    this.title.textContent = v.title;
    for (const [id, b] of this.tabs) {
      b.classList.toggle('is-active', id === r);
      b.setAttribute('aria-pressed', String(id === r));
    }
    this.refreshPlaces();
    if (fly) {
      if (r === this.here) this.flyTo(this.visitor.x, this.visitor.z, this.fitPpm());
      else {
        // frame the whole tab
        const b = this.bounds;
        this.flyTo((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2, 0);
      }
    }
    if (this.selected && r !== 'world' && ZONE_REGION[this.selected] !== r) this.select(null, false);
  }

  /** The zoom the map opens at: framing the park round the visitor (never so far out on a phone that the pins pile up). */
  private fitPpm() {
    return Math.max(1.8, Math.min(this.w, this.h) / 440);
  }

  open() {
    if (this.isOpen || !this.canOpen()) return;
    this.isOpen = true;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.root.hidden = false;
    this.resize();
    // open on the visitor's own landmass, centred on them, with a short zoom-out flourish
    this.setRegion(this.here);
    const fit = this.fitPpm();
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

  /** Back to the visitor: their own landmass's tab, centred on them. */
  private locate() {
    if (this.region !== this.here && this.region !== 'world') this.setRegion(this.here);
    this.flyTo(this.visitor.x, this.visitor.z, Math.max(this.target.ppm, this.region === 'world' ? this.fitPpm() : 0));
  }

  /**
   * Fast travel to a place: only ever on the visitor's own landmass. A place across the sea
   * takes them to this side's departure gate instead (the flight is the way over).
   */
  private travel(id: ZoneId) {
    const to = canTravel(this.here, id) ? id : REGION_INFO[this.here].departure;
    this.close();
    this.onTravel?.(to);
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
    const from = this.here;
    const reachable = canTravel(from, id);
    const d = Math.hypot(z.x - this.visitor.x, z.z - this.visitor.z);
    const sign = this.closed.get(id);
    const dist = here ? 'You are here' : d < 1000 ? `${Math.round(d / 5) * 5} m away` : `${(d / 1000).toFixed(d < 10000 ? 1 : 0)} km away`;
    let action = `<button type="button" class="btn btn-primary wm-travel" data-wm-travel>Fast travel <kbd>Enter</kbd></button>`;
    let away = '';
    if (!reachable) {
      // across the sea: say where it is and offer this side's gate (the flight is the way there)
      const there = ZONE_REGION[id];
      const gate = ZONES[REGION_INFO[from].departure];
      const where = there === 'island' ? `On ${REGION_INFO.island.name}, ${Math.round(d / 1000)} km south` : `At the fair, ${Math.round(d / 1000)} km north`;
      const fly = from === 'home' ? 'fly from Gate 3' : `fly from ${REGION_INFO.island.name}’s gate 2`;
      away = `<p class="wm-card-away">✈️ ${where} · ${fly}</p>`;
      action = `<button type="button" class="btn btn-primary wm-travel" data-wm-travel>Go to ${escapeHtml(gate.title)} <kbd>Enter</kbd></button>`;
    }
    this.card.innerHTML = `
      <span class="wm-card-icon" aria-hidden="true">${p.icon}</span>
      <div class="wm-card-text">
        <p class="wm-card-dist">${dist}</p>
        <h3>${escapeHtml(p.label)}</h3>
        <p>${escapeHtml(p.blurb)}</p>${away}${
          this.closed.has(id) ? `<p class="wm-card-closed">🚧 Under maintenance${sign ? `: ${escapeHtml(sign)}` : '. Back soon!'}</p>` : ''
        }
      </div>
      ${action}`;
    this.card.classList.toggle('is-away', !reachable);
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
    // 1 / 2 / 3: the tabs
    const tab = ['Digit1', 'Digit2', 'Digit3'].indexOf(e.code);
    if (tab >= 0) {
      this.setRegion(VIEWS[tab].id, true);
      return;
    }
    if (e.code === 'Equal' || e.code === 'NumpadAdd' || e.code === 'KeyE') this.zoomAt(this.w / 2, this.h / 2, 1.4);
    else if (e.code === 'Minus' || e.code === 'NumpadSubtract' || e.code === 'KeyQ') this.zoomAt(this.w / 2, this.h / 2, 1 / 1.4);
    else if (e.code === 'KeyC' || e.code === 'Space') this.locate();
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
    const crossed = regionAt(visitor.x, visitor.z) !== this.here;
    this.visitor = visitor;
    if (crossed) this.refreshPlaces();
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

    // a dashed route to the chosen place, like a waypoint (only on the visitor's own landmass)
    if (this.selected && this.selected !== this.near && canTravel(this.here, this.selected)) {
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

    if (v.ppm > REGION_PPM)
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
    const g = this.base.getContext('2d')!;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // zoomed out, the shared tiles (cheap to pan over 40 km); close in, painted live and crisp
    if (v.ppm * this.dpr < TILE_PPM) {
      g.fillStyle = '#2b83b5';
      g.fillRect(0, 0, this.w, this.h);
      g.imageSmoothingEnabled = true;
      // until every tile's painted, keep drawing (the key stays stale)
      if (drawTiles(g, v.x, v.z, v.ppm, this.w, this.h, this.dpr)) this.baseKey = key;
    } else {
      this.baseKey = key;
      const x0 = v.x - this.w / 2 / v.ppm;
      const z0 = v.z - this.h / 2 / v.ppm;
      paintWorld(g, (x) => this.toScreen(x, 0).x, (z) => this.toScreen(0, z).y, v.ppm, { x0, z0, x1: x0 + this.w / v.ppm, z1: z0 + this.h / v.ppm }, 40);
    }
    this.paintGrid(g);
    if (v.ppm < REGION_PPM) this.paintWorldLabels(g);
    else if (v.ppm < LABEL_PPM) this.paintDistrictLabels(g);
  }

  /** A faint survey grid gives the eye something to track while panning: every 50 m close in, up to 10 km far out. */
  private paintGrid(g: CanvasRenderingContext2D) {
    const v = this.view;
    const step = v.ppm < 0.012 ? 10000 : v.ppm < 0.05 ? 5000 : v.ppm < 0.3 ? 1000 : v.ppm < 1.2 ? 250 : v.ppm < 3 ? 100 : 50;
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
  }

  /** Zoomed out (where the places' own labels are hidden), each district's name across its plaza. */
  private paintDistrictLabels(g: CanvasRenderingContext2D) {
    const v = this.view;
    const size = Math.round(Math.min(22, Math.max(12, v.ppm * 5.5)));
    g.font = `${size}px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const d of Object.values(DISTRICTS)) {
      const p = this.toScreen(d.label[0], d.label[1]);
      if (p.x < -200 || p.y < -40 || p.x > this.w + 200 || p.y > this.h + 40) continue;
      const label = d.name.toUpperCase();
      g.lineWidth = Math.max(3, size * 0.32);
      g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
      g.strokeText(label, p.x, p.y);
      g.fillStyle = d.color;
      g.fillText(label, p.x, p.y);
    }
  }

  /** The World view: each landmass's name, the airports, and the flights' route across the sea with its fixes. */
  private paintWorldLabels(g: CanvasRenderingContext2D) {
    const [home, isle] = (['home', 'island'] as const).map((r) => AIRPORT_MARKS.find((a) => a.region === r)!);
    const pts = [home, ...ROUTE, isle].map((p) => this.toScreen(p.x, p.z));
    g.save();
    g.lineCap = g.lineJoin = 'round';
    g.setLineDash([12, 9]);
    g.lineDashOffset = -this.t * 20;
    g.strokeStyle = 'rgba(29, 18, 56, 0.5)';
    g.lineWidth = 6;
    g.beginPath();
    for (const p of pts) g.lineTo(p.x, p.y);
    g.stroke();
    g.strokeStyle = PALETTE.cream;
    g.lineWidth = 2.5;
    g.stroke();
    g.setLineDash([]);
    ROUTE.forEach((f, i) => paintFix(g, pts[i + 1].x, pts[i + 1].y, f.name));
    // the flight numbers along the line, between the coasts
    const mid = this.toScreen(ROUTE[1].x, ROUTE[1].z);
    g.font = '700 13px "DM Sans", sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
    const text = `✈️ FA101 south · FA102 north · ${Math.round((isle.z - home.z) / 1000)} km`;
    g.strokeText(text, mid.x - 14, mid.y);
    g.fillStyle = PALETTE.cream;
    g.fillText(text, mid.x - 14, mid.y);
    // the landmasses' names and the airports' codes
    g.textAlign = 'center';
    for (const r of ['home', 'island'] as const) {
      const l = REGION_LABELS[r];
      const p = this.toScreen(l.x, l.z);
      p.y += l.dy;
      g.font = `26px "Lilita One", "Arial Rounded MT Bold", sans-serif`;
      g.lineWidth = 7;
      g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
      g.strokeText(l.name.toUpperCase(), p.x, p.y);
      g.fillStyle = r === 'home' ? '#ffd166' : '#7ef0c2';
      g.fillText(l.name.toUpperCase(), p.x, p.y);
    }
    for (const a of AIRPORT_MARKS) {
      const p = this.toScreen(a.x, a.z);
      g.font = '700 12px "DM Sans", sans-serif';
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(29, 18, 56, 0.85)';
      const label = `${a.icao} · ${a.name}`;
      const y = a.region === 'home' ? p.y + 22 : p.y - 22;
      g.strokeText(label, p.x, y);
      g.fillStyle = '#ffffff';
      g.fillText(label, p.x, y);
    }
    g.restore();
  }

  private placePins() {
    const ppm = this.view.ppm;
    const showLabels = ppm >= LABEL_PPM;
    // far out (the World), only the gates the flights leave from keep their pins
    const far = ppm < REGION_PPM;
    for (const [id, pin] of this.pins) {
      const p = this.toScreen(ZONES[id].x, ZONES[id].z);
      pin.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`;
      const gate = id === REGION_INFO.home.departure || id === REGION_INFO.island.departure;
      pin.classList.toggle('is-far', far && !gate && id !== this.selected);
      pin.classList.toggle('show-label', showLabels || id === this.hovered || id === this.selected || (far && gate));
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
