// The landing page's only script, and it's small on purpose: the page is complete without it (every
// word, link and video is in the HTML). It adds the extras: menus that close themselves, the big play
// button on videos and chapter links that seek, the hero's silent loop, the phone's "Play free" bar,
// the share sheet and copy button, and the language suggestion. No framework, no three.js.

const root = document.documentElement;

/** localStorage may be missing or blocked (private windows, strict settings): then nothing is kept. */
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // not remembered this time
    }
  },
};

// ---------- Menus ----------
// The language menu and the phone menu are <details>, so they open without JS. Here they close on
// Escape, on a click elsewhere and after following a link, and only one is open at a time.

function menus() {
  const all = [...document.querySelectorAll<HTMLDetailsElement>('details[data-dropdown]')];
  document.addEventListener('click', (e) => {
    for (const d of all) if (d.open && !d.contains(e.target as Node)) d.open = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const d of all) {
      if (!d.open) continue;
      d.open = false;
      d.querySelector('summary')?.focus();
    }
  });
  for (const d of all) {
    d.addEventListener('click', (e) => {
      if ((e.target as Element).closest('a')) d.open = false;
    });
    d.addEventListener('toggle', () => {
      if (d.open) for (const other of all) if (other !== d) other.open = false;
    });
  }
}

// ---------- Videos ----------

/** Seek a video and play it. Before it has loaded, the time becomes where playback starts. */
function seek(video: HTMLVideoElement, seconds: number) {
  video.currentTime = seconds;
  void video.play().catch(() => {});
}

function players() {
  for (const box of document.querySelectorAll<HTMLElement>('[data-player]')) {
    const video = box.querySelector('video');
    const start = box.querySelector<HTMLButtonElement>('[data-player-start]');
    if (!video || !start) continue;
    start.hidden = false;
    start.addEventListener('click', () => {
      void video.play().catch(() => {});
      video.focus();
    });
    video.addEventListener('play', () => box.classList.add('is-playing'));
  }

  // chapter links go to the watch page at that time (?t=); on a page with the player, seek instead
  document.addEventListener('click', (e) => {
    const link = (e.target as Element).closest<HTMLAnchorElement>('a[data-seek]');
    if (!link || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const video = link.closest('section, article')?.querySelector<HTMLVideoElement>('[data-player] video');
    if (!video) return;
    e.preventDefault();
    seek(video, Number(link.dataset.seek));
    video.closest('[data-player]')?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  });

  // a watch page opened at ?t=<seconds> (a chapter link from search results) starts there
  const t = Number(new URLSearchParams(location.search).get('t'));
  const video = document.querySelector<HTMLVideoElement>('.page-watch [data-player] video');
  if (video && t > 0) video.currentTime = t;
}

// ---------- The hero's silent loop ----------
// Only when it's cheap and welcome: not with reduced motion, not on Save-Data or a slow connection,
// only after the page has loaded and while the hero is on screen. Its pause choice is remembered.

function heroLoop() {
  const video = document.querySelector<HTMLVideoElement>('[data-loop]');
  const toggle = document.querySelector<HTMLButtonElement>('[data-loop-toggle]');
  if (!video || !toggle) return;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (connection?.saveData || /2g|3g/.test(connection?.effectiveType ?? '')) return;
  const KEY = 'funfair.heroLoop';
  let paused = store.get(KEY) === 'paused';
  let onScreen = false;
  const update = () => {
    if (!paused && onScreen) void video.play().catch(() => {});
    else video.pause();
    toggle.classList.toggle('is-paused', paused);
    toggle.setAttribute('aria-label', (paused ? toggle.dataset.playLabel : toggle.dataset.pauseLabel) ?? '');
  };
  video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });
  toggle.addEventListener('click', () => {
    paused = !paused;
    store.set(KEY, paused ? 'paused' : 'playing');
    update();
  });
  const begin = () => {
    toggle.hidden = false;
    new IntersectionObserver(([entry]) => {
      onScreen = entry.isIntersecting;
      update();
    }).observe(video);
  };
  if (document.readyState === 'complete') begin();
  else addEventListener('load', begin, { once: true });
}

// ---------- The phone's "Play free" bar ----------
// It rises once the hero's own Play button has scrolled away, and steps aside for the big Play
// buttons further down and for the footer.

function playBar() {
  const bar = document.querySelector<HTMLElement>('[data-play-bar]');
  if (!bar) return;
  const targets = document.querySelectorAll('.hero-actions, .cta-ticket, .site-footer');
  const visible = new Set<Element>();
  root.classList.add('play-bar-ready');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    bar.classList.toggle('is-shown', visible.size === 0);
  });
  targets.forEach((t) => io.observe(t));
  if (!targets.length) bar.classList.add('is-shown');
}

// ---------- Card rows ----------
// On phones the card lists scroll sideways; while one does, it can take keyboard focus to scroll.

function scrollers() {
  const lists = [...document.querySelectorAll<HTMLElement>('[data-scroller]')];
  if (!lists.length) return;
  const update = () => {
    for (const list of lists) {
      if (list.scrollWidth > list.clientWidth + 1) {
        list.tabIndex = 0;
        const heading = list.closest('[aria-labelledby]')?.getAttribute('aria-labelledby');
        if (heading) list.setAttribute('aria-labelledby', heading);
      } else {
        list.removeAttribute('tabindex');
        list.removeAttribute('aria-labelledby');
      }
    }
  };
  update();
  let frame = 0;
  addEventListener('resize', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  });
}

// ---------- Share ----------

function share() {
  const status = document.querySelector<HTMLElement>('.share-status');
  const native = document.querySelector<HTMLElement>('[data-share-native]');
  const nativeButton = native?.querySelector<HTMLButtonElement>('button');
  if (native && nativeButton && typeof navigator.share === 'function') {
    native.hidden = false;
    nativeButton.addEventListener('click', () => {
      void navigator.share({ title: document.title, text: nativeButton.dataset.shareText, url: nativeButton.dataset.shareUrl }).catch(() => {});
    });
  }
  const copy = document.querySelector<HTMLElement>('[data-share-copy]');
  const copyButton = copy?.querySelector<HTMLButtonElement>('button');
  if (copy && copyButton && navigator.clipboard) {
    copy.hidden = false;
    copyButton.addEventListener('click', () => {
      void navigator.clipboard.writeText(copyButton.dataset.copyUrl ?? location.href).then(() => {
        if (status) status.textContent = copyButton.dataset.copied ?? '';
        copyButton.classList.add('is-done');
        setTimeout(() => {
          if (status) status.textContent = '';
          copyButton.classList.remove('is-done');
        }, 2500);
      });
    });
  }
}

// ---------- The language suggestion ----------
// If the visitor's browser prefers another language we have, a small banner offers that version. It
// never redirects (search engines and people both get the page they asked for), it floats over the
// page (nothing shifts), and "No thanks" is remembered.

interface Offer {
  lang: string;
  dir: string;
  href: string;
  text: string;
  go: string;
  dismiss: string;
}

function languageOffer() {
  const data = document.getElementById('language-offers');
  const KEY = 'funfair.languageOffer';
  if (!data || store.get(KEY) === 'dismissed') return;
  const offers = JSON.parse(data.textContent ?? '[]') as Offer[];
  const preferred = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => l.slice(0, 2).toLowerCase());
  // the first of the visitor's languages that we have: if it's this page's own, there's nothing to offer
  const first = preferred.find((l) => l === root.lang || offers.some((o) => o.lang === l));
  const offer = offers.find((o) => o.lang === first);
  if (!offer) return;

  const banner = document.createElement('aside');
  // data-nosnippet is on the element before it's in the page, so search snippets never quote it
  banner.setAttribute('data-nosnippet', '');
  banner.className = 'lang-offer';
  banner.lang = offer.lang;
  banner.dir = offer.dir;
  banner.setAttribute('aria-label', offer.go);
  const text = document.createElement('p');
  text.textContent = offer.text;
  const go = document.createElement('a');
  go.className = 'btn btn-primary btn-small';
  go.href = offer.href;
  go.hreflang = offer.lang;
  go.textContent = offer.go;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-ghost btn-small';
  close.textContent = offer.dismiss;
  close.addEventListener('click', () => {
    store.set(KEY, 'dismissed');
    banner.remove();
  });
  const actions = document.createElement('div');
  actions.className = 'lang-offer-actions';
  actions.append(go, close);
  banner.append(text, actions);
  document.body.append(banner);
}

/**
 * Smooth scrolling for the menu's links, switched on only once the page has loaded: a shared link
 * such as /#faq then opens straight at its section instead of gliding down the whole page.
 */
function smoothLinks() {
  const on = () => setTimeout(() => root.classList.add('smooth'), 100);
  if (document.readyState === 'complete') on();
  else addEventListener('load', on, { once: true });
}

menus();
players();
heroLoop();
playBar();
scrollers();
share();
languageOffer();
smoothLinks();
