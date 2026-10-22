// Every page the landing plugin serves in dev and writes in a build, and where each one goes in dist/.
// Pages are written as <path>.html (fr.html, videos/trailer.html), which Vercel's cleanUrls serves at
// /fr and /videos/trailer; index.html is /. Watch pages and the hubs exist only for filmed videos.

import { LANGS, type Lang } from '../videos.ts';
import { landingPage } from './landing.ts';
import { localPath } from './langs.ts';
import { filmed, hubPath, watchPath } from './media.ts';
import type { Site } from './types.ts';
import { hubPage, notFoundPage, watchPage } from './watch.ts';

export interface Route {
  /** The clean URL ('/', '/fr', '/videos/trailer'). */
  path: string;
  /** Where the page goes in dist/. */
  file: string;
  kind: 'landing' | 'hub' | 'watch' | 'notFound';
  /** The same page in every language shares this ('landing', 'hub', 'watch/trailer'): its alternates. */
  key: string;
  lang: Lang;
  render: (site: Site) => string;
}

const fileFor = (path: string) => (path === '/' ? 'index.html' : `${path.slice(1)}.html`);

export function routes(site: Site): Route[] {
  const list: Route[] = LANGS.map((lang) => ({
    path: localPath(lang),
    file: fileFor(localPath(lang)),
    kind: 'landing',
    key: 'landing',
    lang,
    render: (s) => landingPage(s, lang),
  }));
  const videos = filmed(site);
  if (videos.length) {
    for (const lang of LANGS) {
      list.push({ path: hubPath(lang), file: fileFor(hubPath(lang)), kind: 'hub', key: 'hub', lang, render: (s) => hubPage(s, lang) });
      for (const entry of videos) {
        const path = watchPath(lang, entry.slug);
        list.push({ path, file: fileFor(path), kind: 'watch', key: `watch/${entry.slug}`, lang, render: (s) => watchPage(s, lang, entry) });
      }
    }
  }
  list.push({ path: '/404', file: '404.html', kind: 'notFound', key: '404', lang: 'en', render: notFoundPage });
  return list;
}
