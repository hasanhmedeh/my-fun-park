// Structured data (schema.org JSON-LD), one @graph per page. It names the entities for search engines
// and AI answers: the game (VideoGame, typed alone: it has no ratings or reviews, and we invent none),
// its maker (Person), the site and page, the FAQ, and on watch pages the video with its chapters and
// a breadcrumb. Every value is also visible on the page. Shared entities keep one @id across pages and
// languages (the game is site/#game everywhere); each page's own nodes use that page's address.

import { LANGS, type Lang, type VideoEntry } from '../videos.ts';
import { abs } from './head.ts';
import { localPath } from './langs.ts';
import { filmed, hubPath, playable, videoText, watchPath } from './media.ts';
import { isoDuration, plain } from './text.ts';
import type { Site } from './types.ts';

const SITE_NAME = 'The Funfair';

export const ids = (site: Site) => ({
  website: `${site.url}/#website`,
  game: `${site.url}/#game`,
  person: `${site.url}/#hasan`,
});

/** media.json has the day a video was filmed; structured data wants a time with its zone. */
const uploadDate = (day: string) => `${day}T12:00:00+00:00`;

function person(site: Site) {
  const en = site.content.en;
  return {
    '@type': 'Person',
    '@id': ids(site).person,
    name: 'Hasan Hmedeh',
    jobTitle: 'Full-stack Software Developer',
    url: `${site.url}/#made-by`,
    sameAs: en.creator.links.map((l) => l.href),
  };
}

function website(site: Site) {
  return {
    '@type': 'WebSite',
    '@id': ids(site).website,
    url: `${site.url}/`,
    name: SITE_NAME,
    inLanguage: [...LANGS],
    publisher: { '@id': ids(site).person },
  };
}

/** The game itself, described in the page's language. Its interface is English whatever the page. */
function videoGame(site: Site, lang: Lang) {
  const c = site.content[lang];
  const trailer = site.media.videos.trailer && site.videoText.en.trailer;
  const cards = c.attractions.groups.flatMap((g) => g.cards);
  return {
    '@type': 'VideoGame',
    '@id': ids(site).game,
    name: SITE_NAME,
    url: `${site.url}/park`,
    description: plain(c.summary.paragraphs[0]),
    image: abs(site, '/media/stills/hero-1920.webp'),
    screenshot: ['coaster', 'falcon', 'workshop', 'a320', 'palmcay']
      .filter((s) => site.stills[s])
      .map((s) => abs(site, `/media/stills/${s}-1920.webp`)),
    genre: ['Amusement park', 'Simulation', 'Racing', 'Flight simulation'],
    gamePlatform: 'Web browser',
    applicationCategory: 'GameApplication',
    operatingSystem: 'Any operating system with a recent web browser',
    softwareRequirements: 'A browser with WebGL 2: a recent Chrome, Edge, Firefox or Safari. Best with a keyboard; touch works too.',
    playMode: 'https://schema.org/SinglePlayer',
    inLanguage: 'en',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', url: `${site.url}/park` },
    featureList: cards.map((card) => `${card.name}: ${plain(card.text)}`),
    author: { '@id': ids(site).person },
    publisher: { '@id': ids(site).person },
    ...(trailer ? { trailer: { '@id': `${abs(site, watchPath('en', 'trailer'))}#video` } } : {}),
  };
}

/** The landing page in one language. */
export function landingGraph(site: Site, lang: Lang) {
  const c = site.content[lang];
  const page = abs(site, localPath(lang));
  const self = lang === 'en' ? `${site.url}/` : page;
  const heroId = `${self}#hero-image`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      ...(lang === 'en' ? [website(site)] : []),
      {
        '@type': 'WebPage',
        '@id': `${self}#webpage`,
        url: page,
        name: c.meta.title,
        description: c.meta.description,
        inLanguage: lang,
        isPartOf: { '@id': ids(site).website },
        about: { '@id': ids(site).game },
        mainEntity: { '@id': ids(site).game },
        ...(site.stills.hero ? { primaryImageOfPage: { '@id': heroId } } : {}),
        hasPart: { '@id': `${self}#faq` },
        dateModified: c.meta.updated,
      },
      ...(site.stills.hero
        ? [
            {
              '@type': 'ImageObject',
              '@id': heroId,
              contentUrl: abs(site, '/media/stills/hero-1920.webp'),
              url: abs(site, '/media/stills/hero-1920.webp'),
              width: site.stills.hero.width,
              height: site.stills.hero.height,
              caption: c.stills.hero,
            },
          ]
        : []),
      videoGame(site, lang),
      person(site),
      {
        '@type': 'FAQPage',
        '@id': `${self}#faq`,
        url: page,
        inLanguage: lang,
        isPartOf: { '@id': ids(site).website },
        mainEntity: c.faq.items.map((item) => ({
          '@type': 'Question',
          name: plain(item.q),
          acceptedAnswer: { '@type': 'Answer', text: plain(item.a) },
        })),
      },
    ],
  };
}

/** A watch page: the video, its chapters as Clips (deep links with ?t=), and the breadcrumb. */
export function watchGraph(site: Site, lang: Lang, entry: VideoEntry) {
  const media = site.media.videos[entry.id]!;
  const text = videoText(site, lang, entry.id)!;
  const c = site.content[lang];
  const page = abs(site, watchPath(lang, entry.slug));
  const file = playable(media);
  const starts = media.chapters.filter((ch) => text.chapters[ch.id]);
  const transcript = Object.values(text.captions).map(plain).join(' ');
  const clips =
    media.duration >= 30
      ? starts.map((ch, i) => ({
          '@type': 'Clip',
          name: text.chapters[ch.id],
          startOffset: Math.floor(ch.start),
          endOffset: Math.floor(starts[i + 1]?.start ?? media.duration),
          url: `${page}?t=${Math.floor(ch.start)}`,
        }))
      : [];
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${page}#webpage`,
        url: page,
        name: text.title,
        description: text.description,
        inLanguage: lang,
        isPartOf: { '@id': ids(site).website },
        mainEntity: { '@id': `${page}#video` },
        breadcrumb: { '@id': `${page}#breadcrumb` },
      },
      {
        '@type': 'VideoObject',
        '@id': `${page}#video`,
        name: text.title,
        description: text.description,
        thumbnailUrl: media.poster.map((p) => abs(site, p.src)),
        uploadDate: uploadDate(media.uploadDate),
        duration: isoDuration(media.duration),
        contentUrl: abs(site, file.src),
        encodingFormat: 'video/mp4',
        width: file.width,
        height: file.height,
        author: { '@id': ids(site).person },
        publisher: { '@id': ids(site).person },
        about: { '@id': ids(site).game },
        ...(Object.keys(media.captions).length
          ? {
              caption: LANGS.filter((l) => media.captions[l]).map((l) => ({
                '@type': 'MediaObject',
                contentUrl: abs(site, media.captions[l]!),
                encodingFormat: 'text/vtt',
                inLanguage: l,
              })),
            }
          : {}),
        ...(transcript ? { transcript } : {}),
        ...(clips.length ? { hasPart: clips } : {}),
        ...(media.youtubeId ? { sameAs: `https://www.youtube.com/watch?v=${media.youtubeId}` } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${page}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: abs(site, localPath(lang)) },
          { '@type': 'ListItem', position: 2, name: c.watch.videos, item: abs(site, hubPath(lang)) },
          { '@type': 'ListItem', position: 3, name: text.title },
        ],
      },
      person(site),
    ],
  };
}

/** The videos hub: a collection of the filmed videos. */
export function hubGraph(site: Site, lang: Lang) {
  const c = site.content[lang];
  const page = abs(site, hubPath(lang));
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${page}#webpage`,
        url: page,
        name: c.hub.title,
        description: c.hub.description,
        inLanguage: lang,
        isPartOf: { '@id': ids(site).website },
        about: { '@id': ids(site).game },
        hasPart: filmed(site).map((v) => ({ '@id': `${abs(site, watchPath(lang, v.slug))}#video` })),
        breadcrumb: { '@id': `${page}#breadcrumb` },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${page}#breadcrumb`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: SITE_NAME, item: abs(site, localPath(lang)) },
          { '@type': 'ListItem', position: 2, name: c.watch.videos },
        ],
      },
    ],
  };
}

