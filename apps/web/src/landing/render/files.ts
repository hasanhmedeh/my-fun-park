// The files machines read: sitemap.xml, robots.txt, llms.txt and llms-full.txt. All of them come
// from the same content and media as the pages, so they can never disagree with what people see.

import { LANGS, VIDEOS, type Lang } from '../videos.ts';
import { abs } from './head.ts';
import { LANG_INFO, localPath } from './langs.ts';
import { filmed, hubPath, playable, poster, videoText, watchPath } from './media.ts';
import { routes } from './routes.ts';
import { clock, esc, markdown, paragraphs, plain } from './text.ts';
import type { Site } from './types.ts';

/** /park and the legal pages are English only: listed, with no alternates. */
function otherPages(site: Site) {
  return ['/park', '/terms', '/privacy', ...(site.credits ? ['/credits'] : [])];
}

/**
 * sitemap.xml: every landing, hub and watch page with its language versions (xhtml:link), the watch
 * pages with their video (video:video), then the game and the legal pages.
 */
export function sitemap(site: Site): string {
  const entries: string[] = [];
  const all = routes(site).filter((r) => r.kind !== 'notFound');
  for (const r of all) {
    // the same page in each language (every language version lists them all, itself included)
    const same = (l: Lang) => all.find((o) => o.key === r.key && o.lang === l);
    const links = LANGS.map((l) => same(l))
      .filter((o) => o !== undefined)
      .map((o) => `    <xhtml:link rel="alternate" hreflang="${o.lang}" href="${esc(abs(site, o.path))}"/>`);
    const english = same('en');
    if (english) links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(abs(site, english.path))}"/>`);
    let lastmod = site.content[r.lang].meta.updated;
    let video = '';
    if (r.kind === 'watch') {
      const entry = filmed(site).find((v) => watchPath(r.lang, v.slug) === r.path)!;
      const media = site.media.videos[entry.id]!;
      const text = videoText(site, r.lang, entry.id)!;
      lastmod = media.uploadDate;
      video = `
    <video:video>
      <video:thumbnail_loc>${esc(abs(site, poster(media).src))}</video:thumbnail_loc>
      <video:title>${esc(text.title)}</video:title>
      <video:description>${esc(paragraphs(text.longDescription).join(' ').slice(0, 2048) || text.description)}</video:description>
      <video:content_loc>${esc(abs(site, playable(media).src))}</video:content_loc>
      <video:duration>${Math.max(1, Math.min(28800, Math.round(media.duration)))}</video:duration>
      <video:publication_date>${media.uploadDate}T12:00:00+00:00</video:publication_date>
      <video:uploader info="${esc(`${site.url}/`)}">Hasan Hmedeh</video:uploader>
    </video:video>`;
    } else if (r.kind === 'hub') {
      lastmod = filmed(site)
        .map((v) => site.media.videos[v.id]!.uploadDate)
        .sort()
        .at(-1)!;
    }
    const loc = abs(site, r.path === '/' ? '/' : r.path);
    entries.push(`  <url>
    <loc>${esc(r.path === '/' ? `${site.url}/` : loc)}</loc>
    <lastmod>${lastmod}</lastmod>
${links.join('\n')}${video}
  </url>`);
  }
  for (const path of otherPages(site)) entries.push(`  <url>\n    <loc>${esc(abs(site, path))}</loc>\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${entries.join('\n')}
</urlset>
`;
}

/** The crawlers named in robots.txt, by what they do (see the research notes in landing.md). */
const CRAWLERS: [string, string[]][] = [
  ['Search', ['Googlebot', 'Googlebot-Image', 'Googlebot-Video', 'Bingbot', 'Applebot']],
  ['AI search', ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'DuckAssistBot', 'Amzn-SearchBot', 'meta-webindexer', 'MistralAI-Index']],
  ['Fetch for a user', ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'Amzn-User', 'MistralAI-User', 'meta-externalfetcher', 'Google-Agent']],
  ['AI training', ['GPTBot', 'ClaudeBot', 'Google-Extended', 'Applebot-Extended', 'Amazonbot', 'meta-externalagent', 'MistralAI-Training', 'CCBot']],
  ['Link previews', ['facebookexternalhit']],
];

/**
 * robots.txt: everyone may read, index and cite the public pages. Every named crawler shares the one
 * group with "*": a crawler obeys only the most specific group naming it, so a group of its own would
 * drop the two Disallow lines for it.
 */
export function robots(site: Site): string {
  const names = CRAWLERS.flatMap(([, list]) => list);
  return `# The Funfair: ${site.url}
#
# Everyone is welcome to read, index and cite the public pages: search engines, AI search and
# answer engines, AI assistants fetching a page for a person, and AI training crawlers alike.
# Only the staff office (/ringmaster) and the game server's API (/api/) are off limits.
#
# The crawlers below are named so the intent is explicit. They all share the one group of rules
# with "*": a crawler obeys only the most specific group that names it, so giving one of them a
# group of its own would drop the two Disallow lines for it.
${CRAWLERS.map(([what, list]) => `#   ${`${what}:`.padEnd(19)}${list.join(', ')}`).join('\n')}

${names.map((n) => `User-agent: ${n}`).join('\n')}
User-agent: *
Allow: /
Disallow: /ringmaster
Disallow: /api/

Sitemap: ${site.url}/sitemap.xml
`;
}

/** One line of Markdown with no line breaks (list notes). */
const line = (text: string) => markdown(text).replace(/\s+/g, ' ').trim();

/** The key facts, from the "At a glance" table. */
const keyFacts = (site: Site) => site.content.en.facts.rows.map((r) => `- ${plain(r.label)}: ${line(r.value)}`);

/**
 * llms.txt (llmstxt.org): the name, a one-paragraph summary, the key facts, then sections of links
 * with a note each. English, like the game.
 */
export function llms(site: Site): string {
  const c = site.content.en;
  const u = site.url;
  const out: string[] = [`# The Funfair`, '', `> ${line(c.summary.paragraphs[0])}`, '', `Key facts, as of ${c.meta.updated}:`, '', ...keyFacts(site)];
  out.push(`- Payments: there are no real-money payments today; paid extras are coming soon.`);
  out.push(`- Contact: hassanhmedeh@gmail.com`);

  out.push('', '## Play', '', `- [Play The Funfair](${u}/park): the game itself, free in your browser, with nothing to download`);

  out.push('', '## Overview', '');
  out.push(`- [${plain(c.summary.heading)}](${u}/#about): ${line(c.summary.paragraphs[1] ?? c.summary.paragraphs[0])}`);
  out.push(`- [${plain(c.facts.heading)}](${u}/#about): genre, platform, price, controls, players and the game's language in one table`);
  out.push(`- [Full text](${u}/llms-full.txt): the whole English page as one Markdown file`);

  out.push('', `## Attractions`, '');
  for (const g of c.attractions.groups)
    for (const card of [...g.cards, ...(g.extra ?? [])]) out.push(`- [${plain(card.name)}](${u}/#${g.id}): ${line(card.text)}`);

  out.push('', '## How to play', '');
  for (const t of [c.howToPlay.keyboard, c.howToPlay.touch, c.howToPlay.rides])
    out.push(`- [${plain(t.heading)}](${u}/#how-to-play): ${t.rows.map((r) => `${plain(r.keys)}: ${plain(r.action)}`).join('; ')}`);

  out.push('', '## Tutorials', '');
  for (const v of VIDEOS) {
    const text = videoText(site, 'en', v.id);
    if (!text) continue;
    const media = site.media.videos[v.id];
    out.push(
      media
        ? `- [${text.title}](${u}${watchPath('en', v.slug)}): ${line(text.description)} (${clock(media.duration)}, with chapters and a transcript)`
        : `- [${text.title}](${u}/#tutorials): ${line(text.description)} (coming soon)`,
    );
  }

  out.push('', '## FAQ', '');
  for (const item of c.faq.items) out.push(`- [${plain(item.q)}](${u}/#faq): ${line(item.a)}`);

  out.push('', '## Languages', '');
  out.push(`- [${LANG_INFO.en.name}](${u}/): this page in English`);
  out.push(`- [${LANG_INFO.fr.name}](${u}${localPath('fr')}): the same page in French (the game itself is in English)`);
  out.push(`- [${LANG_INFO.ar.name}](${u}${localPath('ar')}): the same page in Arabic (the game itself is in English)`);

  out.push('', '## Creator', '');
  out.push(`- [${plain(c.creator.heading)}](${u}/#made-by): ${line(c.creator.paragraphs[0])}`);
  for (const l of c.creator.links) out.push(`- [${l.label}](${l.href}): Hasan Hmedeh on ${l.label}`);

  out.push('', '## Legal', '');
  out.push(`- [${c.footer.terms}](${u}/terms): accounts, free virtual tickets, fair play, health and safety`);
  out.push(`- [${c.footer.privacy}](${u}/privacy): what the game stores and why`);
  if (site.credits) out.push(`- [${c.footer.credits}](${u}/credits): the licences of the models, fonts and libraries`);
  return out.join('\n') + '\n';
}

/** llms-full.txt: the English landing page's full text as clean Markdown, then each filmed video. */
export function llmsFull(site: Site): string {
  const c = site.content.en;
  const u = site.url;
  const out: string[] = [`# The Funfair`, '', `> ${line(c.summary.paragraphs[0])}`, ''];
  for (const p of c.summary.paragraphs.slice(1)) out.push(markdown(p), '');
  out.push(`Play free: ${u}/park`, '', `Last updated: ${c.meta.updated}`, '');

  out.push(`## ${plain(c.facts.heading)}`, '', '| | |', '|---|---|');
  for (const r of c.facts.rows) out.push(`| ${plain(r.label)} | ${line(r.value)} |`);
  out.push('');

  out.push(`## ${plain(c.attractions.heading)}`, '', markdown(c.attractions.lead), '');
  for (const g of c.attractions.groups) {
    out.push(`### ${plain(g.heading)}`, '');
    if (g.lead) out.push(markdown(g.lead), '');
    const item = (card: (typeof g.cards)[number]) =>
      `- **${plain(card.name)}**: ${line(card.text)}${card.more ? ` ${line(card.more)}` : ''}${card.facts.length ? ` (${card.facts.map(plain).join(' · ')})` : ''}`;
    out.push(...g.cards.map(item), '');
    if (g.extra?.length) out.push(`#### ${plain(g.extraHeading ?? '')}`, '', ...g.extra.map(item), '');
  }

  out.push(`## ${plain(c.howToPlay.heading)}`, '', markdown(c.howToPlay.lead), '');
  for (const t of [c.howToPlay.keyboard, c.howToPlay.touch, c.howToPlay.rides]) {
    out.push(`### ${plain(t.heading)}`, '', '| Keys | What it does |', '|---|---|');
    for (const r of t.rows) out.push(`| ${line(r.keys)} | ${line(r.action)} |`);
    out.push('');
  }
  out.push(...c.howToPlay.notes.map((n) => `- ${line(n)}`), '');

  out.push(`## ${plain(c.tickets.heading)}`, '', markdown(c.tickets.lead), '');
  for (const s of c.tickets.cards) out.push(`- **${plain(s.title)}** (${s.tag}): ${line(s.text)}`);
  out.push('', markdown(c.tickets.note), '');

  out.push(`## ${plain(c.tutorials.heading)}`, '', markdown(c.tutorials.lead), '');
  for (const v of VIDEOS) {
    const text = videoText(site, 'en', v.id);
    if (!text) continue;
    const media = site.media.videos[v.id];
    if (!media) {
      out.push(`- **${text.title}**: ${line(text.description)} (coming soon)`);
      continue;
    }
    out.push('', `### ${text.title}`, '', `Watch: ${u}${watchPath('en', v.slug)} (${clock(media.duration)})`, '');
    for (const p of paragraphs(text.longDescription)) out.push(markdown(p), '');
    if (text.steps?.length) out.push(...text.steps.map((s, i) => `${i + 1}. ${line(s)}`), '');
    const chapters = media.chapters.filter((ch) => text.chapters[ch.id]);
    if (chapters.length) out.push(...chapters.map((ch) => `- ${clock(ch.start)} ${text.chapters[ch.id]}`), '');
    const transcript = Object.values(text.captions).map(plain);
    if (transcript.length) out.push(`Transcript: ${transcript.join(' ')}`, '');
  }
  if (filmed(site).length) out.push('', `All videos: ${u}${hubPath('en')}`);
  out.push('');

  out.push(`## ${plain(c.faq.heading)}`, '');
  for (const item of c.faq.items) out.push(`### ${plain(item.q)}`, '', markdown(item.a), '');

  out.push(`## ${plain(c.creator.heading)}`, '');
  for (const p of c.creator.paragraphs) out.push(markdown(p), '');
  out.push(...c.creator.links.map((l) => `- ${l.label}: ${l.href}`), '');

  out.push(`## ${plain(c.cta.heading)}`, '', markdown(c.cta.text), '', `[${c.cta.button}](${u}/park)`, '');
  out.push(
    `Languages: ${LANGS.map((l) => `${LANG_INFO[l].name} (${u}${l === 'en' ? '/' : localPath(l)})`).join(', ')}. The game's interface is in English.`,
    '',
    `Legal: ${u}/terms · ${u}/privacy${site.credits ? ` · ${u}/credits` : ''} · Contact: hassanhmedeh@gmail.com`,
    '',
    `Last updated: ${c.meta.updated}`,
  );
  return out.join('\n') + '\n';
}
