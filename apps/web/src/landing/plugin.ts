// The landing page's Vite plugins (imported by vite.config.ts; this runs in Node, never in a browser).
//
// landingPages(): renders the landing, hub, watch and 404 pages from the content files
//   (render/*.ts: pure functions of content + language + media). In dev it serves every route, each
//   through server.transformIndexHtml so Vite handles the page's CSS and JS. In a build, index.html
//   (the English page) goes through Vite like any page, which bundles and hashes landing.css and
//   main.ts; every other page is then written beside it with those same hashed files.
// seo(): __SITE_URL__ in the hand-written pages (park, terms, privacy…), and sitemap.xml, robots.txt,
//   llms.txt and llms-full.txt, written in a build and served in dev.
//
// The content is read from disk on every dev request, so editing a JSON file shows on reload (the
// page reloads by itself). Editing the render code restarts the dev server (it's part of the config).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Connect, Logger, Plugin, ResolvedConfig } from 'vite';
import { llms, llmsFull, robots, sitemap } from './render/files.ts';
import { routes, type Route } from './render/routes.ts';
import type { LandingContent, OgImage, Site, Still } from './render/types.ts';
import { LANGS, VIDEOS, type Lang, type MediaManifest, type VideoMedia } from './videos.ts';

/** How the page loads its CSS and JS before Vite bundles them. */
const SOURCE_ASSETS = `<link rel="stylesheet" href="/src/landing/landing.css" />
<script type="module" src="/src/landing/main.ts"></script>`;

/** index.html carries this marker: it is replaced by the rendered English page. */
const MARKER = '<!-- landing:en -->';

type Json = Record<string, unknown>;

const readJson = (file: string): Json | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Json) : undefined);

/**
 * A translation over the English words: whatever a language file is missing falls back to English, so
 * a half-translated file never breaks the page. Lists are taken whole.
 */
function over(base: unknown, local: unknown): unknown {
  if (local === undefined) return base;
  if (base && local && typeof base === 'object' && typeof local === 'object' && !Array.isArray(base) && !Array.isArray(local)) {
    const out: Json = { ...(base as Json) };
    for (const [k, v] of Object.entries(local as Json)) out[k] = over((base as Json)[k], v);
    return out;
  }
  return local;
}

interface Paths {
  root: string;
  publicDir: string;
  landing: string;
}

/** Whether a site path (/media/…) is a file in public/. Full URLs are trusted. */
const published = (paths: Paths, src: string) => !src.startsWith('/') || existsSync(join(paths.publicDir, src));

/** media.json, minus any video whose files aren't all there (it stays "coming soon"). */
function loadMedia(paths: Paths, logger?: Logger): MediaManifest {
  const raw = (readJson(join(paths.landing, 'media.json')) ?? { videos: {} }) as unknown as MediaManifest;
  const videos: MediaManifest['videos'] = {};
  for (const v of VIDEOS) {
    const m = raw.videos?.[v.id] as VideoMedia | undefined;
    if (!m) continue;
    const files = [...m.sources.map((s) => s.src), ...m.poster.map((p) => p.src), ...Object.values(m.captions)];
    const missing = files.filter((f): f is string => !!f && !published(paths, f));
    if (!m.sources.length || !m.poster.length || missing.length) {
      logger?.warn(`[landing] media.json: "${v.id}" left out (${missing.length ? `missing ${missing.join(', ')}` : 'no sources or poster'})`);
      continue;
    }
    videos[v.id] = m;
  }
  const loop = raw.loop && raw.loop.sources.every((s) => published(paths, s.src)) ? raw.loop : undefined;
  return { videos, ...(loop ? { loop } : {}) };
}

/** The stills in stills.json whose files are all on disk, per format. */
function loadStills(paths: Paths): Record<string, Still> {
  const meta = (readJson(join(paths.landing, 'stills.json')) ?? {}) as Record<string, { width: number; height: number; widths: number[] }>;
  const stills: Record<string, Still> = {};
  for (const [name, m] of Object.entries(meta)) {
    const formats = (['avif', 'webp'] as const).filter((f) => m.widths.every((w) => existsSync(join(paths.publicDir, 'media/stills', `${name}-${w}.${f}`))));
    if (formats.length) stills[name] = { name, width: m.width, height: m.height, widths: m.widths, formats: [...formats] };
  }
  return stills;
}

/** Everything the pages are rendered from, read fresh. */
function loadSite(paths: Paths, url: string, assets: string, logger?: Logger): Site {
  const contentDir = join(paths.landing, 'content');
  const en = readJson(join(contentDir, 'en.json'));
  if (!en) throw new Error('[landing] src/landing/content/en.json is missing');
  const content = Object.fromEntries(LANGS.map((l) => [l, over(en, readJson(join(contentDir, `${l}.json`)))])) as Record<Lang, LandingContent>;
  const videosEn = readJson(join(contentDir, 'videos.en.json')) ?? {};
  const videoText = Object.fromEntries(LANGS.map((l) => [l, over(videosEn, readJson(join(contentDir, `videos.${l}.json`)))])) as Site['videoText'];
  const og = Object.fromEntries(
    LANGS.map((l): [Lang, OgImage] => [
      l,
      existsSync(join(paths.publicDir, 'og', `${l}.jpg`))
        ? { src: `/og/${l}.jpg`, width: 1200, height: 630, type: 'image/jpeg' }
        : { src: '/og-image.jpg', width: 1200, height: 630, type: 'image/jpeg' },
    ]),
  ) as Record<Lang, OgImage>;
  return {
    url,
    content,
    videoText,
    media: loadMedia(paths, logger),
    stills: loadStills(paths),
    credits: existsSync(join(paths.root, 'credits.html')),
    og,
    assets,
  };
}

/** Warn about words that will be cut short in search results. */
function checkLengths(site: Site, logger: Logger) {
  for (const l of LANGS) {
    const { title, description } = site.content[l].meta;
    if (title.length > 60) logger.warn(`[landing] ${l}: the title is ${title.length} characters (60 at most): ${title}`);
    if (description.length > 155) logger.warn(`[landing] ${l}: the description is ${description.length} characters (155 at most)`);
  }
}

/** The hand-written pages at the app root (park, terms, privacy, ringmaster, credits…). */
const ownPages = (root: string) =>
  readdirSync(root)
    .filter((f) => f.endsWith('.html') && f !== 'index.html')
    .map((f) => f.slice(0, -5));

/** A request a browser makes for a page (not a script, a style or a file). */
function wantsPage(req: IncomingMessage, path: string) {
  if (!/text\/html/.test(req.headers.accept ?? '')) return false;
  if (/^\/(?:@|src\/|node_modules\/|api(?:\/|$))/.test(path)) return false;
  return !/\.[a-z0-9]+$/i.test(path.split('/').pop() ?? '');
}

const send = (res: ServerResponse, status: number, type: string, body: string) => {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
};

const redirect = (res: ServerResponse, to: string) => {
  res.statusCode = 308;
  res.setHeader('Location', to);
  res.end();
};

/** The machine-readable files, by path. */
const FILES: Record<string, [string, (site: Site) => string]> = {
  '/sitemap.xml': ['application/xml; charset=utf-8', sitemap],
  '/robots.txt': ['text/plain; charset=utf-8', robots],
  '/llms.txt': ['text/plain; charset=utf-8', llms],
  '/llms-full.txt': ['text/plain; charset=utf-8', llmsFull],
};

export interface LandingOptions {
  /** The canonical origin (SITE_URL), no trailing slash. */
  site: string;
}

export function landingPages({ site: url }: LandingOptions): Plugin {
  let paths: Paths;
  let config: ResolvedConfig;
  const site = (assets = SOURCE_ASSETS) => loadSite(paths, url, assets, config.logger);

  /**
   * One URL form, as on Vercel (cleanUrls + trailingSlash: false): /fr/ and /fr.html go to /fr with a
   * 308. Returns the route a path names, or redirects and returns null.
   */
  const resolve = (list: Route[], req: IncomingMessage, res: ServerResponse): Route | null | undefined => {
    const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
    const clean = pathname === '/index.html' ? '/' : pathname.replace(/\.html$/, '').replace(/(.)\/+$/, '$1');
    const route = list.find((r) => r.path === clean);
    if (route && clean !== pathname) {
      redirect(res, clean + search);
      return null;
    }
    return route;
  };

  return {
    name: 'landing-pages',
    // after Vite's own HTML plugin, so the built index.html (with its hashed files) is in the bundle
    enforce: 'post',
    configResolved(resolved) {
      config = resolved;
      paths = { root: resolved.root, publicDir: resolved.publicDir, landing: join(resolved.root, 'src/landing') };
    },
    buildStart() {
      checkLengths(site(), config.logger);
    },
    transformIndexHtml: {
      // before Vite reads the page's scripts and styles, so it bundles the rendered page's own
      order: 'pre',
      handler(html) {
        if (!html.includes(MARKER)) return html;
        return routes(site()).find((r) => r.path === '/')!.render(site());
      },
    },
    configureServer(server) {
      // a change to the words, the media or the stills reloads the page
      server.watcher.add([join(paths.landing, 'content'), join(paths.landing, 'media.json'), join(paths.landing, 'stills.json')]);
      server.watcher.on('all', (_event, file) => {
        if (file.startsWith(paths.landing) && file.endsWith('.json')) server.ws.send({ type: 'full-reload' });
      });
      const own = new Set(ownPages(paths.root));
      const handle: Connect.NextHandleFunction = (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        void (async () => {
          const current = site();
          const list = routes(current);
          const route = resolve(list, req, res);
          if (route === null) return;
          const { pathname } = new URL(req.url ?? '/', 'http://localhost');
          const name = pathname.replace(/^\/|\/$|\.html$/g, '');
          const notFound = !route && wantsPage(req, pathname) && !own.has(name);
          if (!route && !notFound) return next();
          const page = route ?? list.find((r) => r.kind === 'notFound')!;
          const html = await server.transformIndexHtml(page.path === '/' ? '/index.html' : `${page.path}.html`, page.render(current), req.originalUrl);
          send(res, page.kind === 'notFound' ? 404 : 200, 'text/html; charset=utf-8', html);
        })().catch(next);
      };
      server.middlewares.use(handle);
    },
    configurePreviewServer(server) {
      // the built pages at their clean URLs, and the 404 page for anything else, as on Vercel
      const outDir = join(paths.root, config.build.outDir);
      const own = new Set(ownPages(paths.root));
      server.middlewares.use((req, res, next) => {
        const { pathname, search } = new URL(req.url ?? '/', 'http://localhost');
        if (pathname.length > 1 && pathname.endsWith('/') && existsSync(join(outDir, `${pathname.slice(0, -1)}.html`))) return redirect(res, pathname.slice(0, -1) + search);
        if (pathname !== '/' && existsSync(join(outDir, `${pathname}.html`))) {
          req.url = `${pathname}.html${search}`;
          return next();
        }
        const name = pathname.replace(/^\/|\/$|\.html$/g, '');
        if (pathname !== '/' && wantsPage(req, pathname) && !own.has(name) && !existsSync(join(outDir, pathname))) {
          return send(res, 404, 'text/html; charset=utf-8', readFileSync(join(outDir, '404.html'), 'utf8'));
        }
        next();
      });
    },
    generateBundle(_options, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') return;
      // the landing entry's hashed CSS and JS, exactly as Vite wrote them into index.html
      const built = String(index.source);
      const assets = [...built.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\/assets\/[^"]+"[^>]*>(?:<\/script>)?/g)].map((m) => m[0]).join('\n');
      const current = site(assets);
      for (const route of routes(current)) {
        if (route.path === '/') continue;
        this.emitFile({ type: 'asset', fileName: route.file, source: route.render(current) });
      }
    },
  };
}

export function seo({ site: url }: LandingOptions): Plugin {
  let paths: Paths;
  let config: ResolvedConfig;
  const site = () => loadSite(paths, url, SOURCE_ASSETS, config.logger);
  return {
    name: 'seo',
    configResolved(resolved) {
      config = resolved;
      paths = { root: resolved.root, publicDir: resolved.publicDir, landing: join(resolved.root, 'src/landing') };
    },
    transformIndexHtml(html) {
      return html.replaceAll('__SITE_URL__', url);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = FILES[new URL(req.url ?? '/', 'http://localhost').pathname];
        if (!file) return next();
        send(res, 200, file[0], file[1](site()));
      });
    },
    generateBundle() {
      const current = site();
      for (const [path, [, make]] of Object.entries(FILES)) this.emitFile({ type: 'asset', fileName: path.slice(1), source: make(current) });
    },
  };
}
