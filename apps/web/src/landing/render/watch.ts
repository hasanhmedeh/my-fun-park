// The video pages: a watch page per filmed video and language (/videos/<slug>, /fr/videos/<slug>,
// /ar/videos/<slug>), and the hub that lists them (/videos). A watch page's main purpose is its one
// video, so the player comes first, then the words that make the page worth reading: the long
// description, the steps, the chapters, the transcript, and the other videos.

import { LANGS, VIDEOS, type Lang, type VideoEntry } from '../videos.ts';
import type { Alternates } from './head.ts';
import { icon } from './icons.ts';
import { hubGraph, watchGraph } from './jsonld.ts';
import { LANG_INFO, localPath } from './langs.ts';
import { videoCard } from './landing.ts';
import { page, PLAY_HREF } from './layout.ts';
import { chapters, duration, filmed, hubPath, player, playable, poster, videoText, watchPath, youtubeLink } from './media.ts';
import { esc, escText, inline, longDate, paragraphs, plain } from './text.ts';
import type { Site } from './types.ts';

/** The page title: the video's own, with the site's name when there's room (≤ 60 characters). */
function title(text: string) {
  if (text.includes('The Funfair')) return text;
  const long = `${text} · The Funfair`;
  return long.length <= 60 ? long : text;
}

const breadcrumb = (site: Site, lang: Lang, items: [string, string | null][]) =>
  `<nav class="breadcrumb" aria-label="${esc(site.content[lang].watch.breadcrumb)}"><ol>${items
    .map(([label, href]) => (href ? `<li><a href="${href}">${inline(label, lang)}</a></li>` : `<li aria-current="page">${inline(label, lang)}</li>`))
    .join('')}</ol></nav>`;

const watchAlternates = (slug: string): Alternates => Object.fromEntries(LANGS.map((l) => [l, watchPath(l, slug)]));

export function watchPage(site: Site, lang: Lang, entry: VideoEntry): string {
  const c = site.content[lang];
  const media = site.media.videos[entry.id]!;
  const text = videoText(site, lang, entry.id)!;
  const href = watchPath(lang, entry.slug);
  const file = playable(media);
  const still = poster(media);
  const list = chapters(media, text, href);
  const transcript = Object.values(text.captions);
  const others = filmed(site).filter((v) => v.id !== entry.id);
  const main = `<article class="watch" aria-labelledby="watch-title">
<div class="wrap">
${breadcrumb(site, lang, [
  ['The Funfair', localPath(lang)],
  [c.watch.videos, hubPath(lang)],
  [text.title, null],
])}
<h1 id="watch-title">${escText(text.title, lang)}</h1>
<div class="screen">${player(media, text, lang, c.ui)}</div>
<div class="watch-grid">
<div class="watch-main">
<p class="watch-meta"><span>${icon('clock')} ${esc(duration(media.duration, c.ui))}</span><span><time datetime="${media.uploadDate}">${longDate(media.uploadDate, lang)}</time></span>${youtubeLink(media, c.ui)}</p>
${paragraphs(text.longDescription)
  .map((p) => `<p>${inline(p, lang)}</p>`)
  .join('\n')}
${text.steps?.length ? `<h2>${esc(c.watch.steps)}</h2><ol class="steps">${text.steps.map((s) => `<li><span>${inline(s, lang)}</span></li>`).join('')}</ol>` : ''}
${list ? `<h2>${esc(c.watch.inThisVideo)}</h2>${list}` : ''}
${transcript.length ? `<h2>${esc(c.watch.transcript)}</h2><div class="transcript">${transcript.map((line) => `<p>${escText(plain(line), lang)}</p>`).join('')}</div>` : ''}
</div>
<aside class="watch-aside">
<div class="cta-ticket cta-small">
<p class="kicker">${icon('ticket')}<span>${esc(c.hero.kicker)}</span></p>
<p class="cta-heading">${inline(c.cta.heading, lang)}</p>
<p>${inline(c.cta.text, lang)}</p>
<a class="btn btn-primary btn-big" href="${PLAY_HREF}">${icon('play')}<span>${esc(c.cta.button)}</span></a>
</div>
</aside>
</div>
${others.length ? `<section class="more-videos" aria-labelledby="more-title"><h2 id="more-title">${esc(c.watch.more)}</h2><ul class="video-grid">${others.map((v) => videoCard(site, lang, v.id)).join('\n')}</ul></section>` : ''}
</div>
</article>`;
  return page(site, {
    lang,
    title: title(text.title),
    description: text.description,
    path: href,
    alternates: watchAlternates(entry.slug),
    ogType: 'video.other',
    image: { src: still.src, width: still.width, height: still.height, type: still.type, alt: text.title },
    video: { src: file.src, type: file.type, width: file.width, height: file.height },
    jsonld: watchGraph(site, lang, entry),
    onLanding: false,
    bodyClass: 'page-watch',
    main,
  });
}

/** /videos: every video, the filmed ones linked to their pages. Built only once one is filmed. */
export function hubPage(site: Site, lang: Lang): string {
  const c = site.content[lang];
  const og = site.og[lang];
  const main = `<section class="hub" aria-labelledby="hub-title">
<div class="wrap">
${breadcrumb(site, lang, [
  ['The Funfair', localPath(lang)],
  [c.watch.videos, null],
])}
<h1 id="hub-title">${inline(c.hub.heading, lang)}</h1>
<p class="section-lead">${inline(c.hub.lead, lang)}</p>
<ul class="video-grid">${VIDEOS.map((v) => videoCard(site, lang, v.id, 2)).join('\n')}</ul>
</div>
</section>`;
  return page(site, {
    lang,
    title: c.hub.title,
    description: c.hub.description,
    path: hubPath(lang),
    alternates: Object.fromEntries(LANGS.map((l) => [l, hubPath(l)])),
    ogType: 'website',
    image: { ...og, alt: c.og.alt },
    jsonld: hubGraph(site, lang),
    onLanding: false,
    bodyClass: 'page-hub',
    main,
  });
}

/** The page for a wrong address: one for the whole site (Vercel serves 404.html), never indexed. */
export function notFoundPage(site: Site): string {
  const lang: Lang = 'en';
  const c = site.content[lang];
  const nf = c.notFound;
  const og = site.og[lang];
  const main = `<section class="lost" aria-labelledby="lost-title">
<div class="wrap">
<div class="cta-ticket lost-ticket">
<p class="kicker">${icon('ticket')}<span>${esc(nf.kicker)}</span></p>
<p class="lost-number" aria-hidden="true">404</p>
<h1 id="lost-title">${inline(nf.heading, lang)}</h1>
<p>${inline(nf.text, lang)}</p>
<p class="lost-actions"><a class="btn btn-primary btn-big" href="${PLAY_HREF}">${icon('play')}<span>${esc(nf.play)}</span></a>
<a class="btn btn-ghost btn-big" href="/">${esc(nf.home)}</a></p>
<ul class="lost-langs">${LANGS.filter((l) => l !== 'en')
    .map((l) => `<li><a href="${localPath(l)}" hreflang="${l}" lang="${l}">${LANG_INFO[l].name}</a></li>`)
    .join('')}</ul>
</div>
</div>
</section>`;
  return page(site, {
    lang,
    title: nf.title,
    description: c.meta.description,
    path: '/404',
    alternates: {},
    ogType: 'website',
    image: { ...og, alt: c.og.alt },
    index: false,
    onLanding: false,
    bodyClass: 'page-lost',
    main,
  });
}
