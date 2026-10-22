// The film's own pictures, made as HTML pages and drawn by the same headless Chrome that films the
// game, so the type is the browser's (real kerning, Arabic shaping, emoji): the title over the
// opening shot, the tutorials' opening sting, the end card, the YouTube thumbnail and the Open
// Graph images. Every one is language-neutral (the logo, icons, the site's address) unless it's
// given words to show.
//
// Each card is a function returning { html, css } for a layer of the film's (the director's
// overlay, over the game), or a whole page (page()). The animations are CSS, gated on a `play`
// class: the film clock (clock.mjs) pauses them and moves them on one frame at a time, so a card
// animates exactly the same on every render.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** apps/web, where the local fonts, the favicon and the stills are. */
export const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
/** The base URL card pages are opened at, so their relative links reach apps/web's files. */
export const WEB_URL = `${pathToFileURL(WEB).href}/`;

/** The park's colours (src/styles.css :root). */
export const INK = '#1d1238';
export const CREAM = '#fff5e3';
export const CANDY = '#ff4d6d';
export const MUSTARD = '#ffc23d';
export const TEAL = '#2ec4b6';

/**
 * The fonts: Lilita One and DM Sans as the game loads them (Google Fonts), the repo's own copy of
 * Lilita One if that can't be reached, and for Arabic Lalezar and Readex Pro (research.md 5.4),
 * then whatever the system has (Segoe UI and Tahoma both shape Arabic).
 */
export const FONTS_HEAD = `
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,700;9..40,800&family=Lilita+One&family=Lalezar&family=Readex+Pro:wght@400;600&display=block" />
  <style>@font-face { font-family: 'Lilita One Local'; src: url('scripts/LilitaOne-Regular.ttf') format('truetype'); }</style>`;
/**
 * Page code: true if Google Fonts' stylesheet came. Without the network (offline, a sandbox) the
 * cards fall back to the repo's Lilita One and the system's fonts (Segoe UI for DM Sans and Arabic).
 */
export const FONTS_LOADED = `[...document.styleSheets].some((s) => s.href?.startsWith('https://fonts.googleapis.com/'))`;
/** Says so once a run, when the cards are drawn without the web fonts. */
let fontsWarned = false;
export async function checkFonts(page) {
  if (fontsWarned || (await page.evaluate(FONTS_LOADED))) return;
  fontsWarned = true;
  console.warn('  Google Fonts could not be reached: the cards use fallback fonts (Segoe UI for DM Sans and Arabic). Render the final films online.');
}
export const DISPLAY = `'Lilita One', 'Lilita One Local', 'Arial Rounded MT Bold', system-ui, sans-serif`;
export const BODY = `'DM Sans', system-ui, 'Segoe UI', sans-serif`;
export const DISPLAY_AR = `'Lalezar', 'Lilita One', 'Lilita One Local', 'Segoe UI', Tahoma, sans-serif`;
export const BODY_AR = `'Readex Pro', 'DM Sans', 'Segoe UI', Tahoma, sans-serif`;

/** The park's tent (public/favicon.svg), drawn inline so it scales sharply. */
export const TENT = readFileSync(resolve(WEB, 'public/favicon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '').trim();

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The wordmark: the tent over "The Funfair", in Lilita One with the intro card's mustard shadow. */
function logo(cls = '') {
  return `<div class="logo ${cls}"><div class="tent">${TENT}</div><div class="word">The Funfair</div></div>`;
}
const LOGO_CSS = `
  .logo { display: flex; flex-direction: column; align-items: center; gap: 0.12em; }
  .logo .tent svg { width: 1.15em; height: 1.15em; display: block; filter: drop-shadow(0 0.06em 0.12em rgba(0,0,0,0.45)); }
  .logo .word { font: 400 1em/0.95 ${DISPLAY}; color: ${CREAM}; letter-spacing: 0.01em; white-space: nowrap;
    -webkit-text-stroke: 0.035em ${INK}; paint-order: stroke fill; text-shadow: 0.06em 0.07em 0 ${MUSTARD}, 0.06em 0.1em 0.25em rgba(0,0,0,0.5); }
  .logo.row { flex-direction: row; gap: 0.3em; }
  .logo.row .tent svg { width: 0.95em; height: 0.95em; }`;

// "Free in your browser" without a word: a browser window with a play button, a download crossed
// out (nothing to install), and a price tag at 0.
const ICON_BROWSER = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="6" y="10" width="52" height="44" rx="7" fill="none" stroke="currentColor" stroke-width="5"/><path d="M6 21h52" stroke="currentColor" stroke-width="5"/><circle cx="13" cy="15.5" r="1.9" fill="currentColor"/><circle cx="19" cy="15.5" r="1.9" fill="currentColor"/><path d="M27 29v17l14-8.5z" fill="${CANDY}" stroke="${CANDY}" stroke-width="3" stroke-linejoin="round"/></svg>`;
const ICON_NO_DOWNLOAD = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 8v28M20 25l12 12 12-12M12 44v8h40v-8" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 10l44 44" stroke="${CANDY}" stroke-width="6" stroke-linecap="round"/></svg>`;
const ICON_FREE = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M33 7h20a4 4 0 0 1 4 4v20L31 57a4 4 0 0 1-5.7 0L7 38.7a4 4 0 0 1 0-5.7z" fill="none" stroke="currentColor" stroke-width="5" stroke-linejoin="round"/><circle cx="46" cy="18" r="4" fill="currentColor"/><text x="31" y="42" text-anchor="middle" font-family="Lilita One, Lilita One Local, Arial Rounded MT Bold, sans-serif" font-size="25" fill="${CANDY}" transform="rotate(-45 31 34)">0</text></svg>`;
export const FREE_ICONS = [ICON_BROWSER, ICON_NO_DOWNLOAD, ICON_FREE];

/**
 * The trailer's opening title, over the first shot: the tent drops in, the wordmark pops up, and
 * after `seconds` (minus its fade) they go. A layer for the director's overlay().
 */
export function titleOverlay({ seconds = 5.7, delay = 0.5 } = {}) {
  const out = Math.max(delay + 1.5, seconds - 0.9);
  return {
    html: `<div class="t-wrap"><div class="t-shade"></div>${logo('t-logo')}</div>`,
    css: `${LOGO_CSS}
      #film-overlay { position: fixed; inset: 0; z-index: 2147483100; pointer-events: none; }
      .t-wrap { position: absolute; inset: 0; display: grid; place-items: center; }
      .t-shade { position: absolute; inset: 0; background: radial-gradient(ellipse 55% 45% at 50% 50%, rgba(29,18,56,0.45), rgba(29,18,56,0) 70%); opacity: 0; }
      .t-logo { font-size: min(13vh, 11vw); position: relative; }
      .t-logo .tent, .t-logo .word { opacity: 0; }
      .play .t-shade { animation: t-in 0.8s ${delay}s ease-out forwards, t-out 0.8s ${out}s ease-in forwards; }
      .play .t-logo .tent { animation: t-drop 0.7s ${delay}s cubic-bezier(.2,1.6,.4,1) forwards, t-out 0.8s ${out}s ease-in forwards; }
      .play .t-logo .word { animation: t-pop 0.8s ${delay + 0.25}s cubic-bezier(.2,1.4,.4,1) forwards, t-out 0.8s ${out}s ease-in forwards; }
      @keyframes t-in { to { opacity: 1; } }
      @keyframes t-drop { from { opacity: 0; transform: translateY(-0.6em) scale(0.6); } to { opacity: 1; transform: none; } }
      @keyframes t-pop { from { opacity: 0; transform: scale(0.7); filter: blur(0.06em); } to { opacity: 1; transform: none; filter: none; } }
      @keyframes t-out { from { opacity: 1; } to { opacity: 0; transform: scale(1.04); } }`,
  };
}

/**
 * The tutorials' opening sting: the logo and the tutorial's own icon (an emoji: the same in every
 * language) on the park's colours, over `still` (a picture under apps/web, or none).
 */
export function stingCard({ icon = '🎪', still = null, seconds = 2.6 } = {}) {
  return {
    html: `<div class="bg">${still ? `<img src="${escape(still)}" alt="">` : ''}</div><div class="shade"></div><div class="s-wrap">${logo('s-logo')}<div class="s-icon">${icon}</div></div>`,
    css: `${LOGO_CSS}${PAGE_BG_CSS}
      .s-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4vh; }
      .s-logo { font-size: min(11vh, 10vw); opacity: 0; }
      .s-icon { font: 400 min(15vh, 14vw)/1 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif; opacity: 0; filter: drop-shadow(0 1vh 2vh rgba(0,0,0,0.4)); }
      .play .s-logo { animation: pop 0.6s 0.15s cubic-bezier(.2,1.4,.4,1) forwards; }
      .play .s-icon { animation: pop 0.6s 0.55s cubic-bezier(.2,1.6,.4,1) forwards; }
      .play .bg img { animation: drift ${seconds}s linear forwards; }
      @keyframes pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: none; } }
      @keyframes drift { from { transform: scale(1.06); } to { transform: scale(1.12); } }`,
  };
}

/**
 * The end card: the logo, "free in your browser" as three icons, and the site's address. `layout`
 * 'site' centres it all; 'youtube' keeps it to the left half, leaving the right for YouTube's end
 * screen (a video or two and the subscribe button).
 */
export function endCard({ domain, still = null, layout = 'site' } = {}) {
  const icons = FREE_ICONS.map((svg, i) => `<div class="e-icon" style="--i:${i}">${svg}</div>`).join('');
  return {
    html: `<div class="bg">${still ? `<img src="${escape(still)}" alt="">` : ''}</div><div class="shade"></div><div class="e-wrap e-${layout}">${logo('e-logo')}<div class="e-icons">${icons}</div><div class="e-domain">${escape(domain)}</div></div>`,
    css: `${LOGO_CSS}${PAGE_BG_CSS}
      .e-wrap { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 5vh; }
      .e-wrap.e-youtube { right: 50%; }
      .e-logo { font-size: min(12vh, 9vw); opacity: 0; }
      .e-youtube .e-logo { font-size: min(10vh, 6.4vw); }
      .e-icons { display: flex; gap: min(4vh, 3vw); }
      .e-icon { width: min(13vh, 12vw); height: min(13vh, 12vw); border-radius: 50%; background: ${CREAM}; color: ${INK}; display: grid; place-items: center; box-shadow: 0 0.8vh 0 ${MUSTARD}, 0 1.6vh 3vh rgba(0,0,0,0.45); opacity: 0; }
      .e-youtube .e-icon { width: min(11vh, 8vw); height: min(11vh, 8vw); }
      .e-icon svg { width: 60%; height: 60%; }
      .e-domain { font: 800 min(4.6vh, 4vw)/1 ${BODY}; color: ${INK}; background: ${CREAM}; padding: 1.6vh 3.2vh; border-radius: 99px; letter-spacing: 0.02em; box-shadow: 0 0.6vh 0 ${CANDY}, 0 1.4vh 3vh rgba(0,0,0,0.45); opacity: 0; }
      .e-youtube .e-domain { font-size: min(3.8vh, 2.8vw); }
      .play .e-logo { animation: pop 0.7s 0.2s cubic-bezier(.2,1.4,.4,1) forwards; }
      .play .e-icon { animation: pop 0.55s calc(0.75s + var(--i) * 0.18s) cubic-bezier(.2,1.6,.4,1) forwards; }
      .play .e-domain { animation: rise 0.6s 1.45s ease-out forwards; }
      .play .bg img { animation: drift 12s linear forwards; }
      @keyframes pop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: none; } }
      @keyframes rise { from { opacity: 0; transform: translateY(2vh); } to { opacity: 1; transform: none; } }
      @keyframes drift { from { transform: scale(1.05); } to { transform: scale(1.1); } }`,
  };
}

/** A card page's background: a still (darkened, blurred a touch) or the park's night-ink gradient. */
const PAGE_BG_CSS = `
  .bg { position: absolute; inset: 0; overflow: hidden; background: radial-gradient(ellipse at 50% 30%, #3a2670, ${INK} 70%); }
  .bg img { width: 100%; height: 100%; object-fit: cover; filter: blur(0.35vh) saturate(1.1); transform: scale(1.06); }
  .shade { position: absolute; inset: 0; background: radial-gradient(ellipse 70% 60% at 50% 45%, rgba(29,18,56,0.35), rgba(29,18,56,0.82)); }`;

/** A whole page for a card: `width` × `height` CSS pixels, the fonts in, `dir` and `lang` on <html>. */
export function page({ html, css }, { width, height, lang = 'en', dir = 'ltr' } = {}) {
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8">${FONTS_HEAD}<style>
    html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; background: ${INK}; }
    body { position: relative; -webkit-font-smoothing: antialiased; }
    ${css}
  </style></head><body>${html}</body></html>`;
}

/**
 * The YouTube thumbnail: a frame of the video (`image`, a file URL or a path under apps/web) with
 * a few bold words (`words`, short English, or none for a language-neutral one) and the logo.
 */
export function thumbnail({ image, words = '', kicker = '' }) {
  return {
    html: `<div class="bg th-bg"><img src="${escape(image)}" alt=""></div><div class="th-shade"></div>${logo('row th-logo')}${
      words ? `<div class="th-words">${kicker ? `<span class="th-kicker">${escape(kicker)}</span>` : ''}${escape(words)}</div>` : ''
    }`,
    css: `${LOGO_CSS}${PAGE_BG_CSS}
      .th-bg img { filter: saturate(1.25) contrast(1.06); transform: none; }
      .th-shade { position: absolute; inset: 0; background: linear-gradient(100deg, rgba(29,18,56,0.88) 0%, rgba(29,18,56,0.55) 38%, rgba(29,18,56,0) 62%); }
      .th-logo { position: absolute; left: 4.5%; top: 6%; font-size: 7.5vh; }
      .th-words { position: absolute; left: 4.5%; bottom: 9%; width: 58%; font: 400 15vh/0.92 ${DISPLAY}; color: ${CREAM}; text-transform: uppercase;
        -webkit-text-stroke: 0.05em ${INK}; paint-order: stroke fill; text-shadow: 0.05em 0.06em 0 ${CANDY}, 0 0.1em 0.3em rgba(0,0,0,0.5); }
      .th-kicker { display: block; font: 800 5vh/1.2 ${BODY}; color: ${INK}; background: ${MUSTARD}; -webkit-text-stroke: 0; text-shadow: none; padding: 0.4vh 1.6vh; border-radius: 1vh; width: fit-content; margin-bottom: 2vh; text-transform: none; }`,
  };
}

/**
 * The Open Graph image (1200 × 630): the hero still, the logo, and the page's headline and
 * tagline in its language (`dir` 'rtl' for Arabic: the type and the layout mirror). A headline
 * that is the park's name is drawn as the wordmark itself, rather than under a second copy of it.
 */
export function ogImage({ image, headline, tagline, lang = 'en', dir = 'ltr' }) {
  const rtl = dir === 'rtl';
  const display = lang === 'ar' ? DISPLAY_AR : DISPLAY;
  const body = lang === 'ar' ? BODY_AR : BODY;
  const brand = headline.trim() === 'The Funfair';
  const side = rtl ? 'right' : 'left';
  return {
    html: `<div class="bg og-bg"><img src="${escape(image)}" alt=""></div><div class="og-shade"></div>${brand ? '' : logo('row og-logo')}<div class="og-text">${
      brand ? logo('row og-brand') : `<h1>${escape(headline)}</h1>`
    }<p><span>${escape(tagline)}</span></p></div>`,
    css: `${LOGO_CSS}${PAGE_BG_CSS}
      .og-bg img { filter: saturate(1.15); transform: none; }
      .og-shade { position: absolute; inset: 0; background: linear-gradient(${rtl ? '260deg' : '100deg'}, rgba(29,18,56,0.92) 0%, rgba(29,18,56,0.7) 42%, rgba(29,18,56,0.1) 75%); }
      .og-logo { position: absolute; top: 46px; ${side}: 56px; font-size: 46px; direction: ltr; }
      .og-text { position: absolute; ${side}: 56px; bottom: 64px; width: 660px; text-align: ${side}; display: flex; flex-direction: column; align-items: flex-start; }
      .og-brand { font-size: 92px; direction: ltr; margin: 0 0 30px; }
      .og-text h1 { margin: 0 0 22px; font: 400 ${lang === 'ar' ? 64 : 66}px/${lang === 'ar' ? 1.25 : 1.02} ${display}; color: ${CREAM}; ${lang === 'ar' ? '' : 'letter-spacing: 0.005em;'} text-wrap: balance;
        text-shadow: 0 4px 0 ${INK}, 0 6px 24px rgba(0,0,0,0.5); }
      .og-text p { margin: 0; max-width: 600px; font: ${lang === 'ar' ? 600 : 700} ${lang === 'ar' ? 30 : 31}px/1.8 ${body}; text-wrap: balance; }
      .og-text p span { color: ${INK}; background: ${MUSTARD}; padding: 5px 18px; border-radius: 12px; box-shadow: 0 5px 0 ${CANDY}; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`,
  };
}
