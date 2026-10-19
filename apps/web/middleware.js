// Vercel Routing Middleware: private access for the pages. While it's switched on in The
// Ringmaster's Office (Park gates), only the allowed addresses get the game, the legal pages, the
// office and their files; everyone else gets the private sign. The API (/api/*) guards itself, so
// it's left out here. Node.js runtime: it reads the switch and the list from Postgres, with the
// same DATABASE_URL as the API functions.
import { admits } from '@funfair/api/access-gate';

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!api/).*)'],
};

export default async function middleware(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/')) return pass();
  // AdSense's crawler reads it from anywhere; it only names the site's ad seller
  if (path === '/ads.txt') return pass();
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
</style>
</head>
<body>
<main>
  <div class="icon" aria-hidden="true">🔒</div>
  <h1>The Funfair is private right now</h1>
  <p>Only invited visitors can come in at the moment. Come back soon!</p>
  ${ip ? `<p>If you were invited, ask the park's staff to let in your address: <code>${esc(ip)}</code></p>` : ''}
</main>
</body>
</html>`;
}
