// Pictures and videos: the stills as responsive <picture>s, the trailer and tutorials as native
// <video> players, and the bits of media.json the pages need (which videos are filmed, their words,
// their posters). A video counts as filmed when media.json has it and its words exist: only then does
// anything point at its files.

import { LANGS, VIDEOS, type Lang, type VideoEntry, type VideoId, type VideoMedia, type VideoText } from '../videos.ts';
import { icon } from './icons.ts';
import { LANG_INFO, localPath } from './langs.ts';
import { clock, esc, isoDuration } from './text.ts';
import type { Site } from './types.ts';

/**
 * The still that stands in for a video's poster until it's filmed (the look tutorial has none yet).
 * The trailer gets the drone's view over the whole park, so it doesn't repeat the hero's picture.
 */
export const VIDEO_STILL: Record<VideoId, string> = {
  trailer: 'drone',
  'getting-started': 'ferris',
  'tickets-and-account': 'ducks',
  'thrill-rides': 'falcon',
  'games-and-races': 'speedway',
  'coaster-workshop': 'workshop',
  'fly-to-palm-cay': 'a320',
  'your-look': '',
};

/** A video's words in a language, falling back to English until the translation lands. */
export const videoText = (site: Site, lang: Lang, id: VideoId): VideoText | undefined => site.videoText[lang][id] ?? site.videoText.en[id];

/** The videos that have been filmed, in page order. */
export const filmed = (site: Site): VideoEntry[] => VIDEOS.filter((v) => site.media.videos[v.id] && site.videoText.en[v.id]);

export const watchPath = (lang: Lang, slug: string) => localPath(lang, `/videos/${slug}`);
export const hubPath = (lang: Lang) => localPath(lang, '/videos');

/** The poster closest to 1280 px wide (the attribute takes one file). */
export function poster(media: Pick<VideoMedia, 'poster'>) {
  return [...media.poster].sort((a, b) => Math.abs(a.width - 1280) - Math.abs(b.width - 1280))[0];
}

/** The most widely playable file (H.264), for the download link and the structured data. */
export function playable(media: Pick<VideoMedia, 'sources'>) {
  return media.sources.find((s) => s.type.includes('avc1')) ?? media.sources[media.sources.length - 1];
}

export interface PictureOptions {
  /** The sizes attribute: how wide the picture shows at each breakpoint. */
  sizes: string;
  /** The page's main picture: fetched first, never lazy. */
  priority?: boolean;
  cls?: string;
}

/**
 * A still as AVIF then WebP at every width, with its intrinsic size (no layout shift). A still that
 * isn't on disk becomes a gradient panel of the same shape, so the page never shows a broken image.
 */
export function picture(site: Site, name: string | undefined, alt: string, opts: PictureOptions): string {
  const still = name ? site.stills[name] : undefined;
  const cls = ['still', opts.cls].filter(Boolean).join(' ');
  if (!still) return `<div class="${cls} still-missing" aria-hidden="true"></div>`;
  const url = (w: number, f: string) => `/media/stills/${still.name}-${w}.${f}`;
  const sources = still.formats
    .map((f) => `<source type="image/${f}" srcset="${still.widths.map((w) => `${url(w, f)} ${w}w`).join(', ')}" sizes="${opts.sizes}" />`)
    .join('');
  const fallbackWidth = still.widths.find((w) => w >= 1280) ?? still.widths[still.widths.length - 1];
  const fallback = url(fallbackWidth, still.formats.includes('webp') ? 'webp' : still.formats[0]);
  const loading = opts.priority ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"';
  return `<picture class="${cls}">${sources}<img src="${fallback}" width="${still.width}" height="${still.height}" alt="${esc(alt)}" ${loading} /></picture>`;
}

/**
 * A filmed video as a native player: in the HTML from the start (so search engines can see it and it
 * plays without JS), with preload="none" so nothing downloads before you press play. JS adds the big
 * play button over the poster and makes the chapter links seek. The captions track in the page's
 * language plays by default.
 */
export function player(media: VideoMedia, text: VideoText, lang: Lang, ui: Site['content'][Lang]['ui']): string {
  const first = media.sources[0];
  const still = poster(media);
  const sources = media.sources.map((s) => `<source src="${esc(s.src)}" type="${esc(s.type)}" />`).join('');
  const tracks = LANGS.filter((l) => media.captions[l])
    .map((l) => {
      const kind = l === 'en' ? 'captions' : 'subtitles';
      return `<track kind="${kind}" srclang="${l}" label="${LANG_INFO[l].name}" src="${esc(media.captions[l]!)}"${l === lang ? ' default' : ''} />`;
    })
    .join('');
  const download = playable(media);
  return `<div class="player" data-player>
<video class="player-video" controls preload="none" playsinline width="${first.width}" height="${first.height}" poster="${esc(still.src)}">${sources}${tracks}<a href="${esc(download.src)}">${esc(ui.download)}</a></video>
<button type="button" class="player-start" data-player-start hidden aria-label="${esc(`${ui.playVideo}: ${text.title}`)}">${icon('play')}</button>
</div>`;
}

/** The chapter list: links to the watch page at that time (?t=), which JS turns into seeks in place. */
export function chapters(media: VideoMedia, text: VideoText, href: string): string {
  const items = media.chapters
    .filter((c) => text.chapters[c.id])
    .map(
      (c) =>
        `<li><a href="${esc(href)}?t=${Math.floor(c.start)}" data-seek="${c.start}"><time datetime="${isoDuration(c.start)}">${clock(c.start)}</time> <span>${esc(text.chapters[c.id])}</span></a></li>`,
    )
    .join('');
  return items ? `<ol class="chapters">${items}</ol>` : '';
}

/** "Watch on YouTube", once the video is uploaded there. */
export const youtubeLink = (media: VideoMedia, ui: Site['content'][Lang]['ui']) =>
  media.youtubeId
    ? `<a class="youtube-link" href="https://www.youtube.com/watch?v=${encodeURIComponent(media.youtubeId)}" rel="noopener">${esc(ui.youtube)} ${icon('arrow')}</a>`
    : '';

/**
 * The hero's silent loop: decorative, muted, never preloaded. JS starts it after the page has loaded,
 * only when the visitor hasn't asked for less motion or less data, and shows its pause button.
 */
export function heroLoop(site: Site, ui: Site['content'][Lang]['ui']): string {
  const loop = site.media.loop;
  if (!loop?.sources.length) return '';
  const sources = loop.sources.map((s) => `<source src="${esc(s.src)}" type="${esc(s.type)}" />`).join('');
  const first = loop.sources[0];
  return `<video class="hero-loop" muted loop playsinline preload="none" aria-hidden="true" tabindex="-1" width="${first.width}" height="${first.height}" data-loop>${sources}</video>
<button type="button" class="loop-toggle" data-loop-toggle hidden aria-pressed="false" data-play-label="${esc(ui.playLoop)}" data-pause-label="${esc(ui.pauseLoop)}" aria-label="${esc(ui.pauseLoop)}">${icon('pause')}</button>`;
}

/** A duration for people: "1:32 min", or "45 s" under a minute (number and unit on one line). */
export const duration = (seconds: number, ui: Site['content'][Lang]['ui']) =>
  Math.round(seconds) >= 60 ? `${clock(seconds)}\u00a0${ui.minutes}` : `${Math.round(seconds)}\u00a0${ui.seconds}`;
