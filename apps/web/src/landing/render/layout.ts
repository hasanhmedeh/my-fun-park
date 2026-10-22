// The frame every page shares: the document, the header (logo, sections, language switcher, Play),
// the footer, and the "Play free" bar that rises on phones once the hero has scrolled away.

import { LANGS, type Lang } from '../videos.ts';
import { head, type Alternates, type HeadOptions } from './head.ts';
import { icon } from './icons.ts';
import { LANG_INFO, localPath, sectionHref } from './langs.ts';
import { filmed, hubPath } from './media.ts';
import { esc } from './text.ts';
import type { Site } from './types.ts';

export interface PageOptions extends HeadOptions {
  /** The landing page links its sections with bare #anchors; other pages link back to it. */
  onLanding: boolean;
  /** The <main> content. */
  main: string;
  /** Extra class on <body> ('page-landing', 'page-watch'…). */
  bodyClass: string;
}

/** The game. Every "Play" button leads here. */
export const PLAY_HREF = '/park';

export function page(site: Site, o: PageOptions): string {
  const info = LANG_INFO[o.lang];
  return `<!doctype html>
<html lang="${o.lang}" dir="${info.dir}" class="no-js">
<head>
${head(site, o)}
</head>
<body class="${o.bodyClass}">
<a class="skip" href="#main">${esc(site.content[o.lang].ui.skip)}</a>
${header(site, o.lang, o.alternates, o.onLanding)}
<main id="main" tabindex="-1">
${o.main}
</main>
${footer(site, o.lang, o.alternates, o.onLanding)}
${playBar(site, o.lang)}
${languageOffer(site, o.lang, o.alternates)}
</body>
</html>
`;
}

/** The logo: the fair's tent and the name. */
const brand = (site: Site, lang: Lang) =>
  `<a class="brand" href="${localPath(lang)}" aria-label="${esc(site.content[lang].ui.home)}">${icon('logo', 'brand-mark')}<span class="brand-name" translate="no">The Funfair</span></a>`;

/** The five sections the header links to. */
function navItems(site: Site, lang: Lang, onLanding: boolean) {
  const nav = site.content[lang].ui.nav;
  return [
    ['trailer', nav.trailer],
    ['attractions', nav.attractions],
    ['how-to-play', nav.howToPlay],
    ['tutorials', nav.tutorials],
    ['faq', nav.faq],
  ]
    .map(([id, label]) => `<li><a href="${sectionHref(lang, id, onLanding)}">${esc(label)}</a></li>`)
    .join('');
}

/** The other languages of this page (or their home page, for a page that has no translation). */
function languageLinks(lang: Lang, alternates: Alternates) {
  return LANGS.map((l) => {
    const href = alternates[l] ?? localPath(l);
    const current = l === lang ? ' aria-current="true"' : '';
    return `<li><a href="${href}" hreflang="${l}" lang="${l}"${current}>${LANG_INFO[l].name}</a></li>`;
  }).join('');
}

function header(site: Site, lang: Lang, alternates: Alternates, onLanding: boolean) {
  const ui = site.content[lang].ui;
  return `<header class="site-header">
<div class="wrap header-inner">
${brand(site, lang)}
<nav class="nav" aria-label="${esc(ui.menu)}"><ul>${navItems(site, lang, onLanding)}</ul></nav>
<div class="header-actions">
<details class="lang-menu" data-dropdown>
<summary aria-label="${esc(`${ui.language}: ${LANG_INFO[lang].name}`)}">${icon('globe')}<span class="lang-current">${LANG_INFO[lang].short}</span>${icon('chevron', 'lang-chevron')}</summary>
<ul class="dropdown">${languageLinks(lang, alternates)}</ul>
</details>
<a class="btn btn-primary btn-small header-play" href="${PLAY_HREF}">${icon('play')}<span>${esc(ui.play)}</span></a>
<details class="menu" data-dropdown>
<summary aria-label="${esc(ui.menu)}">${icon('menu', 'menu-open')}${icon('close', 'menu-close')}</summary>
<div class="menu-panel">
<nav aria-label="${esc(ui.menu)}"><ul class="menu-links">${navItems(site, lang, onLanding)}</ul></nav>
<p class="menu-title">${esc(ui.language)}</p>
<ul class="menu-langs">${languageLinks(lang, alternates)}</ul>
</div>
</details>
</div>
</div>
</header>`;
}

function footer(site: Site, lang: Lang, alternates: Alternates, onLanding: boolean) {
  const c = site.content[lang];
  const f = c.footer;
  const videos = filmed(site).length ? `<li><a href="${hubPath(lang)}">${esc(c.watch.videos)}</a></li>` : '';
  const credits = site.credits ? `<li><a href="/credits">${esc(f.credits)}</a></li>` : '';
  return `<footer class="site-footer">
<div class="wrap footer-grid">
<div class="footer-brand">
${brand(site, lang)}
<p>${esc(f.tagline)}</p>
<a class="btn btn-primary btn-small" href="${PLAY_HREF}">${icon('play')}<span>${esc(c.ui.play)}</span></a>
</div>
<nav class="footer-col" aria-label="${esc(f.explore)}">
<p class="footer-title">${esc(f.explore)}</p>
<ul>
<li><a href="${PLAY_HREF}">${esc(c.ui.play)}</a></li>
<li><a href="${sectionHref(lang, 'attractions', onLanding)}">${esc(c.ui.nav.attractions)}</a></li>
<li><a href="${sectionHref(lang, 'tutorials', onLanding)}">${esc(c.ui.nav.tutorials)}</a></li>
${videos}
<li><a href="${sectionHref(lang, 'faq', onLanding)}">${esc(c.ui.nav.faq)}</a></li>
</ul>
</nav>
<div class="footer-col">
<p class="footer-title">${esc(f.languages)}</p>
<ul>${languageLinks(lang, alternates)}</ul>
</div>
<div class="footer-col">
<p class="footer-title">${esc(f.legal)}</p>
<ul>
<li><a href="/terms">${esc(f.terms)}</a></li>
<li><a href="/privacy">${esc(f.privacy)}</a></li>
${credits}
<li><a href="mailto:hassanhmedeh@gmail.com">${esc(f.contact)}</a></li>
</ul>
</div>
</div>
<div class="wrap footer-bottom"><p><span translate="no">The Funfair</span> · <a href="${sectionHref(lang, 'made-by', onLanding)}">${esc(f.madeBy)}</a></p></div>
</footer>`;
}

/** Phones: a "Play free" bar along the bottom, shown by JS once the hero's own button is out of sight. */
function playBar(site: Site, lang: Lang) {
  const c = site.content[lang];
  return `<div class="play-bar" data-play-bar>
<p class="play-bar-text"><span translate="no">The Funfair</span><span>${esc(c.hero.badges[0] ?? '')}</span></p>
<a class="btn btn-primary" href="${PLAY_HREF}">${icon('play')}<span>${esc(c.ui.play)}</span></a>
</div>`;
}

/**
 * The language suggestion's words, for the visitor who reads another language: each offer is written
 * in its own language (from that language's content file). JS shows one, never redirects.
 */
function languageOffer(site: Site, lang: Lang, alternates: Alternates) {
  const offers = LANGS.filter((l) => l !== lang).map((l) => ({
    lang: l,
    dir: LANG_INFO[l].dir,
    href: alternates[l] ?? localPath(l),
    ...site.content[l].banner,
  }));
  return `<script type="application/json" id="language-offers">${JSON.stringify(offers).replace(/</g, '\\u003c')}</script>`;
}
