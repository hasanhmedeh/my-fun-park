// Thin wrapper over the HUD DOM declared in park.html.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Where this browser remembers which info cards it has already shown by themselves. */
const SEEN_KEY = 'funfair.info.seen';
/** How long the ℹ️ button glows when a card is there to read but didn't open by itself. */
const NUDGE_MS = 4_000;

type PanelOpts = { left?: boolean; accent?: string };

/** An informative card: the park's guide, or a ride's intro. Rendered when shown, so it's always current. */
interface InfoCard {
  key: string;
  html: () => string;
  opts: PanelOpts;
  /** For the button's label: "About Sky Flip". */
  title: string;
}

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class UI {
  hud = $('hud');
  private promptEl = $('prompt');
  private panelEl = $('panel');
  private scoreEl = $('score');
  private countdownEl = $('countdown');
  private rideExitEl = $('ride-exit');
  private promptKey = '';
  private panelKey = '';
  private infoEl = $<HTMLButtonElement>('info-toggle');
  private guide: InfoCard | null = null;
  private intro: InfoCard | null = null;
  private seen = readSeen();
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  onPromptClick: (() => void) | null = null;
  onPanelClose: (() => void) | null = null;
  onRideExit: (() => void) | null = null;

  constructor(private mobile: boolean) {
    this.promptEl.addEventListener('click', () => this.onPromptClick?.());
    this.rideExitEl.querySelector('button')!.addEventListener('click', () => this.onRideExit?.());
    // transient badges dismiss on click too
    this.scoreEl.addEventListener('click', () => (this.scoreEl.hidden = true));
    $('rh-toast').addEventListener('click', (e) => ((e.currentTarget as HTMLElement).hidden = true));
    this.infoEl.addEventListener('click', () => this.toggleInfo());
    this.panelEl.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('[data-panel-close]')) {
        this.hidePanel();
        this.onPanelClose?.();
      }
    });
  }

  prompt(key: string, title: string, action: string) {
    if (this.promptKey === key) return;
    this.promptKey = key;
    if (!key) {
      this.promptEl.hidden = true;
      return;
    }
    const k = this.mobile ? 'Tap <kbd>E</kbd>' : 'Press <kbd>E</kbd>';
    this.promptEl.innerHTML = `${escapeHtml(title)}<small>${k} · ${escapeHtml(action)}</small>`;
    this.promptEl.hidden = false;
  }

  // ---------- The ℹ️ button ----------
  // Informative cards (the park's guide, each ride's intro) open by themselves only the first time
  // this browser meets them; after that, they're behind the ℹ️ button in the top-right corner.

  /** The park's guide: what the ℹ️ shows on foot. Opens by itself on a first visit. */
  setGuide(key: string, title: string, html: () => string, opts: PanelOpts = {}) {
    this.guide = { key, title, html, opts };
    this.labelInfo();
    this.offer(this.guide);
  }

  /**
   * A ride's intro: what the ℹ️ shows until `endIntro`. Opens by itself the first time; returns
   * whether it did (a ride times its intro out only then).
   */
  setIntro(key: string, title: string, html: string, opts: PanelOpts = {}): boolean {
    this.intro = { key, title, html: () => html, opts };
    this.labelInfo();
    return this.offer(this.intro);
  }

  /** The ride is over: the ℹ️ is back to the park's guide (and the ride's intro closes, if it's open). */
  endIntro() {
    if (!this.intro) return;
    if (this.panelOpenKey === this.intro.key) this.hidePanel();
    this.intro = null;
    this.labelInfo();
  }

  /** The ℹ️ (or the I key): opens the card for where the visitor is, or closes it. */
  toggleInfo() {
    const card = this.intro ?? this.guide;
    if (!card || this.hud.hidden) return;
    if (this.panelOpenKey === card.key) this.hidePanel();
    else this.showInfo(card);
  }

  private offer(card: InfoCard): boolean {
    if (!this.seen.has(card.key)) {
      this.seen.add(card.key);
      writeSeen(this.seen);
      this.showInfo(card);
      return true;
    }
    // read before: the ℹ️ glows for a moment, so it's easy to find again
    this.infoEl.classList.remove('is-nudging');
    void this.infoEl.offsetWidth;
    this.infoEl.classList.add('is-nudging');
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.infoEl.classList.remove('is-nudging'), NUDGE_MS);
    return false;
  }

  private showInfo(card: InfoCard) {
    this.panel(card.key, card.html(), card.opts);
    this.infoEl.setAttribute('aria-expanded', 'true');
  }

  private labelInfo() {
    const card = this.intro ?? this.guide;
    const label = card ? `About ${card.title} (I)` : 'Info (I)';
    this.infoEl.setAttribute('aria-label', label);
    this.infoEl.title = label;
  }

  /** Shows an info card. `key` avoids re-rendering identical content every frame. */
  panel(key: string, html: string, opts: PanelOpts = {}) {
    if (this.panelKey === key && !this.panelEl.hidden) return;
    this.panelKey = key;
    this.panelEl.innerHTML =
      '<button class="close" type="button" data-panel-close aria-label="Close" title="Close (Esc)">✕</button>' + html;
    this.panelEl.classList.toggle('panel-left', !!opts.left);
    this.panelEl.style.borderTopColor = opts.accent ?? '';
    this.panelEl.hidden = false;
    this.infoEl.setAttribute('aria-expanded', String(key === (this.intro ?? this.guide)?.key));
    // restart entry animation
    this.panelEl.style.animation = 'none';
    void this.panelEl.offsetWidth;
    this.panelEl.style.animation = '';
  }

  get panelElement() {
    return this.panelEl;
  }

  get panelOpenKey() {
    return this.panelEl.hidden ? '' : this.panelKey;
  }

  hidePanel() {
    this.panelEl.hidden = true;
    this.panelKey = '';
    this.infoEl.setAttribute('aria-expanded', 'false');
  }

  score(text: string | null) {
    if (text === null) {
      this.scoreEl.hidden = true;
      return;
    }
    this.scoreEl.textContent = text;
    this.scoreEl.hidden = false;
  }

  countdown(text: string | null) {
    if (text === null) {
      this.countdownEl.hidden = true;
      return;
    }
    this.countdownEl.textContent = text;
    this.countdownEl.hidden = false;
    this.countdownEl.classList.remove('pop');
    void this.countdownEl.offsetWidth;
    this.countdownEl.classList.add('pop');
  }

  rideExit(show: boolean) {
    this.rideExitEl.hidden = !show;
  }

  /** Hide driving-only chrome during rides. */
  cinematic(on: boolean) {
    document.body.classList.toggle('is-cinematic', on);
  }
}

function readSeen(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    // private mode, or blocked storage: every card is new, every visit
    return new Set();
  }
}

function writeSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // not remembered: the card just opens by itself again next time
  }
}
