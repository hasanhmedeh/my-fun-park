// The landing page (/, /fr, /ar): everything a player wants to know before pressing Play, answer
// first. All of it is in the HTML, so it reads the same without JS, to search engines and to AI
// crawlers that don't run scripts. JS (../main.ts) only adds the extras: the share sheet, the video
// play button, the language suggestion, the phone's Play bar.

import { LANGS, VIDEOS, type Lang, type VideoId } from '../videos.ts';
import type { Alternates } from './head.ts';
import { icon } from './icons.ts';
import { landingGraph } from './jsonld.ts';
import { localPath } from './langs.ts';
import { page, PLAY_HREF } from './layout.ts';
import { chapters, duration, filmed, heroLoop, hubPath, picture, player, poster, VIDEO_STILL, videoText, watchPath, youtubeLink } from './media.ts';
import { esc, escText, inline, longDate, plain } from './text.ts';
import type { Card, ControlTable, Group, Site } from './types.ts';

/** The landing page in every language, for hreflang and the switcher. */
export const landingAlternates = (): Alternates => Object.fromEntries(LANGS.map((l) => [l, localPath(l)]));

export function landingPage(site: Site, lang: Lang): string {
  const c = site.content[lang];
  const og = site.og[lang];
  return page(site, {
    lang,
    title: c.meta.title,
    description: c.meta.description,
    path: localPath(lang),
    alternates: landingAlternates(),
    ogType: 'website',
    image: { ...og, alt: c.og.alt },
    jsonld: landingGraph(site, lang),
    onLanding: true,
    bodyClass: 'page-landing',
    main: [
      hero(site, lang),
      about(site, lang),
      trailer(site, lang),
      attractions(site, lang),
      howToPlay(site, lang),
      tickets(site, lang),
      tutorials(site, lang),
      faq(site, lang),
      creator(site, lang),
      finale(site, lang),
    ].join('\n'),
  });
}

/** A section's heading and its one-line lead. */
const sectionHead = (id: string, heading: string, lead: string, lang: Lang) =>
  `<div class="section-head"><h2 id="${id}-title">${inline(heading, lang)}</h2>${lead ? `<p class="section-lead">${inline(lead, lang)}</p>` : ''}</div>`;

/** A big "Play free" button. */
const playButton = (label: string, cls = '') => `<a class="btn btn-primary btn-big ${cls}" href="${PLAY_HREF}">${icon('play')}<span>${esc(label)}</span></a>`;

function hero(site: Site, lang: Lang) {
  const c = site.content[lang];
  const h = c.hero;
  return `<section class="hero" aria-labelledby="hero-title">
<div class="hero-media">
${picture(site, 'hero', c.stills.hero ?? '', { sizes: '100vw', priority: true, cls: 'hero-still' })}
${heroLoop(site, c.ui)}
</div>
<div class="lights" aria-hidden="true"></div>
<div class="wrap hero-copy">
<p class="kicker">${icon('ticket')}<span>${esc(h.kicker)}</span></p>
<h1 id="hero-title"><span class="hero-brand">${inline(h.brand, lang)}</span><span class="visually-hidden">: </span><span class="hero-what">${inline(h.what, lang)}</span></h1>
<p class="hero-lead">${inline(h.lead, lang)}</p>
<div class="hero-actions">
${playButton(h.cta, 'hero-play')}
<a class="btn btn-ghost btn-big" href="#trailer">${icon('play')}<span>${esc(h.secondary)}</span></a>
</div>
<ul class="hero-badges">${h.badges.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
</div>
</section>`;
}

/** "What is The Funfair?": the answer-first summary, beside the facts at a glance. */
function about(site: Site, lang: Lang) {
  const c = site.content[lang];
  const rows = c.facts.rows.map((r) => `<tr><th scope="row">${inline(r.label, lang)}</th><td>${inline(r.value, lang)}</td></tr>`).join('');
  return `<section id="about" class="section about" aria-labelledby="about-title">
<div class="wrap about-grid">
<div class="about-copy">
<h2 id="about-title">${inline(c.summary.heading, lang)}</h2>
${c.summary.paragraphs.map((p) => `<p>${inline(p, lang)}</p>`).join('\n')}
</div>
<div class="facts ticket">
<h3 class="facts-title" id="facts-title">${inline(c.facts.heading, lang)}</h3>
<table class="facts-table" aria-labelledby="facts-title"><tbody>${rows}</tbody></table>
<p class="facts-updated">${esc(c.ui.updated)} <time datetime="${c.meta.updated}">${longDate(c.meta.updated, lang)}</time></p>
</div>
</div>
</section>`;
}

/** The trailer: the player once it's filmed, the poster with a "coming soon" badge until then. */
function trailer(site: Site, lang: Lang) {
  const c = site.content[lang];
  const media = site.media.videos.trailer;
  const text = videoText(site, lang, 'trailer');
  let body: string;
  if (media && text) {
    const href = watchPath(lang, 'trailer');
    const list = chapters(media, text, href);
    body = `<div class="screen">${player(media, text, lang, c.ui)}</div>
<div class="trailer-meta">
<p class="trailer-title"><a href="${href}">${escText(text.title, lang)}</a> <span class="muted">· ${esc(duration(media.duration, c.ui))}</span></p>
${list ? `<p class="chapters-title">${esc(c.trailer.chapters)}</p>${list}` : ''}
${youtubeLink(media, c.ui)}
</div>`;
  } else {
    body = `<div class="screen screen-soon">
${picture(site, VIDEO_STILL.trailer, c.stills[VIDEO_STILL.trailer] ?? '', { sizes: '(min-width: 1200px) 1100px, 100vw' })}
<div class="soon-overlay">
<p class="soon-badge">${icon('clock')}<span>${esc(c.trailer.comingSoon)}</span></p>
<p class="soon-note">${inline(c.trailer.comingSoonNote, lang)}</p>
${playButton(c.hero.cta)}
</div>
</div>`;
  }
  return `<section id="trailer" class="section trailer" aria-labelledby="trailer-title">
<div class="wrap">
${sectionHead('trailer', c.trailer.heading, c.trailer.lead, lang)}
${body}
</div>
</section>`;
}

/** One attraction card. `level` is its heading level (h4 in a group, h5 under a sub-heading). */
function card(site: Site, lang: Lang, item: Card, level: number, sizes: string, cls = '') {
  const alt = item.still ? site.content[lang].stills[item.still] ?? item.name : '';
  return `<li class="card ${cls}">
${picture(site, item.still, alt, { sizes, cls: 'card-still' })}
<div class="card-body">
<h${level} class="card-name">${inline(item.name, lang)}</h${level}>
<p>${inline(item.text, lang)}</p>
${chips(item.facts, lang)}
</div>
</li>`;
}

const chips = (facts: string[], lang: Lang) =>
  facts.length ? `<ul class="chips">${facts.map((f) => `<li>${inline(f, lang)}</li>`).join('')}</ul>` : '';

/** The look card has no still yet: a ring of dyes round a shirt stands in, drawn in CSS. */
const swatches = () =>
  `<div class="still swatches" aria-hidden="true">${['#ff4d6d', '#ffc23d', '#2ec4b6', '#7b5cd6', '#fff5e3', '#1f8a70', '#e86f3a', '#3a6fe8', '#d93354', '#8b5e3c', '#f2a7c3', '#22163f']
    .map((col, i) => `<span style="--dye:${col};--i:${i}"></span>`)
    .join('')}${icon('shirt', 'swatch-shirt')}</div>`;

function group(site: Site, lang: Lang, g: Group) {
  const titleId = `group-${g.id}`;
  const headBlock = `<div class="group-head"><span class="group-icon">${icon(g.icon)}</span><div><h3 id="${titleId}">${inline(g.heading, lang)}</h3>${g.lead ? `<p>${inline(g.lead, lang)}</p>` : ''}</div></div>`;

  if (g.feature) {
    const item = g.cards[0];
    const label = g.heading.toLowerCase().includes(item.name.toLowerCase()) ? '' : `<p class="feature-label">${inline(item.name, lang)}</p>`;
    const media = item.still
      ? picture(site, item.still, site.content[lang].stills[item.still] ?? item.name, { sizes: '(min-width: 960px) 560px, 100vw', cls: 'feature-still' })
      : swatches();
    return `<article class="group feature feature-${g.id}" id="${g.id}" aria-labelledby="${titleId}">
<div class="feature-media">${media}</div>
<div class="feature-body">
<span class="group-icon">${icon(g.icon)}</span>
${label}
<h3 id="${titleId}">${inline(g.heading, lang)}</h3>
<p>${inline(item.text, lang)}</p>
${item.more ? `<p>${inline(item.more, lang)}</p>` : ''}
${chips(item.facts, lang)}
</div>
</article>`;
  }

  const sizes = '(min-width: 1100px) 340px, (min-width: 700px) 45vw, 84vw';
  const list = `<ul class="cards${g.journey ? ' journey' : ''}" data-scroller>${g.cards
    .map((item, i) => card(site, lang, item, 4, sizes, g.journey ? `step step-${i + 1}` : ''))
    .join('\n')}</ul>`;
  const extra = g.extra?.length
    ? `<h4 class="subhead">${inline(g.extraHeading ?? '', lang)}</h4>
<ul class="cards cards-small" data-scroller>${g.extra.map((item) => card(site, lang, item, 5, '(min-width: 1100px) 260px, (min-width: 700px) 30vw, 70vw')).join('\n')}</ul>`
    : '';
  return `<div class="group group-${g.id}" id="${g.id}" role="group" aria-labelledby="${titleId}">
${headBlock}
${list}
${extra}
</div>`;
}

function attractions(site: Site, lang: Lang) {
  const c = site.content[lang];
  return `<section id="attractions" class="section attractions" aria-labelledby="attractions-title">
<div class="wrap">
${sectionHead('attractions', c.attractions.heading, c.attractions.lead, lang)}
${c.attractions.groups.map((g) => group(site, lang, g)).join('\n')}
</div>
</section>`;
}

function controls(table: ControlTable, iconName: string, lang: Lang, cls: string) {
  const id = `controls-${iconName}`;
  const rows = table.rows.map((r) => `<tr><th scope="row">${inline(r.keys, lang)}</th><td>${inline(r.action, lang)}</td></tr>`).join('');
  return `<div class="controls-card ${cls}">
<h3 id="${id}">${icon(iconName)}<span>${inline(table.heading, lang)}</span></h3>
<table class="controls" aria-labelledby="${id}"><tbody>${rows}</tbody></table>
</div>`;
}

function howToPlay(site: Site, lang: Lang) {
  const h = site.content[lang].howToPlay;
  return `<section id="how-to-play" class="section how" aria-labelledby="how-to-play-title">
<div class="wrap">
${sectionHead('how-to-play', h.heading, h.lead, lang)}
<div class="controls-grid">
${controls(h.keyboard, 'keyboard', lang, '')}
${controls(h.touch, 'touch', lang, '')}
${controls(h.rides, 'gamepad', lang, 'controls-wide')}
</div>
<ul class="notes">${h.notes.map((n) => `<li><span>${inline(n, lang)}</span></li>`).join('')}</ul>
</div>
</section>`;
}

function tickets(site: Site, lang: Lang) {
  const t = site.content[lang].tickets;
  const cards = t.cards
    .map(
      (s) => `<li class="stub${s.soon ? ' stub-soon' : ''}">
<p class="stub-tag">${esc(s.tag)}</p>
<h3>${inline(s.title, lang)}</h3>
<p>${inline(s.text, lang)}</p>
</li>`,
    )
    .join('\n');
  return `<section id="tickets" class="section tickets" aria-labelledby="tickets-title">
<div class="wrap">
${sectionHead('tickets', t.heading, t.lead, lang)}
<ul class="stubs">${cards}</ul>
<p class="tickets-note">${inline(t.note, lang)}</p>
<p class="tickets-cta">${playButton(site.content[lang].hero.cta)}</p>
</div>
</section>`;
}

/** A tutorial's card: linked to its watch page once filmed, "coming soon" until then. */
export function videoCard(site: Site, lang: Lang, id: VideoId, level = 3) {
  const c = site.content[lang];
  const entry = VIDEOS.find((v) => v.id === id)!;
  const text = videoText(site, lang, id);
  if (!text) return '';
  const media = site.media.videos[id];
  const href = watchPath(lang, entry.slug);
  const sizes = '(min-width: 1100px) 340px, (min-width: 700px) 45vw, 84vw';
  const still = media
    ? `<img class="still" src="${esc(poster(media).src)}" width="${poster(media).width}" height="${poster(media).height}" alt="" loading="lazy" decoding="async" />`
    : VIDEO_STILL[id]
      ? picture(site, VIDEO_STILL[id], '', { sizes })
      : swatches();
  const badge = media
    ? `<span class="video-badge">${icon('play')}<span>${esc(duration(media.duration, c.ui))}</span></span>`
    : `<span class="video-badge video-soon">${icon('clock')}<span>${esc(c.ui.comingSoon)}</span></span>`;
  const title = media ? `<a href="${href}">${escText(text.title, lang)}</a>` : escText(text.title, lang);
  return `<li class="video-card${media ? '' : ' is-soon'}">
<div class="video-thumb">${still}${badge}</div>
<div class="video-body">
<h${level} class="video-title">${title}</h${level}>
<p>${escText(text.description, lang)}</p>
</div>
</li>`;
}

function tutorials(site: Site, lang: Lang) {
  const c = site.content[lang];
  const hub = filmed(site).length ? `<p class="all-videos"><a class="btn btn-ghost" href="${hubPath(lang)}">${esc(c.watch.videos)} ${icon('arrow')}</a></p>` : '';
  const cards = VIDEOS.filter((v) => v.kind === 'tutorial')
    .map((v) => videoCard(site, lang, v.id))
    .join('\n');
  return `<section id="tutorials" class="section tutorials" aria-labelledby="tutorials-title">
<div class="wrap">
${sectionHead('tutorials', c.tutorials.heading, c.tutorials.lead, lang)}
<ul class="video-grid">${cards}</ul>
${hub}
</div>
</section>`;
}

/** The FAQ: open by default, so every answer is readable (and quotable) without a click. */
function faq(site: Site, lang: Lang) {
  const f = site.content[lang].faq;
  const items = f.items
    .map(
      (item, i) => `<details class="faq-item" open>
<summary><h3 id="faq-${i + 1}">${inline(item.q, lang)}</h3>${icon('chevron', 'faq-chevron')}</summary>
<p>${inline(item.a, lang)}</p>
</details>`,
    )
    .join('\n');
  return `<section id="faq" class="section faq" aria-labelledby="faq-title">
<div class="wrap">
${sectionHead('faq', f.heading, '', lang)}
<div class="faq-list">${items}</div>
</div>
</section>`;
}

function creator(site: Site, lang: Lang) {
  const cr = site.content[lang].creator;
  const links = cr.links
    .map((l) => `<li><a class="profile" href="${esc(l.href)}" rel="me noopener">${icon(l.icon)}<span>${esc(l.label)}</span></a></li>`)
    .join('');
  return `<section id="made-by" class="section creator" aria-labelledby="made-by-title">
<div class="wrap creator-grid">
<div class="plaque" aria-hidden="true">
<span class="plaque-frame">${icon('frame')}</span>
<span class="plaque-years">${esc(cr.plaque.since)}</span>
<span class="plaque-name" translate="no">Hasan Hmedeh</span>
<span class="plaque-role">${esc(cr.plaque.role)}</span>
</div>
<div class="creator-copy">
<p class="kicker">${esc(cr.kicker)}</p>
<h2 id="made-by-title">${inline(cr.heading, lang)}</h2>
${cr.paragraphs.map((p) => `<p>${inline(p, lang)}</p>`).join('\n')}
<ul class="profiles">${links}</ul>
<p><a class="btn btn-ghost" href="${PLAY_HREF}">${icon('frame')}<span>${esc(cr.cta)}</span></a></p>
</div>
</div>
</section>`;
}

/** The last call to play, and the share row. */
function finale(site: Site, lang: Lang) {
  const c = site.content[lang];
  const url = site.url + (lang === 'en' ? '/' : localPath(lang));
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(plain(c.share.text));
  const networks: [string, string, string][] = [
    ['x', 'X', `https://twitter.com/intent/tweet?text=${t}&url=${u}`],
    ['facebook', 'Facebook', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ['whatsapp', 'WhatsApp', `https://wa.me/?text=${t}%20${u}`],
    ['reddit', 'Reddit', `https://www.reddit.com/submit?url=${u}&title=${t}`],
    ['linkedin', 'LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
    ['telegram', 'Telegram', `https://t.me/share/url?url=${u}&text=${t}`],
  ];
  const share = networks
    .map(([name, label, href]) => `<li><a class="share-link" href="${esc(href)}" rel="noopener" target="_blank">${icon(name)}<span>${label}</span></a></li>`)
    .join('');
  return `<section class="section finale" aria-labelledby="finale-title">
<div class="wrap">
<div class="cta-ticket">
<p class="kicker">${icon('ticket')}<span>${esc(c.hero.kicker)}</span></p>
<h2 id="finale-title">${inline(c.cta.heading, lang)}</h2>
<p class="cta-text">${inline(c.cta.text, lang)}</p>
${playButton(c.cta.button)}
<p class="cta-note">${esc(c.cta.note)}</p>
</div>
<div class="share" role="group" aria-labelledby="share-title">
<h2 class="share-title" id="share-title">${inline(c.share.heading, lang)}</h2>
<ul class="share-list">
<li data-share-native hidden><button type="button" class="share-link share-native" data-share-url="${esc(url)}" data-share-text="${esc(plain(c.share.text))}">${icon('share')}<span>${esc(c.share.native)}</span></button></li>
${share}
<li data-share-copy hidden><button type="button" class="share-link" data-copy-url="${esc(url)}" data-copied="${esc(c.share.copied)}">${icon('link')}<span>${esc(c.share.copy)}</span></button></li>
</ul>
<p class="share-status" role="status" aria-live="polite"></p>
</div>
</div>
</section>`;
}
