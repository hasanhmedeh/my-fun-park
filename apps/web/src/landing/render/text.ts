// Turning content strings into HTML, plain text or Markdown. Content may use three bits of markup:
//   [W] [A] [S] [D]      keycaps (neighbouring ones stay together, left to right, even on /ar)
//   [label](href)        a link
//   **words**            bold
// Everything else is text and is escaped here, so a translator can't break the page by accident.

import type { Lang } from '../videos.ts';

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape text for HTML (content and attribute values alike). */
export const esc = (text: string) => text.replace(/[&<>"']/g, (c) => ENTITIES[c]);

/** One link, one run of keycaps, or one bold run. */
const MARKUP = /\[([^\]\n]+)\]\(([^)\s]+)\)|(\[[^\]\n]+\](?:\s+\[[^\]\n]+\])*)|\*\*([^*\n]+)\*\*/g;
const KEY = /\[([^\]\n]+)\]/g;

/**
 * Escaped text on its way into the page: typeset, with the brand kept in English in every language.
 * On /fr and /ar the brand is marked as English (so screen readers say it right, and translation
 * tools leave it alone); on /ar every Latin run is also isolated (see isolate()).
 */
function words(html: string, lang: Lang) {
  html = typeset(html, lang);
  if (lang === 'en') return html;
  if (lang === 'ar') return isolate(html);
  return html.replaceAll('The Funfair', '<span lang="en" translate="no">The Funfair</span>');
}

/**
 * In escaped Arabic text: a minus sign with its number ("−1"), or a run of Latin words ("Sky Falcon",
 * "Nebula 360", "A320neo", "Creators&#39; Valley", an address). Never starts inside an entity.
 */
const LATIN_WORD = String.raw`[A-Za-z\d]+(?:(?:[.@’-]|&#39;)[A-Za-z\d]+)*(?:&#39;(?= [A-Za-z]))?`;
const ISOLATE = new RegExp(String.raw`−\d[\d.]*|(?<![\w&#])(?=[A-Za-z])${LATIN_WORD}(?: ${LATIN_WORD})*`, 'g');

/**
 * /ar: each Latin run sits in its own <bdi>, marked as English, so a neighbouring number, comma or
 * another name can't reorder it ("Sky Falcon وGiant Wheel" keeps its order), and the CSS keeps it on
 * one line. A negative number is isolated left to right, so its sign stays in front.
 */
function isolate(html: string) {
  return html.replace(ISOLATE, (run) => {
    if (run.startsWith('−')) return `<bdi dir="ltr">${run}</bdi>`;
    return run === 'The Funfair' ? `<bdi lang="en" translate="no">${run}</bdi>` : `<bdi lang="en">${run}</bdi>`;
  });
}

/** A no-break space (U+00A0). */
const NBSP = String.fromCharCode(0xa0);

/** Units that never start a line on their own ("3,500 m", "250 km/h", "5.5 G"). */
const NUMBER_UNIT = /(\d) (?=(?:km\/h|km|m|s|G|ft|kt|h|%)(?![\p{L}\d]))/gu;

/**
 * Small typesetting in the HTML (never in meta tags or structured data): a number keeps its unit on
 * the same line, and French gets its non-breaking space before : ; ! ? and inside « ». In Arabic a
 * number keeps the word after it ("20 تذكرة", "250 كم/س").
 */
function typeset(html: string, lang: Lang) {
  html = html.replace(NUMBER_UNIT, `$1${NBSP}`);
  if (lang === 'fr') html = html.replace(/ ([:;!?»])/g, `${NBSP}$1`).replace(/« /g, `«${NBSP}`);
  if (lang === 'ar') html = html.replace(/(\d) (?=\p{Script=Arabic})/gu, `$1${NBSP}`);
  return html;
}

/** Inline HTML from a content string. */
export function inline(text: string, lang: Lang): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MARKUP)) {
    out += words(esc(text.slice(last, m.index)), lang);
    const [, label, href, keys, bold] = m;
    if (label !== undefined) {
      const external = /^https?:/.test(href);
      out += `<a href="${esc(href)}"${external ? ' rel="noopener"' : ''}>${words(esc(label), lang)}</a>`;
    } else if (keys !== undefined) {
      const caps = [...keys.matchAll(KEY)].map((k) => `<kbd>${esc(k[1])}</kbd>`).join(' ');
      out += `<span class="keys" dir="ltr">${caps}</span>`;
    } else {
      out += `<strong>${words(esc(bold), lang)}</strong>`;
    }
    last = m.index + m[0].length;
  }
  return out + words(esc(text.slice(last)), lang);
}

/**
 * A string that takes no markup (video titles and descriptions, transcript lines), escaped. On /ar it
 * is also typeset and its Latin names isolated, as inline() does, so "Thunder Loop" can't split.
 */
export const escText = (text: string, lang: Lang) => (lang === 'ar' ? words(esc(text), lang) : esc(text));

/** Plain text from a content string: link labels, key names, no markup (structured data, meta tags). */
export function plain(text: string): string {
  return text.replace(MARKUP, (_all, label?: string, _href?: string, keys?: string, bold?: string) => {
    if (label !== undefined) return label;
    if (keys !== undefined) return [...keys.matchAll(KEY)].map((k) => k[1]).join(' ');
    return bold ?? '';
  });
}

/** Markdown from a content string (llms-full.txt): links stay links, keycaps become code. */
export function markdown(text: string): string {
  return text.replace(MARKUP, (_all, label?: string, href?: string, keys?: string, bold?: string) => {
    if (label !== undefined) return `[${label}](${href})`;
    if (keys !== undefined) return [...keys.matchAll(KEY)].map((k) => `\`${k[1]}\``).join(' ');
    return `**${bold}**`;
  });
}

/** Paragraphs split on blank lines (the videos' long descriptions). */
export const paragraphs = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

/** 92 → "1:32". */
export function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 92 → "PT1M32S" (ISO 8601, for structured data). */
export function isoDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  return `PT${m ? `${m}M` : ''}${s % 60 || !m ? `${s % 60}S` : ''}`;
}

/** A YYYY-MM-DD date written out in the page's language ("22 October 2026"; Arabic keeps Western digits). */
export function longDate(date: string, lang: Lang): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d));
}
