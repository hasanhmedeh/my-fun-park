// The vertical teaser: about 28 s at 1080 × 1920 for Shorts, Reels and stories, cut from the
// trailer's own shots and music. The logo over the park, then a hard cut on every two bars from
// the drop (the coaster's loop, the Sky Falcon, the Sky Flip, the karts, the take-off at dusk,
// the jet-skis) and the end card.
//
// No words at all: no subtitles, nothing to translate (its text, for a page or an upload, is the
// trailer's: `textFrom`). Each shot's `vertical` settings (trailer.mjs) reframe it for portrait,
// and the overrides here shorten it to two bars. It's made into out/teaser/ only, not published.
//
//   node scripts/film/film.mjs teaser [--draft]

import { endCard, helpers, PARK_HOUR } from './common.mjs';
import { BEAT, MUSIC_FROM, SHOTS } from './trailer.mjs';

/** A trailer shot cut to `beats`, with no chapter or subtitles, and the teaser's own portrait settings over its own. */
function cutDown(shot, beats, vertical = {}) {
  return { ...shot, beats, chapter: undefined, cues: [], vertical: { ...(shot.vertical ?? {}), ...vertical } };
}

export default {
  id: 'teaser',
  kind: 'vertical',
  textFrom: 'trailer',
  fps: 30,
  size: [1080, 1920],
  // the music from 16 beats before the drop, so the drop lands on the first cut
  music: { track: 'flags', from: MUSIC_FROM + 48 * BEAT, fadeIn: 0.3, fadeOut: 2.5 },
  session: { enter: true },
  defaults: { ui: 'clean', hour: PARK_HOUR, visitor: false, hide: 20 },
  helpers,
  poster: { shot: 'loop', at: 1.4 },
  shots: [
    { ...SHOTS.aerial, beats: 16, chapter: undefined, cues: [] },
    cutDown(SHOTS.loop, 8),
    cutDown(SHOTS.falcon, 8),
    cutDown(SHOTS.flip, 8),
    cutDown(SHOTS.speedway, 8),
    // (the lift-off comes about 3 s in: this one keeps its 12 beats)
    cutDown(SHOTS.takeoff, 12),
    cutDown(SHOTS.jetski, 8, { fov: 62 }),
    endCard({ seconds: 12 * BEAT, xfade: 2 * BEAT }),
  ],
};
