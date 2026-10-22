// The landing page's videos: the trailer and the tutorials. Three files meet here:
//  - this list (which videos exist, their URL slugs, their order);
//  - content/videos.<lang>.json: every word about them, per language (titles, descriptions, steps,
//    chapter labels, subtitle lines), written by people;
//  - media.json: what scripts/film/ produced when it filmed them (files, durations, chapter and
//    subtitle timings), written by the pipeline and absent or partial until then.
// A video without media shows as "coming soon": no player, no watch page, no structured data and
// no sitemap entry, so nothing ever points at a file that isn't there.

export type Lang = 'en' | 'fr' | 'ar';
export const LANGS: readonly Lang[] = ['en', 'fr', 'ar'];

export type VideoId =
  | 'trailer'
  | 'getting-started'
  | 'tickets-and-account'
  | 'thrill-rides'
  | 'games-and-races'
  | 'coaster-workshop'
  | 'fly-to-palm-cay'
  | 'your-look';

export interface VideoEntry {
  id: VideoId;
  /** The watch page: /videos/<slug>, /fr/videos/<slug>, /ar/videos/<slug>. */
  slug: string;
  kind: 'trailer' | 'tutorial';
}

/** In page order. The slug is the id, the same in every language. */
export const VIDEOS: readonly VideoEntry[] = [
  { id: 'trailer', slug: 'trailer', kind: 'trailer' },
  { id: 'getting-started', slug: 'getting-started', kind: 'tutorial' },
  { id: 'tickets-and-account', slug: 'tickets-and-account', kind: 'tutorial' },
  { id: 'thrill-rides', slug: 'thrill-rides', kind: 'tutorial' },
  { id: 'games-and-races', slug: 'games-and-races', kind: 'tutorial' },
  { id: 'coaster-workshop', slug: 'coaster-workshop', kind: 'tutorial' },
  { id: 'fly-to-palm-cay', slug: 'fly-to-palm-cay', kind: 'tutorial' },
  { id: 'your-look', slug: 'your-look', kind: 'tutorial' },
];

/** content/videos.<lang>.json: Record<VideoId, VideoText>. */
export interface VideoText {
  /** At most 70 characters: the page, the structured data and YouTube. */
  title: string;
  /** One or two sentences, at most 160 characters: cards and meta descriptions. */
  description: string;
  /** Two to four short paragraphs (separated by a blank line) for the watch page and YouTube. */
  longDescription: string;
  /** Tutorials: what the viewer does or learns, in order (an ordered list on the watch page). */
  steps?: string[];
  /** Chapter id (from the shot list) → its label. */
  chapters: Record<string, string>;
  /** Subtitle cue id (from the shot list) → its text: at most two lines of about 42 characters. */
  captions: Record<string, string>;
  /** YouTube tags. */
  tags?: string[];
}

/** One encoded file of a video. Paths are site-absolute (/media/…) or full URLs. */
export interface VideoSource {
  src: string;
  /** e.g. 'video/mp4; codecs="avc1.640028"' or 'video/webm; codecs="av01.0.08M.08"'. */
  type: string;
  width: number;
  height: number;
  bytes: number;
}

/** media.json: Partial<Record<VideoId, VideoMedia>>, plus the landing page's silent loop. */
export interface VideoMedia {
  /** Seconds. */
  duration: number;
  /** 'YYYY-MM-DD', the day it was filmed. */
  uploadDate: string;
  /** Best first, the browser takes the first it can play. */
  sources: VideoSource[];
  /** 16:9 still shown before playing, and the structured data's thumbnail (several sizes). */
  poster: { src: string; width: number; height: number; type: string }[];
  /** Language → WebVTT file. */
  captions: Partial<Record<Lang, string>>;
  /** Chapter id → start (seconds), in order. */
  chapters: { id: string; start: number }[];
  /** Once uploaded to YouTube, for "Watch on YouTube" links and the structured data's sameAs. */
  youtubeId: string | null;
}

export interface MediaManifest {
  videos: Partial<Record<VideoId, VideoMedia>>;
  /** The hero's short silent loop (no captions, no chapters), if filmed. */
  loop?: Pick<VideoMedia, 'duration' | 'sources' | 'poster'>;
}
