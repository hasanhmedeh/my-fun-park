import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// Set SITE_URL in Vercel (Project → Settings → Environment Variables) once you
// attach a custom domain. Falls back to the Vercel production URL, then a default.
const SITE_URL = (
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'https://hasanhmedeh.vercel.app')
).replace(/\/$/, '');

function seo(): Plugin {
  return {
    name: 'seo',
    transformIndexHtml(html) {
      return html.replaceAll('__SITE_URL__', SITE_URL);
    },
    generateBundle() {
      const today = new Date().toISOString().slice(0, 10);
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${SITE_URL}/terms</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${SITE_URL}/privacy</loc>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${SITE_URL}/credits</loc>
    <changefreq>monthly</changefreq>
    <priority>0.2</priority>
  </url>
</urlset>
`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nDisallow: /ringmaster\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      });
    },
  };
}

/**
 * The Ringmaster's Office answers at /ringmaster in dev too, as it does on Vercel (where cleanUrls
 * in vercel.json serves ringmaster.html).
 */
function cleanUrls(): Plugin {
  const rewrite = (req: { url?: string }, _res: unknown, next: () => void) => {
    if (req.url && /^\/ringmaster\/?(?=[?#]|$)/.test(req.url)) req.url = req.url.replace(/^\/ringmaster\/?/, '/ringmaster.html');
    next();
  };
  return {
    name: 'clean-urls',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

/**
 * The people's KTX2 textures are transcoded in the browser by the Basis Universal transcoder that
 * three ships beside KTX2Loader. It is served at <base>basis/ in dev and copied into the build from
 * the installed three, so it always matches the loader that calls it (KTX2Loader's
 * setTranscoderPath(`${import.meta.env.BASE_URL}basis/`)).
 */
function basisTranscoder(): Plugin {
  const dir = dirname(createRequire(import.meta.url).resolve('three/examples/jsm/libs/basis/basis_transcoder.js'));
  const types = new Map([
    ['basis_transcoder.js', 'text/javascript'],
    ['basis_transcoder.wasm', 'application/wasm'],
  ]);
  let prefix = '/basis/';
  return {
    name: 'basis-transcoder',
    configResolved: (config) => void (prefix = `${config.base.startsWith('/') ? config.base : '/'}basis/`),
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const type = path.startsWith(prefix) ? types.get(path.slice(prefix.length)) : undefined;
        if (!type) return next();
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(join(dir, path.slice(prefix.length))));
      });
    },
    generateBundle() {
      for (const name of types.keys()) this.emitFile({ type: 'asset', fileName: `basis/${name}`, source: readFileSync(join(dir, name)) });
    },
  };
}

// Let ngrok tunnels reach the dev/preview server (a leading dot allows every subdomain,
// so new random tunnel URLs keep working without editing this file).
const tunnelHosts = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'];

// The accounts API (apps/api) runs beside the dev server; proxying it keeps the browser on one
// origin, so the session cookie just works. `xfwd` passes the browser's host along (X-Forwarded-Host),
// so "Continue with Google" sends people back here rather than to the API's own port.
const proxy = {
  // (API_PORT points a second dev server at a second API, e.g. for a test run beside your own)
  '/api': { target: `http://localhost:${process.env.API_PORT ?? 3000}`, changeOrigin: true, xfwd: true },
};

export default defineConfig({
  plugins: [seo(), cleanUrls(), basisTranscoder()],
  // `open` launches the browser on `pnpm dev` (BROWSER=none skips it)
  server: { allowedHosts: tunnelHosts, open: true, proxy },
  preview: { allowedHosts: tunnelHosts, proxy },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1300,
    // The game, the legal pages, the credits and The Ringmaster's Office (served as /terms,
    // /privacy, /credits and /ringmaster thanks to cleanUrls in vercel.json)
    rolldownOptions: {
      input: {
        index: page('./index.html'),
        terms: page('./terms.html'),
        privacy: page('./privacy.html'),
        credits: page('./credits.html'),
        ringmaster: page('./ringmaster.html'),
      },
      // The engines (three.js with its addons, cannon-es) get a chunk of their own: they load with
      // the Game chunk (in parallel, the same import), and stay cached across releases of the game.
      // The airport, the A320neo and Palm Cay are split off by Game's dynamic import of
      // world/flight/world-kit.ts, which downloads while the fair builds.
      output: {
        codeSplitting: {
          groups: [{ name: 'engines', test: /[\\/]node_modules[\\/](\.pnpm[\\/])?(three|cannon-es)[@\\/]/ }],
        },
      },
    },
  },
});
