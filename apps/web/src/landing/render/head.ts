// The <head> of every landing, watch and hub page: title and description, the canonical address and
// its language versions, link previews (Open Graph and X), the fonts, and one JSON-LD graph.

import { LANGS, type Lang } from '../videos.ts';
import { fontsHref, LANG_INFO } from './langs.ts';
import { esc } from './text.ts';
import type { Site } from './types.ts';

/** The same page in each language that has it (paths), plus which one is x-default. */
export type Alternates = Partial<Record<Lang, string>>;

export interface HeadOptions {
  lang: Lang;
  title: string;
  description: string;
  /** This page's path ('/', '/fr', '/videos/trailer'). */
  path: string;
  /** This page in every language that has it; the English one is also x-default. */
  alternates: Alternates;
  ogType: 'website' | 'video.other';
  image: { src: string; width: number; height: number; type: string; alt: string };
  /** Watch pages: the H.264 file, for og:video. */
  video?: { src: string; type: string; width: number; height: number };
  /** Public pages are indexed; the 404 page is not. */
  index?: boolean;
  jsonld?: object;
}

/** An absolute URL on this site ('/' stays '/', so the home page is `${url}/`). */
export const abs = (site: Site, path: string) => (/^https?:/.test(path) ? path : `${site.url}${path}`);

const ROBOTS = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1';

/** JSON for a <script> element: "</" can't end the element early. */
const scriptJson = (data: object) => JSON.stringify(data).replace(/</g, '\\u003c');

export function head(site: Site, o: HeadOptions): string {
  const info = LANG_INFO[o.lang];
  const canonical = abs(site, o.path);
  const image = abs(site, o.image.src);
  const links = LANGS.filter((l) => o.alternates[l]).map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(abs(site, o.alternates[l]!))}" />`);
  if (o.alternates.en) links.push(`<link rel="alternate" hreflang="x-default" href="${esc(abs(site, o.alternates.en))}" />`);
  const locales = LANGS.filter((l) => l !== o.lang && o.alternates[l]).map(
    (l) => `<meta property="og:locale:alternate" content="${LANG_INFO[l].ogLocale}" />`,
  );
  const video = o.video
    ? [
        `<meta property="og:video" content="${esc(abs(site, o.video.src))}" />`,
        `<meta property="og:video:secure_url" content="${esc(abs(site, o.video.src))}" />`,
        `<meta property="og:video:type" content="video/mp4" />`,
        `<meta property="og:video:width" content="${o.video.width}" />`,
        `<meta property="og:video:height" content="${o.video.height}" />`,
      ]
    : [];
  const fonts = fontsHref(o.lang);
  return [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
    `<title>${esc(o.title)}</title>`,
    `<meta name="description" content="${esc(o.description)}" />`,
    `<meta name="robots" content="${o.index === false ? 'noindex, follow' : ROBOTS}" />`,
    ...(o.index === false ? [] : [`<link rel="canonical" href="${esc(canonical)}" />`, ...links]),
    `<meta name="theme-color" content="#1d1238" />`,
    `<meta name="color-scheme" content="dark" />`,
    `<meta property="og:type" content="${o.ogType}" />`,
    `<meta property="og:site_name" content="The Funfair" />`,
    `<meta property="og:locale" content="${info.ogLocale}" />`,
    ...locales,
    `<meta property="og:url" content="${esc(canonical)}" />`,
    `<meta property="og:title" content="${esc(o.title)}" />`,
    `<meta property="og:description" content="${esc(o.description)}" />`,
    `<meta property="og:image" content="${esc(image)}" />`,
    `<meta property="og:image:type" content="${o.image.type}" />`,
    `<meta property="og:image:width" content="${o.image.width}" />`,
    `<meta property="og:image:height" content="${o.image.height}" />`,
    `<meta property="og:image:alt" content="${esc(o.image.alt)}" />`,
    ...video,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${esc(o.title)}" />`,
    `<meta name="twitter:description" content="${esc(o.description)}" />`,
    `<meta name="twitter:image" content="${esc(image)}" />`,
    `<meta name="twitter:image:alt" content="${esc(o.image.alt)}" />`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
    `<link rel="manifest" href="/site.webmanifest" />`,
    // The fonts load without holding up the first paint (the text shows at once in the fallback
    // faces, sized to match in landing.css); without JS they load the usual, blocking way.
    `<link rel="preconnect" href="https://fonts.googleapis.com" />`,
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`,
    `<link rel="stylesheet" href="${fonts}" media="print" onload="this.media='all'" />`,
    `<noscript><link rel="stylesheet" href="${fonts}" /></noscript>`,
    `<script>document.documentElement.classList.replace('no-js', 'js')</script>`,
    site.assets,
    ...(o.jsonld ? [`<script type="application/ld+json">${scriptJson(o.jsonld)}</script>`] : []),
  ].join('\n');
}
