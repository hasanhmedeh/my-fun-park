// The visitor's customiser: who they play (one of the playable people), the colours of their
// clothes and hair, and their height and build. It opens on a first visit, before they walk in
// ("Who's visiting today?"), and in the changing room beside Rosa's booth, as a sheet on the right
// of the screen (along the bottom on phones) with the visitor standing beside it. Every change shows
// on the visitor straight away through the host; Done (or "Let's go!") keeps the look
// (visitorLook: this browser, and the account for a member), and Cancel puts back the one it
// opened with.
//
// The panel knows nothing of the engine. The host (Game.ts) lists the people, puts a look on the
// visitor (downloading that person first if need be), moves the camera and pauses the game:
//
//   const customiser = new Customiser({
//     people: customiserPeople(manifest.avatars, `${import.meta.env.BASE_URL}models/people/`),
//     preview: (look) => visitor.wear(look),        // resolves once the visitor shows it
//     close: (saved) => backToTheFair(saved),
//   }, ui.hud);
//   customiser.open(visitorLook.get() ?? defaultLook(…), { firstVisit: true });
//
// While it's open the panel has the keyboard: the game's keys don't reach it, Tab stays inside it,
// and Escape cancels (on a first visit, where there's nothing to go back to, it accepts the look).
import { session } from '../account/session';
import { canTintHair } from './crowd/looks';
import { VISITOR_LOOK_LIMITS, type AgeGroup, type AvatarSpec, type OutfitRegion, type VisitorLook } from './crowd/people-manifest';
import { escapeHtml } from './ui';
import { cleanLook, visitorLook } from './visitor-look';
import './customiser.css';

/** The rows of the Colours tab: the outfit's three regions and the hair. */
export type DyeRow = 'top' | 'bottom' | 'shoes' | 'hair';
const ROWS: DyeRow[] = ['top', 'bottom', 'shoes', 'hair'];
const ROW_LABEL: Record<DyeRow, string> = { top: 'Top', bottom: 'Bottoms', shoes: 'Shoes', hair: 'Hair' };

/** One of the people the visitor can be, as the panel needs them (customiserPeople makes these from the manifest). */
export interface CustomiserPerson {
  /** A playable AvatarSpec.id. */
  id: string;
  gender: 'm' | 'f';
  age: AgeGroup;
  /** 1 lightest … 5 deepest (not shown or described: there for the host's own use). */
  skin: number;
  /** The manifest's tags ('ponytail', 'jeans', 'hat'…): the portraits' descriptions and the reasons a row can't be dyed come from them. */
  tags: string[];
  /** The round portrait's URL (a webp, head and shoulders on transparency). */
  portrait: string;
  /** Their own height (metres): the Body tab shows the height slider in centimetres from it. */
  height: number;
  /** The outfit regions the dye reaches (AvatarSpec.outfit): a Colours row without one is disabled. 'trim' is ignored. */
  regions: OutfitRegion[];
  /** Whether their hair can be tinted (no hair, or hair under a headscarf, can't). */
  hair: boolean;
  /** Their own colours, '#rrggbb', for each row's "Original" swatch. */
  own: Partial<Record<DyeRow, string>>;
}

export interface CustomiserHost {
  /** Everyone the visitor can be, in the order the grid shows them. */
  people: CustomiserPerson[];
  /**
   * Shows `look` on the visitor. A new person may have to be downloaded first: the panel shows a
   * spinner on their portrait until this resolves, and ignores a promise that a later preview has
   * overtaken. It's called for every change (a slider's drag at most once a frame), so a change of
   * colour or size should be cheap. Rejecting means the person couldn't be fetched: the panel goes
   * back to the person last shown and says so.
   *
   * The latest call wins: a person still downloading for an earlier call must not be put on the
   * visitor once a later call has shown someone else (choose A, then B who is already loaded, and
   * the visitor stays B when A arrives). The preview scene's PreviewVisitor.wear does this.
   */
  preview(look: VisitorLook): Promise<void>;
  /**
   * The panel has closed: `saved` after Done (the look is already in visitorLook), or not after
   * Cancel (preview() has just been asked to put back the look it opened with). Give the game back.
   * Done may come while the person chosen is still downloading: their preview() is still on its
   * way, and the visitor changes into them when it lands.
   */
  close(saved: boolean): void;
  /** Optional: turn the visitor round, to see the back of the outfit. Without it there's no Turn button. */
  turn?(): void;
}

export interface CustomiserOptions {
  /** The first visit: the welcome title, "Let's go!", and nothing to cancel back to (Escape accepts). */
  firstVisit: boolean;
}

type Tab = 'person' | 'colours' | 'body';
const TABS: Tab[] = ['person', 'colours', 'body'];
type Filter = 'all' | 'f' | 'm';

/** A colour on offer: what it's called, and the dye. */
interface Swatch {
  name: string;
  hex: string;
}

/**
 * The curated dyes for each row: colours real clothes (and real hair) come in, with the fair's own
 * teal, mustard and candy pink among them. Twelve a row, so with "Original" and "Custom" a row is
 * two lines of seven on the panel.
 */
const SWATCHES: Record<DyeRow, Swatch[]> = {
  top: [
    { name: 'Chalk white', hex: '#eeeae0' },
    { name: 'Charcoal', hex: '#2c2c31' },
    { name: 'Heather grey', hex: '#8e8e93' },
    { name: 'Navy', hex: '#1f2b4d' },
    { name: 'Cobalt', hex: '#2f5bb7' },
    { name: 'Sky blue', hex: '#86b4dc' },
    { name: 'Fair teal', hex: '#22a596' },
    { name: 'Forest green', hex: '#2f5c3d' },
    { name: 'Mustard', hex: '#dba12a' },
    { name: 'Tomato red', hex: '#c3302d' },
    { name: 'Candy pink', hex: '#ea6283' },
    { name: 'Plum', hex: '#5e3a80' },
  ],
  bottom: [
    { name: 'Indigo denim', hex: '#2b3c5f' },
    { name: 'Mid-wash denim', hex: '#4f6e92' },
    { name: 'Light-wash denim', hex: '#8eaac5' },
    { name: 'Black', hex: '#1b1b1e' },
    { name: 'Charcoal', hex: '#3d3e43' },
    { name: 'Stone', hex: '#9a958c' },
    { name: 'Khaki', hex: '#b29c6f' },
    { name: 'Sand', hex: '#d9c8a3' },
    { name: 'Olive', hex: '#5d6239' },
    { name: 'Navy', hex: '#1f2744' },
    { name: 'Chocolate', hex: '#5a3c2a' },
    { name: 'Cherry', hex: '#9b2435' },
  ],
  shoes: [
    { name: 'Black', hex: '#18181b' },
    { name: 'White', hex: '#f1efe9' },
    { name: 'Dark brown', hex: '#3e2719' },
    { name: 'Tan', hex: '#a06c3f' },
    { name: 'Grey', hex: '#7e8086' },
    { name: 'Navy', hex: '#1f2846' },
    { name: 'Red', hex: '#b82b2f' },
    { name: 'Candy pink', hex: '#ea6283' },
    { name: 'Fair teal', hex: '#22a596' },
    { name: 'Mustard', hex: '#dba12a' },
    { name: 'Forest green', hex: '#2f5c3d' },
    { name: 'Cream', hex: '#e9dcc0' },
  ],
  hair: [
    { name: 'Natural black', hex: '#1b1613' },
    { name: 'Dark brown', hex: '#3a2618' },
    { name: 'Chestnut', hex: '#6b3d22' },
    { name: 'Auburn', hex: '#7d2f1d' },
    { name: 'Copper', hex: '#b2582b' },
    { name: 'Dark blonde', hex: '#8b6b43' },
    { name: 'Blonde', hex: '#cfa968' },
    { name: 'Platinum', hex: '#e6dcc3' },
    { name: 'Grey', hex: '#8f8b86' },
    { name: 'White', hex: '#ebe9e4' },
    { name: 'Candy pink', hex: '#e8679d' },
    { name: 'Electric blue', hex: '#3567d6' },
  ],
};

/** Steps the size sliders move in (the look keeps three decimals). */
const SIZE_STEP = 0.005;
/** How long arrowing through the portraits rests on one before the visitor changes into them (each may be a download). */
const BROWSE_MS = 300;
/** How many changes Undo remembers. */
const UNDO_MAX = 60;
const clamp = (v: number, [a, b]: readonly [number, number]) => Math.min(b, Math.max(a, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const copy = (l: VisitorLook): VisitorLook => ({ ...l });
const same = (a: VisitorLook, b: VisitorLook) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The customiser's people from the manifest: its playable adults, with their portraits under
 * `base` (the people folder's URL, ending in '/'). Hair can be dyed where the people runtime tints
 * it (canTintHair: hair cards that no headscarf, hood or the like covers), so the panel never
 * offers a dye the visitor won't show.
 */
export function customiserPeople(avatars: readonly AvatarSpec[], base: string): CustomiserPerson[] {
  return avatars
    .filter((a) => a.roles.includes('playable') && a.portrait)
    .map((a) => {
      const regions = (Object.keys(a.outfit?.regions ?? {}) as OutfitRegion[]).filter((r): r is Exclude<OutfitRegion, 'trim'> => r !== 'trim');
      const own: Partial<Record<DyeRow, string>> = {};
      for (const r of regions) own[r] = a.outfit!.regions[r]!.colour;
      const hair = canTintHair(a);
      if (hair) own.hair = a.hairTone?.colour ?? guessHair(a.tags);
      return { id: a.id, gender: a.gender, age: a.age, skin: a.skin, tags: [...a.tags], portrait: `${base}${a.portrait}`, height: a.height, regions, hair, own };
    });
}

/** What covers the hair, if anything (the same tags as looks.ts's hairCovered). */
const covered = (tags: readonly string[]) => tags.find((t) => /^(headscarf|keffiyeh|burqa|veil|hood|helmet)$/.test(t));
/** A stand-in for the hair's own colour until the manifest measures it (hairTone). */
const guessHair = (tags: readonly string[]) => (tags.includes('blonde') ? '#b8915a' : tags.includes('greyHair') ? '#8f8a84' : '#3a281c');

// ------------------------------------------------------------------------------------------------
// Words: what a portrait shows, and what a colour is called
// ------------------------------------------------------------------------------------------------

/** A colour's everyday name ('pink', 'navy', 'light grey'), for describing a person's clothes. */
export function colourName(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  if (l < 0.12) return 'black';
  if (s < 0.15 || d < 0.06) return l > 0.74 ? 'white' : l > 0.55 ? 'light grey' : l > 0.28 ? 'grey' : 'dark grey';
  if (h < 15 || h >= 345) return l > 0.6 || (l > 0.5 && s < 0.6) ? 'pink' : l < 0.3 ? 'dark red' : 'red';
  if (h < 45) return s < 0.45 ? (l > 0.45 ? 'beige' : 'brown') : l < 0.42 ? 'brown' : 'orange';
  if (h < 70) return s < 0.45 ? (l > 0.5 ? 'beige' : 'olive') : l < 0.3 ? 'olive' : 'yellow';
  if (h < 160) return l < 0.3 ? 'dark green' : 'green';
  if (h < 195) return 'teal';
  if (h < 250) return l < 0.35 ? 'navy' : l > 0.6 ? 'light blue' : 'blue';
  if (h < 290) return 'purple';
  return l > 0.5 ? 'pink' : 'purple';
}

/** First tag of `tags` found in `table`, as its phrase. */
const pick = (tags: readonly string[], table: [string, string][]) => table.find(([t]) => tags.includes(t))?.[1] ?? null;
/** Hairstyles: a ponytail or a bun is a thing ("a blonde bun"), the rest a kind of hair ("short blonde hair"). */
const HAIR_STYLE: [string, string][] = [['ponytail', 'ponytail'], ['bun', 'bun'], ['curlyHair', 'curly'], ['longHair', 'long'], ['shortHair', 'short']];
const HEADWEAR: [string, string][] = [['headscarf', 'a headscarf'], ['keffiyeh', 'a keffiyeh'], ['hood', 'a hood'], ['cap', 'a cap'], ['beanie', 'a beanie'], ['hat', 'a hat']];
/** Tops, the outer layer first (a jacket over a shirt is "a jacket"). One-piece outfits come first: they're the whole outfit. */
const TOPS: [string, string][] = [
  ['abaya', 'abaya'], ['thobe', 'thobe'], ['longDress', 'long dress'], ['dress', 'dress'], ['longShirt', 'long shirt'], ['trackSuit', 'tracksuit'],
  ['jacket', 'jacket'], ['hoodie', 'hoodie'], ['cardigan', 'cardigan'], ['gilet', 'gilet'], ['waistcoat', 'waistcoat'], ['sweater', 'jumper'],
  ['polo', 'polo shirt'], ['tshirt', 'T-shirt'], ['shirt', 'shirt'], ['top', 'top'],
];
const ONE_PIECE = ['abaya', 'thobe', 'longDress', 'dress', 'longShirt', 'trackSuit'];
const BOTTOMS: [string, string][] = [['jeans', 'jeans'], ['trousers', 'trousers'], ['skirt', 'skirt'], ['shorts', 'shorts']];

const article = (word: string) => (/^[aeiou]/i.test(word) ? 'an' : 'a');
const list = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * A neutral one-line description of a person from their tags and their clothes' own colours, for
 * a portrait's label: "Woman with a blonde ponytail, in a pink shirt and jeans". It names what
 * anyone can see (hair, headwear, clothes) and nothing else: never where someone might be from.
 */
export function describePerson(p: Pick<CustomiserPerson, 'gender' | 'age' | 'tags' | 'own'>): string {
  const t = p.tags;
  const bald = t.includes('bald');
  const who = `${bald ? 'Bald ' : ''}${p.age === 'older' ? 'older ' : ''}${p.gender === 'f' ? 'woman' : 'man'}`;
  const withs: string[] = [];
  if (!bald && !covered(t)) {
    const tone = t.includes('blonde') ? 'blonde' : t.includes('greyHair') ? 'grey' : '';
    const style = pick(t, HAIR_STYLE);
    if (style === 'ponytail' || style === 'bun') withs.push(`${article(tone || style)} ${tone ? `${tone} ` : ''}${style}`);
    // (length or curl before colour, as English has it: "short blonde hair")
    else if (style || tone) withs.push(`${[style, tone].filter(Boolean).join(' ')} hair`);
  }
  if (t.includes('beard')) withs.push('a beard');
  if (t.includes('glasses')) withs.push('glasses');
  const ins: string[] = [];
  const head = pick(t, HEADWEAR);
  if (head) ins.push(head);
  const top = pick(t, TOPS);
  if (top) {
    const c = p.own.top ? `${colourName(p.own.top)} ` : '';
    ins.push(`${article(c || top)} ${c}${top}`);
  }
  const onePiece = ONE_PIECE.some((k) => t.includes(k));
  const bottom = onePiece ? null : pick(t, BOTTOMS);
  if (bottom) {
    const c = bottom !== 'jeans' && p.own.bottom ? `${colourName(p.own.bottom)} ` : '';
    ins.push(bottom === 'skirt' ? `${article(c || bottom)} ${c}skirt` : `${c}${bottom}`);
  }
  const text = `${who}${withs.length ? ` with ${list(withs)}` : ''}${ins.length ? `${withs.length ? ',' : ''} in ${list(ins)}` : ''}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Why a row can't be dyed for this person, in a few words. */
function rowReason(p: CustomiserPerson, row: DyeRow): string {
  const t = p.tags;
  if (row === 'hair') {
    if (t.includes('bald')) return 'Bald: no hair to dye.';
    const c = covered(t);
    if (c) return `Their hair is under the ${c}.`;
    return 'This hairstyle can’t be dyed.';
  }
  if (row === 'bottom' && ONE_PIECE.some((k) => t.includes(k))) return 'One-piece outfit: the Top colour dyes all of it.';
  return row === 'top' ? 'This top can’t be dyed.' : row === 'bottom' ? 'These bottoms can’t be dyed.' : 'These shoes can’t be dyed.';
}

const canDye = (p: CustomiserPerson, row: DyeRow) => (row === 'hair' ? p.hair : p.regions.includes(row));

/** Ink or white, whichever reads on `hex`. */
function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return y > 0.36 ? '#22163f' : '#ffffff';
}

// ------------------------------------------------------------------------------------------------
// The panel
// ------------------------------------------------------------------------------------------------

export class Customiser {
  isOpen = false;
  private readonly el: HTMLElement;
  private readonly sheet: HTMLElement;
  private readonly $ = <T extends HTMLElement = HTMLElement>(sel: string) => this.el.querySelector<T>(sel)!;
  private readonly byId = new Map<string, CustomiserPerson>();
  private look!: VisitorLook;
  private opened!: VisitorLook;
  private firstVisit = false;
  private tab: Tab = 'person';
  private filter: Filter = 'all';
  private undos: VisitorLook[] = [];
  /** Counts previews: a promise resolving for an older one is stale. */
  private seq = 0;
  /** What the visitor shows (the last preview the host finished), or null before the first. */
  private shown: VisitorLook | null = null;
  /** A person who just failed to load (their portrait says so for a moment). */
  private failed: string | null = null;
  private browseTimer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  /** A slider being dragged (or the colour picker open) has already put the look before it on the undo list. */
  private gesture: string | null = null;
  /** Custom colours picked this time, per row (the Custom swatch remembers its last colour). */
  private custom: Partial<Record<DyeRow, string>> = {};
  private returnFocus: HTMLElement | null = null;

  constructor(
    private host: CustomiserHost,
    parent: HTMLElement = document.body,
  ) {
    for (const p of host.people) this.byId.set(p.id, p);
    const el = document.createElement('div');
    el.className = 'cust';
    el.hidden = true;
    el.innerHTML = `
      <section class="cust-sheet" role="dialog" aria-modal="true" aria-labelledby="cust-title" aria-describedby="cust-sub">
        <header class="cust-head">
          <div class="cust-title">
            <p class="cust-eyebrow" data-cust-eyebrow></p>
            <h2 id="cust-title" data-cust-title></h2>
            <p class="cust-sub" id="cust-sub" data-cust-sub></p>
          </div>
          <div class="cust-head-tools">
            <button type="button" class="cust-icon" data-cust-turn aria-label="Turn round: see the back" title="Turn round">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5v19"/><path d="M12 8c-5 0-9 1.8-9 4s4 4 9 4 9-1.8 9-4c0-1.3-1.4-2.4-3.5-3.1"/><path d="M17.7 11.9l-.2-3 3-.2"/></svg>
            </button>
            <button type="button" class="cust-icon" data-cust-cancel aria-label="Cancel: keep your old look (Esc)" title="Cancel (Esc)">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
        </header>
        <div class="cust-tabs" role="tablist" aria-label="Make your look">
          <button type="button" role="tab" id="cust-tab-person" aria-controls="cust-panel-person" data-cust-tab="person"><span aria-hidden="true">🧑</span> Person</button>
          <button type="button" role="tab" id="cust-tab-colours" aria-controls="cust-panel-colours" data-cust-tab="colours"><span aria-hidden="true">🎨</span> Colours</button>
          <button type="button" role="tab" id="cust-tab-body" aria-controls="cust-panel-body" data-cust-tab="body"><span aria-hidden="true">📏</span> Body</button>
        </div>
        <div class="cust-body" data-cust-scroll>
          <div class="cust-panel" role="tabpanel" id="cust-panel-person" aria-labelledby="cust-tab-person">
            <div class="cust-chips" role="group" aria-label="Show">
              <button type="button" data-cust-filter="all">All <span data-cust-count="all"></span></button>
              <button type="button" data-cust-filter="f">Women <span data-cust-count="f"></span></button>
              <button type="button" data-cust-filter="m">Men <span data-cust-count="m"></span></button>
            </div>
            <div class="cust-grid" role="radiogroup" aria-label="People" data-cust-grid></div>
          </div>
          <div class="cust-panel" role="tabpanel" id="cust-panel-colours" aria-labelledby="cust-tab-colours" data-cust-colours hidden></div>
          <div class="cust-panel" role="tabpanel" id="cust-panel-body" aria-labelledby="cust-tab-body" hidden>
            <div class="cust-slider">
              <div class="cust-slider-head"><label for="cust-height">Height</label><output for="cust-height" data-cust-out="height"></output></div>
              <input type="range" id="cust-height" data-cust-size="height" min="${VISITOR_LOOK_LIMITS.height[0]}" max="${VISITOR_LOOK_LIMITS.height[1]}" step="${SIZE_STEP}" />
              <div class="cust-scale" aria-hidden="true"><span data-cust-scale="min"></span><span data-cust-scale="own"></span><span data-cust-scale="max"></span></div>
            </div>
            <div class="cust-slider">
              <div class="cust-slider-head"><label for="cust-build">Build</label><output for="cust-build" data-cust-out="build"></output></div>
              <input type="range" id="cust-build" data-cust-size="build" min="${VISITOR_LOOK_LIMITS.build[0]}" max="${VISITOR_LOOK_LIMITS.build[1]}" step="${SIZE_STEP}" />
              <div class="cust-scale" aria-hidden="true"><span>Slimmer</span><span>Their own</span><span>Broader</span></div>
            </div>
            <p class="cust-note">Just for looks: everyone runs, jumps and rides the same.</p>
            <button type="button" class="cust-tool cust-reset" data-cust-reset-body><span aria-hidden="true">↺</span> Reset height and build</button>
          </div>
        </div>
        <p class="cust-status" role="status" aria-live="polite" data-cust-status></p>
        <footer class="cust-foot">
          <button type="button" class="cust-tool" data-cust-random title="Someone new, in sensible colours"><span aria-hidden="true">🎲</span> <span class="cust-tool-label">Random</span></button>
          <button type="button" class="cust-tool" data-cust-undo><span aria-hidden="true">↶</span> <span class="cust-tool-label">Undo</span></button>
          <button type="button" class="btn btn-primary cust-go" data-cust-done></button>
        </footer>
      </section>`;
    parent.appendChild(el);
    this.el = el;
    this.sheet = this.$('.cust-sheet');
    this.wire();
  }

  // ---------- Opening and closing ----------

  /**
   * Opens the panel on `look` (the visitor's, or a default for a first visit). A look naming
   * someone who isn't in `people` starts from the first of them instead.
   */
  open(look: VisitorLook, options: CustomiserOptions) {
    const first = this.host.people[0];
    if (!first) throw new Error('Customiser: no people to choose from');
    let start = cleanLook(look) ?? { v: 1, avatar: first.id, top: null, bottom: null, shoes: null, hair: null, height: 1, build: 1 };
    if (!this.byId.has(start.avatar)) start = { ...start, avatar: first.id, top: null, bottom: null, shoes: null, hair: null };
    this.opened = copy(start);
    this.look = copy(start);
    this.firstVisit = options.firstVisit;
    this.undos = [];
    this.custom = {};
    this.gesture = null;
    this.failed = null;
    this.shown = null;
    this.tab = 'person';
    this.filter = 'all';
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const room = !this.firstVisit;
    this.sheet.classList.toggle('is-room', room);
    this.$('[data-cust-eyebrow]').textContent = room ? 'Beside Rosa’s booth' : 'Welcome to the fair';
    this.$('[data-cust-title]').textContent = room ? 'Changing room' : 'Who’s visiting today?';
    this.$('[data-cust-sub]').textContent = room
      ? `Be someone new, dye your clothes or try another height. ${session.user ? 'Done saves it to your account.' : 'Done saves it in this browser.'}`
      : 'Pick a person, then make the look yours. You can change it any time in the changing room by Rosa’s booth.';
    this.$('[data-cust-done]').innerHTML = room ? 'Done' : 'Let’s go! <span aria-hidden="true">→</span>';
    this.$('[data-cust-cancel]').hidden = !room;
    this.$('[data-cust-turn]').hidden = !this.host.turn;
    this.$('[data-cust-status]').textContent = '';

    this.isOpen = true;
    this.el.hidden = false;
    document.body.classList.add('is-dressing');
    document.addEventListener('keydown', this.onDocumentKey, true);
    this.renderAll();
    this.showTab('person', false);
    this.preview();
    this.$<HTMLElement>(`[data-cust-tab="person"]`).focus({ preventScroll: true });
    this.$<HTMLElement>('.cust-person[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  /** Hides the panel (the host closing it, say the visitor was called away); host.close isn't called. */
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.hidden = true;
    document.body.classList.remove('is-dressing');
    document.removeEventListener('keydown', this.onDocumentKey, true);
    if (this.browseTimer) clearTimeout(this.browseTimer);
    this.browseTimer = null;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    // the visitor is a step ahead of any preview still on its way: nothing more to wait for
    this.seq++;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  /** The look being made (a copy). */
  get current(): VisitorLook {
    return copy(this.look);
  }

  /**
   * How far to shift the picture so the visitor shows beside the panel, not under it (for
   * camera.setViewOffset): the sheet takes the right of a wide screen, the bottom of a narrow one.
   */
  viewOffset(w: number, h: number) {
    if (!this.isOpen) return { x: 0, y: 0 };
    const r = this.sheet.getBoundingClientRect();
    // (from where the sheet is, not a breakpoint: a phone on its side keeps it on the right)
    const side = r.height > h * 0.7;
    return side ? { x: Math.round(Math.min(r.width + 16, w * 0.6) / 2), y: 0 } : { x: 0, y: Math.round(Math.min(r.height + 8, h * 0.7) / 2) };
  }

  /** Keep the look, and back to the fair. */
  private done() {
    const look = cleanLook(this.look);
    if (look) {
      visitorLook.set(look);
      visitorLook.saveNow();
    }
    this.close();
    this.host.close(true);
  }

  /** Escape, or ✕: put the old look back (on a first visit there's none, so it's Done). */
  private cancel() {
    if (this.firstVisit) return this.done();
    const back = copy(this.opened);
    this.close();
    this.host.preview(back).catch(() => undefined);
    this.host.close(false);
  }

  // ---------- Changing the look ----------

  /**
   * Applies a change to the look: remembered for Undo (once per gesture: a slider's drag or a
   * colour picker's session is one change), shown on the visitor, and drawn in the panel.
   */
  private change(edit: (look: VisitorLook) => void, how: { gesture?: string; browse?: boolean } = {}) {
    const before = copy(this.look);
    const next = copy(this.look);
    edit(next);
    next.height = round3(clamp(next.height, VISITOR_LOOK_LIMITS.height));
    next.build = round3(clamp(next.build, VISITOR_LOOK_LIMITS.build));
    for (const r of ROWS) {
      const c = next[r];
      next[r] = c && VISITOR_LOOK_LIMITS.colour.test(c.toLowerCase()) ? c.toLowerCase() : null;
    }
    if (same(before, next)) return;
    if (!how.gesture || how.gesture !== this.gesture) {
      this.undos.push(before);
      if (this.undos.length > UNDO_MAX) this.undos.shift();
    }
    this.gesture = how.gesture ?? null;
    const personChanged = next.avatar !== before.avatar;
    this.look = next;
    if (personChanged) {
      this.failed = null;
      this.renderColours();
    } else this.renderColourState();
    this.renderPeopleState();
    this.renderBody();
    this.renderFoot();
    if (how.browse) {
      if (this.browseTimer) clearTimeout(this.browseTimer);
      this.browseTimer = setTimeout(() => {
        this.browseTimer = null;
        this.preview();
      }, BROWSE_MS);
    } else this.schedulePreview();
  }

  /** One preview a frame at most (a slider's drag sends many changes). */
  private schedulePreview() {
    if (this.browseTimer) clearTimeout(this.browseTimer);
    this.browseTimer = null;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.preview();
    });
  }

  /** Asks the host to show the look now; the portrait spins until it has. */
  private preview() {
    if (!this.isOpen) return;
    const look = copy(this.look);
    const seq = ++this.seq;
    this.renderPeopleState();
    this.host.preview(look).then(
      () => {
        if (seq !== this.seq) return;
        this.shown = look;
        this.renderPeopleState();
      },
      (err: unknown) => {
        if (seq !== this.seq) return;
        console.warn('The Funfair: the customiser could not show that look.', err);
        if (this.look.avatar !== look.avatar) {
          // they've already moved on to someone else (arrowing along the portraits): just grey this one out
          this.failed = look.avatar;
          this.renderPeopleState();
        } else if (this.shown && this.shown.avatar !== look.avatar) {
          // back to the look the visitor still wears
          this.failed = look.avatar;
          this.look = copy(this.shown);
          // (the change that failed leaves nothing to undo)
          const last = this.undos[this.undos.length - 1];
          if (last && same(last, this.shown)) this.undos.pop();
          this.renderAll();
          this.say('Sorry, that person couldn’t be fetched just now. Try again in a moment.');
          this.preview();
        } else if (!this.shown) {
          // the very first preview: nothing to go back to, so stop the spinner, and choosing them
          // again tries again
          this.failed = look.avatar;
          this.renderPeopleState();
          this.say('Sorry, they couldn’t be fetched just now. Choose them again to try again.');
        } else this.renderPeopleState();
      },
    );
  }

  private setPerson(id: string, browse = false) {
    if (id === this.look.avatar && id === this.failed) {
      this.failed = null;
      this.say('');
      this.preview();
      return;
    }
    if (id === this.look.avatar || !this.byId.has(id)) return;
    // a new person starts in their own clothes: another's dyes may not suit them (or apply at all)
    this.change((l) => Object.assign(l, { avatar: id, top: null, bottom: null, shoes: null, hair: null }), { browse });
    const p = this.byId.get(id)!;
    this.say(`${describePerson(p)}.`);
  }

  private setColour(row: DyeRow, hex: string | null, gesture?: string) {
    if (!canDye(this.person, row)) return;
    this.change((l) => (l[row] = hex), { gesture });
  }

  private randomise() {
    const pool = this.visiblePeople();
    const others = pool.filter((p) => p.id !== this.look.avatar);
    const p = (others.length ? others : pool)[Math.floor(Math.random() * Math.max(1, (others.length ? others : pool).length))];
    if (!p) return;
    const any = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
    const dye = (row: DyeRow, keep: number, from: Swatch[]) => (!canDye(p, row) || Math.random() < keep ? null : any(from).hex);
    const nat = SWATCHES.hair.slice(0, 10);
    // sensible: shoes mostly black, white or brown; hair mostly its own, now and then a natural shade, rarely a fun one
    const shoes = SWATCHES.shoes.filter((s) => ['Black', 'White', 'Dark brown', 'Tan', 'Grey', 'Navy'].includes(s.name));
    const hair = Math.random() < 0.06 ? SWATCHES.hair.slice(10) : nat;
    this.change((l) =>
      Object.assign(l, {
        avatar: p.id,
        top: dye('top', 0.35, SWATCHES.top),
        bottom: dye('bottom', 0.45, SWATCHES.bottom),
        shoes: dye('shoes', 0.55, shoes),
        hair: dye('hair', 0.7, hair),
        height: 1 + (Math.random() - 0.5) * 0.08,
        build: 1 + (Math.random() - 0.5) * 0.06,
      }),
    );
    const who = describePerson(p);
    this.say(`Random pick: ${who.charAt(0).toLowerCase()}${who.slice(1)}.`);
    this.$<HTMLElement>('.cust-person[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
  }

  private undo() {
    const prev = this.undos.pop();
    if (!prev) return;
    const personChanged = prev.avatar !== this.look.avatar;
    this.look = prev;
    this.gesture = null;
    this.failed = null;
    if (personChanged) this.renderColours();
    else this.renderColourState();
    this.renderPeopleState();
    this.renderBody();
    this.renderFoot();
    this.schedulePreview();
    this.say(this.undos.length ? 'Undone.' : 'Back to how you came in.');
  }

  // ---------- Events ----------

  private wire() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const b = t.closest<HTMLElement>('button');
      if (!b || !el.contains(b) || (b as HTMLButtonElement).disabled) return;
      const d = b.dataset;
      if (d.custTab) this.showTab(d.custTab as Tab, true);
      else if (d.custFilter) this.setFilter(d.custFilter as Filter);
      else if (d.custPerson) this.setPerson(d.custPerson);
      else if (d.custSwatch) this.onSwatch(b);
      else if (b.hasAttribute('data-cust-random')) this.randomise();
      else if (b.hasAttribute('data-cust-undo')) this.undo();
      else if (b.hasAttribute('data-cust-done')) this.done();
      else if (b.hasAttribute('data-cust-cancel')) this.cancel();
      else if (b.hasAttribute('data-cust-turn')) this.host.turn?.();
      else if (b.hasAttribute('data-cust-reset-body')) {
        this.change((l) => Object.assign(l, { height: 1, build: 1 }));
        this.say('Back to their own height and build.');
      }
    });
    // the panel has the keyboard: none of its keys reach the game
    this.sheet.addEventListener('keydown', (e) => {
      this.onKey(e);
      e.stopPropagation();
    });
    // the sliders: a drag is one change for Undo, previewed a frame at a time
    for (const input of el.querySelectorAll<HTMLInputElement>('[data-cust-size]')) {
      const key = input.dataset.custSize as 'height' | 'build';
      input.addEventListener('input', () => this.change((l) => (l[key] = Number(input.value)), { gesture: `size-${key}` }));
      input.addEventListener('change', () => (this.gesture = null));
    }
    // the colour pickers (one hidden input per row, opened by its Custom swatch)
    el.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.dataset.custPicker as DyeRow | undefined;
      if (!row) return;
      this.custom[row] = input.value.toLowerCase();
      this.setColour(row, input.value, `pick-${row}`);
    });
    el.addEventListener('change', (e) => {
      if ((e.target as HTMLElement).dataset.custPicker) this.gesture = null;
    });
  }

  /** Keys anywhere while open: Escape, and Tab kept inside the panel (it may have wandered off to the page). */
  private onDocumentKey = (e: KeyboardEvent) => {
    if (!this.isOpen) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = this.focusables();
    if (!items.length) return;
    const at = document.activeElement as HTMLElement | null;
    const inside = !!at && this.sheet.contains(at);
    const firstEl = items[0];
    const lastEl = items[items.length - 1];
    if (!inside || (e.shiftKey && at === firstEl) || (!e.shiftKey && at === lastEl)) {
      e.preventDefault();
      e.stopPropagation();
      (e.shiftKey ? lastEl : firstEl).focus();
    }
  };

  private focusables() {
    return [...this.sheet.querySelectorAll<HTMLElement>('button, input, [tabindex]')].filter(
      (n) => n.tabIndex >= 0 && !(n as HTMLButtonElement).disabled && !n.closest('[hidden]') && n.getClientRects().length > 0,
    );
  }

  /** Arrow keys in the tabs, the portraits and the swatches (each a single Tab stop). */
  private onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    const k = e.key;
    const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!arrows.includes(k)) return;
    if (t.matches('[role="tab"]')) {
      if (k === 'ArrowUp' || k === 'ArrowDown') return;
      e.preventDefault();
      const i = TABS.indexOf(this.tab);
      const next = k === 'Home' ? 0 : k === 'End' ? TABS.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
      this.showTab(TABS[next], true);
      this.$<HTMLElement>(`[data-cust-tab="${TABS[next]}"]`).focus();
    } else if (t.matches('[data-cust-filter]')) {
      // the chips are toggle buttons (each its own Tab stop), but arrows walk along them too
      if (k === 'ArrowUp' || k === 'ArrowDown') return;
      e.preventDefault();
      const chips = [...this.el.querySelectorAll<HTMLElement>('[data-cust-filter]')];
      const i = chips.indexOf(t);
      const j = k === 'Home' ? 0 : k === 'End' ? chips.length - 1 : (i + (k === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length;
      chips[j].focus();
    } else if (t.matches('.cust-person')) {
      e.preventDefault();
      const items = [...this.el.querySelectorAll<HTMLButtonElement>('.cust-person')];
      const i = items.indexOf(t as HTMLButtonElement);
      const cols = Math.max(1, items.filter((b) => b.offsetTop === items[0].offsetTop).length);
      const step = k === 'ArrowRight' ? 1 : k === 'ArrowLeft' ? -1 : k === 'ArrowDown' ? cols : k === 'ArrowUp' ? -cols : 0;
      const j = k === 'Home' ? 0 : k === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, i + step));
      const next = items[j];
      if (!next || next === t) return;
      next.focus();
      // the radio follows the keyboard, but the visitor only changes once the arrowing rests
      this.setPerson(next.dataset.custPerson!, true);
    } else if (t.matches('.cust-sw')) {
      e.preventDefault();
      const set = [...(t.parentElement?.querySelectorAll<HTMLButtonElement>('.cust-sw') ?? [])];
      const i = set.indexOf(t as HTMLButtonElement);
      const fwd = k === 'ArrowRight' || k === 'ArrowDown';
      const j = k === 'Home' ? 0 : k === 'End' ? set.length - 1 : (i + (fwd ? 1 : -1) + set.length) % set.length;
      const next = set[j];
      next.focus();
      // arrowing onto Custom doesn't pop the picker open: it takes the colour picked there before, if any
      if (next.dataset.custSwatch !== 'custom') this.onSwatch(next);
      else {
        const row = next.dataset.custRow as DyeRow;
        if (this.custom[row]) this.setColour(row, this.custom[row]!);
      }
    }
  }

  private onSwatch(b: HTMLElement) {
    const row = b.dataset.custRow as DyeRow;
    const which = b.dataset.custSwatch!;
    if (which === 'own') this.setColour(row, null);
    else if (which === 'custom') {
      const input = this.$<HTMLInputElement>(`[data-cust-picker="${row}"]`);
      input.value = this.look[row] ?? this.custom[row] ?? this.person.own[row] ?? '#888888';
      try {
        input.showPicker();
      } catch {
        input.click();
      }
    } else this.setColour(row, which);
  }

  private showTab(tab: Tab, spoken: boolean) {
    this.tab = tab;
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-cust-tab]')) {
      const on = b.dataset.custTab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const t of TABS) this.$(`#cust-panel-${t}`).hidden = t !== tab;
    this.$('[data-cust-scroll]').scrollTop = 0;
    if (tab === 'person') this.$<HTMLElement>('.cust-person[aria-checked="true"]')?.scrollIntoView({ block: 'nearest' });
    if (spoken) this.say('');
  }

  private setFilter(f: Filter) {
    if (f === this.filter) return;
    this.filter = f;
    this.renderPeople();
  }

  private say(text: string) {
    this.$('[data-cust-status]').textContent = text;
  }

  // ---------- Drawing ----------

  private get person(): CustomiserPerson {
    return this.byId.get(this.look.avatar)!;
  }

  private visiblePeople() {
    return this.host.people.filter((p) => this.filter === 'all' || p.gender === this.filter);
  }

  private renderAll() {
    this.renderPeople();
    this.renderColours();
    this.renderBody();
    this.renderFoot();
  }

  private renderPeople() {
    const counts = { all: this.host.people.length, f: 0, m: 0 };
    for (const p of this.host.people) counts[p.gender]++;
    for (const b of this.el.querySelectorAll<HTMLElement>('[data-cust-filter]')) b.setAttribute('aria-pressed', String(b.dataset.custFilter === this.filter));
    for (const s of this.el.querySelectorAll<HTMLElement>('[data-cust-count]')) s.textContent = String(counts[s.dataset.custCount as Filter]);
    const people = this.visiblePeople();
    const grid = this.$('[data-cust-grid]');
    // (drawn again while a portrait has the keyboard, say after a failed fetch: it keeps it)
    const hadFocus = grid.contains(document.activeElement);
    grid.innerHTML = people
      .map((p) => {
        const d = escapeHtml(describePerson(p));
        return `<button type="button" role="radio" class="cust-person" data-cust-person="${escapeHtml(p.id)}" aria-label="${d}" title="${d}">
            <span class="cust-face"><img src="${escapeHtml(p.portrait)}" alt="" width="128" height="128" loading="lazy" decoding="async" draggable="false" /></span>
            <span class="cust-tick" aria-hidden="true"></span>
          </button>`;
      })
      .join('');
    this.renderPeopleState();
    if (hadFocus) this.$<HTMLElement>('.cust-person[tabindex="0"]')?.focus({ preventScroll: true });
  }

  /** The grid's selection, its keyboard stop, and the spinner on whoever is on their way. */
  private renderPeopleState() {
    const items = [...this.el.querySelectorAll<HTMLElement>('.cust-person')];
    const chosen = items.find((b) => b.dataset.custPerson === this.look.avatar) ?? null;
    const waiting = this.look.avatar !== this.shown?.avatar && this.look.avatar !== this.failed;
    for (const b of items) {
      const on = b === chosen;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on || (!chosen && b === items[0]) ? 0 : -1;
      b.classList.toggle('is-busy', on && waiting);
      b.toggleAttribute('aria-busy', on && waiting);
      b.classList.toggle('is-failed', b.dataset.custPerson === this.failed);
    }
  }

  /** The Colours tab, for the person chosen now. */
  private renderColours() {
    const p = this.person;
    const panel = this.$('[data-cust-colours]');
    const active = document.activeElement as HTMLElement | null;
    const focusRow = active && panel.contains(active) ? (active.dataset.custRow ?? null) : null;
    panel.innerHTML = ROWS.map((row) => {
      const id = `cust-dye-${row}`;
      if (!canDye(p, row))
        return `<section class="cust-dye is-off" aria-labelledby="${id}">
            <div class="cust-dye-head"><h3 id="${id}">${ROW_LABEL[row]}</h3><span class="cust-dye-name">Can’t dye</span></div>
            <p class="cust-dye-why">${escapeHtml(rowReason(p, row))}</p>
          </section>`;
      const own = p.own[row];
      const sw = (key: string, hex: string | null, label: string, cls = '') =>
        `<button type="button" role="radio" class="cust-sw ${cls}" data-cust-row="${row}" data-cust-swatch="${key}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${
          hex ? ` style="--c:${hex};--fg:${inkOn(hex)}"` : ''
        }></button>`;
      return `<section class="cust-dye" aria-labelledby="${id}">
          <div class="cust-dye-head"><h3 id="${id}">${ROW_LABEL[row]}</h3><span class="cust-dye-name" data-cust-name="${row}"></span></div>
          <div class="cust-swatches" role="radiogroup" aria-labelledby="${id}">
            ${sw('own', own ?? null, `Original${own ? ` (${colourName(own)})` : ''}`, `cust-sw-own${own ? '' : ' is-unknown'}`)}
            ${SWATCHES[row].map((s) => sw(s.hex, s.hex, s.name)).join('')}
            ${sw('custom', null, 'Custom colour…', 'cust-sw-custom')}
            <input type="color" class="cust-picker" data-cust-picker="${row}" tabindex="-1" aria-hidden="true" />
          </div>
        </section>`;
    }).join('');
    this.renderColourState();
    // (a new person draws the rows again: the keyboard stays on the row it was on, or the first that can be dyed)
    if (focusRow) (panel.querySelector<HTMLElement>(`.cust-sw[data-cust-row="${focusRow}"][tabindex="0"]`) ?? panel.querySelector<HTMLElement>('.cust-sw[tabindex="0"]'))?.focus({ preventScroll: true });
  }

  /** Which swatch each row has on, and its name. */
  private renderColourState() {
    for (const row of ROWS) {
      const set = [...this.el.querySelectorAll<HTMLElement>(`.cust-sw[data-cust-row="${row}"]`)];
      if (!set.length) continue;
      const value = this.look[row];
      const listed = value ? SWATCHES[row].find((s) => s.hex === value) : null;
      const key = value === null ? 'own' : listed ? listed.hex : 'custom';
      for (const b of set) {
        const on = b.dataset.custSwatch === key;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
        if (b.dataset.custSwatch === 'custom') {
          const c = key === 'custom' ? value : (this.custom[row] ?? null);
          b.classList.toggle('has-colour', !!c);
          if (c) {
            b.style.setProperty('--c', c);
            b.style.setProperty('--fg', inkOn(c));
          }
          b.setAttribute('aria-label', c ? `Custom colour (${colourName(c)}, ${c})` : 'Custom colour…');
          b.title = c ? `Custom colour ${c}` : 'Custom colour…';
        }
      }
      const name = this.$(`[data-cust-name="${row}"]`);
      name.textContent = key === 'own' ? 'Original' : listed ? listed.name : `Custom · ${value}`;
    }
  }

  private renderBody() {
    const p = this.person;
    const cm = (k: number) => `${Math.round(p.height * k * 100)} cm`;
    const height = this.$<HTMLInputElement>('[data-cust-size="height"]');
    const build = this.$<HTMLInputElement>('[data-cust-size="build"]');
    height.value = String(this.look.height);
    build.value = String(this.look.build);
    const words = buildWords(this.look.build);
    height.setAttribute('aria-valuetext', `${cm(this.look.height)}${this.look.height === 1 ? ', their own height' : ''}`);
    build.setAttribute('aria-valuetext', words);
    this.$('[data-cust-out="height"]').textContent = cm(this.look.height);
    this.$('[data-cust-out="build"]').textContent = words;
    this.$('[data-cust-scale="min"]').textContent = cm(VISITOR_LOOK_LIMITS.height[0]);
    this.$('[data-cust-scale="own"]').textContent = `Their own ${cm(1)}`;
    this.$('[data-cust-scale="max"]').textContent = cm(VISITOR_LOOK_LIMITS.height[1]);
    for (const input of [height, build]) {
      const min = Number(input.min);
      const max = Number(input.max);
      input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    }
    (this.$('[data-cust-reset-body]') as HTMLButtonElement).disabled = this.look.height === 1 && this.look.build === 1;
  }

  private renderFoot() {
    const undo = this.$<HTMLButtonElement>('[data-cust-undo]');
    undo.disabled = !this.undos.length;
    undo.title = this.undos.length ? 'Undo the last change' : 'Nothing to undo';
  }
}

/** The Build slider's value in words. */
function buildWords(build: number) {
  const k = (build - 1) / 0.06;
  return k <= -0.66 ? 'Slimmer' : k < -0.2 ? 'A little slimmer' : k <= 0.2 ? (build === 1 ? 'Their own build' : 'About their own') : k < 0.66 ? 'A little broader' : 'Broader';
}
