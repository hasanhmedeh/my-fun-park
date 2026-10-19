import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';

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
 * /ads.txt, which AdSense checks before it serves ads here: it names the publisher id (from
 * VITE_ADSENSE_CLIENT, ca-pub-…) as the site's seller. Left out without one.
 */
function adsTxt(client: string): Plugin {
  const publisher = client.trim().replace(/^ca-/, '');
  return {
    name: 'ads-txt',
    generateBundle() {
      if (!/^pub-\d+$/.test(publisher)) return;
      this.emitFile({ type: 'asset', fileName: 'ads.txt', source: `google.com, ${publisher}, DIRECT, f08c47fec0942fa0\n` });
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

// Let ngrok tunnels reach the dev/preview server (a leading dot allows every subdomain,
// so new random tunnel URLs keep working without editing this file).
const tunnelHosts = ['.ngrok-free.app', '.ngrok-free.dev', '.ngrok.app', '.ngrok.io'];

// The accounts API (apps/api) runs beside the dev server; proxying it keeps the browser on one
// origin, so the session cookie just works. `xfwd` passes the browser's host along (X-Forwarded-Host),
// so "Continue with Google" sends people back here rather than to the API's own port.
const proxy = {
  '/api': { target: 'http://localhost:3000', changeOrigin: true, xfwd: true },
};

export default defineConfig(({ mode }) => ({
  // VITE_ADSENSE_CLIENT from apps/web/.env* or the environment (Vercel's project settings)
  plugins: [seo(), cleanUrls(), adsTxt(loadEnv(mode, process.cwd(), 'VITE_').VITE_ADSENSE_CLIENT ?? '')],
  // `open` launches the browser on `pnpm dev` (BROWSER=none skips it)
  server: { allowedHosts: tunnelHosts, open: true, proxy },
  preview: { allowedHosts: tunnelHosts, proxy },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1300,
    // The game, the legal pages and The Ringmaster's Office (served as /terms, /privacy and
    // /ringmaster thanks to cleanUrls in vercel.json)
    rolldownOptions: {
      input: { index: page('./index.html'), terms: page('./terms.html'), privacy: page('./privacy.html'), ringmaster: page('./ringmaster.html') },
    },
  },
}));
