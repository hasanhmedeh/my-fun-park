// Vercel Routing Middleware: private access for the game. While it's switched on in The
// Ringmaster's Office (Park gates), only the allowed addresses get the game (/park), the office and
// their files; everyone else gets the private sign. The shop window stays open to all: the landing
// pages, the watch pages, the legal and credits pages and the files that search engines, AI crawlers
// and link previews read (PUBLIC, below). The API (/api/*) guards itself, so it's left out here.
// Node.js runtime: it reads the switch and the list from Postgres, with the same DATABASE_URL as the
// API functions.
import { admits } from '@funfair/api/access-gate';

/**
 * What private access never closes, without asking the database. `config.matcher` keeps the
 * middleware from even starting for these (so the landing page's first byte doesn't wait on it);
 * this list is the safety net inside, and the one place to read what's public. A path added here
 * goes in the matcher too.
 */
const PUBLIC = {
  /** Exact paths (no query string). */
  paths: new Set([
    // the landing page, in English, French and Arabic ('/index' is how Vercel may name '/')
    '/',
    '/index',
    '/index.html',
    '/fr',
    '/fr/',
    '/ar',
    '/ar/',
    // the video hubs (their watch pages are under the prefixes below)
    '/videos',
    '/fr/videos',
    '/ar/videos',
    // the legal pages, the credits, and the page for a wrong address
    '/terms',
    '/terms.html',
    '/privacy',
    '/privacy.html',
    '/credits',
    '/credits.html',
    '/404',
    '/404.html',
    // for search engines, AI crawlers, link previews and browsers
    '/robots.txt',
    '/sitemap.xml',
    '/llms.txt',
    '/llms-full.txt',
    '/site.webmanifest',
    '/favicon.svg',
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/icon-512.png',
    '/og-image.jpg',
  ]),
  /** Everything under these. */
  prefixes: [
    // the video hubs with a trailing slash, and the watch pages
    '/videos/',
    '/fr/videos/',
    '/ar/videos/',
    // the trailer and the tutorials, the stills, the link-preview images, the third-party licences
    '/media/',
    '/og/',
    '/licenses/',
    // Vite's hashed bundles. The game's code is among them, which is fine: the gate keeps people
    // from playing (the page, its models and the API), not the source from being read.
    '/assets/',
  ],
};

/**
 * Whether private access leaves `pathname` open to everyone. Only plainly spelled paths: one with
 * anything percent-encoded or a '..' in it could name another file once the CDN decodes it.
 */
export function isPublic(pathname) {
  if (pathname.includes('%') || pathname.includes('..')) return false;
  return PUBLIC.paths.has(pathname) || PUBLIC.prefixes.some((prefix) => pathname.startsWith(prefix));
}

export const config = {
  runtime: 'nodejs',
  // Every path but /api/* and PUBLIC. Vercel reads this from the source, so it has to stay one plain
  // string, and compiles it with path-to-regexp 6 to ^(?:\/((?!…).*))[\/#\?]?$. In the lookahead,
  // after the leading slash:
  //   api/                                  the API (it guards itself)
  //   (?![^%]*%)(?!.*\.\.)                  nothing encoded and no '..', as in isPublic()
  //   $  index(.html)  fr  ar               the landing pages ('$' is / itself)
  //   [fr/|ar/]videos[/…]                   the video hubs and watch pages
  //   terms privacy credits 404 (.html)     the legal pages, the credits, the 404 page
  //   robots.txt … og-image.jpg             the crawlers' and browsers' files
  //   media/ og/ licenses/ assets/          the folders
  matcher: [
    '/((?!api/|(?![^%]*%)(?!.*\\.\\.)(?:$|index(?:\\.html)?$|(?:fr|ar)/?$|(?:(?:fr|ar)/)?videos(?:/|$)|(?:terms|privacy|credits|404)(?:\\.html)?$|(?:robots\\.txt|sitemap\\.xml|llms\\.txt|llms-full\\.txt|site\\.webmanifest|favicon\\.svg|favicon\\.ico|apple-touch-icon\\.png|icon-512\\.png|og-image\\.jpg)$|(?:media|og|licenses|assets)/)).*)',
  ],
};

export default async function middleware(request) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith('/api/') || isPublic(pathname)) return pass();
  // set by Vercel's edge (anything the browser sent is overwritten), and read the same way by the API
  const { allowed, ip } = await admits(request.headers.get('x-real-ip'));
  if (allowed) return pass();
  return new Response(privatePage(ip), {
    status: 403,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' },
  });
}

/** Carry on to the page (what `next()` from @vercel/functions answers). */
const pass = () => new Response(null, { headers: { 'x-middleware-next': '1' } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function privatePage(ip) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>The Funfair is private</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
    background: #14101f; color: #f4eefc; font: 16px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  main { max-width: 420px; text-align: center; }
  .icon { font-size: 3rem; }
  h1 { margin: 8px 0; font-size: 1.6rem; }
  p { margin: 8px 0; color: #c9bfdc; }
  code { padding: 2px 6px; border-radius: 6px; background: #2a2140; color: #f4eefc; }
  .look { display: inline-block; margin-top: 12px; padding: 10px 20px; border-radius: 999px; background: #f4eefc; color: #14101f;
    font-weight: 700; text-decoration: none; }
  .look:hover { background: #ffffff; }
  .look:focus-visible { outline: 3px solid #b99cff; outline-offset: 3px; }
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true">🔒</div>
  <h1>The Funfair is private right now</h1>
  <p>Only invited visitors can come in at the moment. Come back soon!</p>
  ${ip ? `<p>If you were invited, ask the park's staff to let in your address: <code>${esc(ip)}</code></p>` : ''}
  <p><a class="look" href="/">See what's inside the park</a></p>
</main>
</body>
</html>`;
}
