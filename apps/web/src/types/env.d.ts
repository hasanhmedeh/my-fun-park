interface ImportMetaEnv {
  /** Where the accounts API lives. Defaults to `/api` on the same origin (proxied by Vite in dev). */
  readonly VITE_API_URL?: string;
  /** The AdSense publisher id (ca-pub-…) for rewarded ads. Unset: no ads (a stand-in ad under `pnpm dev`). */
  readonly VITE_ADSENSE_CLIENT?: string;
  /** "on" serves Google's test ads instead of real ones. */
  readonly VITE_ADSENSE_TEST?: string;
}
