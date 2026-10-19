// How this build shows ads (see ads.ts), on its own so The Ringmaster's Office can say whether
// players see them without loading the game's session.

/** The AdSense publisher id (ca-pub-…), from VITE_ADSENSE_CLIENT. */
export const ADSENSE_CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT ?? '').trim();
/** VITE_ADSENSE_TEST=on: Google's test ads instead of real ones. */
export const ADSENSE_TEST = import.meta.env.VITE_ADSENSE_TEST === 'on';
/** Under `pnpm dev` without a publisher id: a stand-in ad, so the flow can be tried. */
export const STAND_IN_ADS = !ADSENSE_CLIENT && import.meta.env.DEV;

/** Whether this build can show ads at all. */
export const adsEnabled = !!ADSENSE_CLIENT || STAND_IN_ADS;
