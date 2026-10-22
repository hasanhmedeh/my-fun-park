import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { landingPages, seo } from "./src/landing/plugin.ts";

const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

// Set SITE_URL in Vercel (Project → Settings → Environment Variables) once you
// attach a custom domain. Falls back to the Vercel production URL, then a default.
const SITE_URL = (
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "https://hasanhmedeh.vercel.app")
).replace(/\/$/, "");

/** The pages with a clean URL: on Vercel, cleanUrls in vercel.json serves park.html at /park, and so on. */
const CLEAN_PAGES = ["park", "terms", "privacy", "ringmaster"];

/** A link from before the game moved from / to /park: back from Google (?google=), or a test ride (?coaster=). */
const OLD_GAME_LINK = /^\/\?(?:[^#]*&)?(?:google|coaster)=/;

/**
 * Clean URLs in dev and preview too, as on Vercel: the game at /park, the legal pages at /terms and
 * /privacy, The Ringmaster's Office at /ringmaster. The query string stays (?google=… back from
 * Google, ?coaster=…, ?hour=…, ?cam=…). Old links to the game at / go on to /park, as the matching
 * redirects in vercel.json do.
 */
function cleanUrls(): Plugin {
  const clean = new RegExp(`^/(${CLEAN_PAGES.join("|")})/?(?=[?#]|$)`);
  const route = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    const url = req.url ?? "/";
    if (OLD_GAME_LINK.test(url)) {
      res.writeHead(307, { Location: `/park${url.slice(1)}` });
      res.end();
      return;
    }
    req.url = url.replace(clean, "/$1.html");
    next();
  };
  return {
    name: "clean-urls",
    configureServer: (server) => void server.middlewares.use(route),
    configurePreviewServer: (server) => void server.middlewares.use(route),
  };
}

// Let ngrok tunnels reach the dev/preview server (a leading dot allows every subdomain,
// so new random tunnel URLs keep working without editing this file).
const tunnelHosts = [
  ".ngrok-free.app",
  ".ngrok-free.dev",
  ".ngrok.app",
  ".ngrok.io",
];

// The accounts API (apps/api) runs beside the dev server; proxying it keeps the browser on one
// origin, so the session cookie just works. `xfwd` passes the browser's host along (X-Forwarded-Host),
// so "Continue with Google" sends people back here rather than to the API's own port.
const proxy = {
  "/api": { target: "http://localhost:3000", changeOrigin: true, xfwd: true },
};

export default defineConfig({
  // cleanUrls first, so an old link to the game (/?google=…) goes on to /park before the landing
  // pages answer /; seo() fills in __SITE_URL__ and serves sitemap.xml, robots.txt and the llms files
  plugins: [
    cleanUrls(),
    seo({ site: SITE_URL }),
    landingPages({ site: SITE_URL }),
  ],
  // `open` launches the browser on `pnpm dev` (BROWSER=none skips it)
  server: { allowedHosts: tunnelHosts, open: true, proxy },
  preview: { allowedHosts: tunnelHosts, proxy },
  build: {
    target: "es2020",
    chunkSizeWarningLimit: 1300,
    // The landing page, the game, the legal pages and The Ringmaster's Office (served as /park,
    // /terms, /privacy and /ringmaster thanks to cleanUrls in vercel.json). index.html is the English
    // landing page; the landing plugin writes the French, Arabic, video and 404 pages beside it.
    rolldownOptions: {
      input: {
        index: page("./index.html"),
        park: page("./park.html"),
        terms: page("./terms.html"),
        privacy: page("./privacy.html"),
        ringmaster: page("./ringmaster.html"),
      },
    },
  },
});
