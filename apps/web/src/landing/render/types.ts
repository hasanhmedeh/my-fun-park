// The shapes the landing page is rendered from. The words live in content/<lang>.json (one file per
// language, the same keys in each), the videos' words in content/videos.<lang>.json and what the film
// pipeline produced in media.json (see ../videos.ts). The plugin (../plugin.ts) reads them, checks
// which stills exist on disk, and hands everything to the render functions as one `Site`.

import type { Lang, MediaManifest, VideoId, VideoText } from '../videos.ts';

/** One attraction (or place) on a card. */
export interface Card {
  /** A name from stills.json; empty or missing draws the gradient instead. */
  still?: string;
  name: string;
  text: string;
  /** One or two verified facts, shown as chips. */
  facts: string[];
  /** A second paragraph, for the wide feature cards. */
  more?: string;
}

/** A group of attractions under one heading in "What's in the park". */
export interface Group {
  id: string;
  /** An icon name from icons.ts. */
  icon: string;
  heading: string;
  lead: string;
  /** One wide card with its picture beside the words. */
  feature?: boolean;
  /** Cards in travel order, numbered, with a dashed route between them. */
  journey?: boolean;
  cards: Card[];
  /** A second row of smaller cards under the first (the games on Palm Cay). */
  extraHeading?: string;
  extra?: Card[];
}

/** A table of controls: `keys` may hold [Key] keycaps. */
export interface ControlTable {
  heading: string;
  rows: { keys: string; action: string }[];
}

/**
 * content/<lang>.json. Text fields may use three bits of markup: [Key] for a keycap, [label](href) for
 * a link and **words** for bold (see text.ts). Everything else is plain text, escaped on the way out.
 */
export interface LandingContent {
  meta: {
    /** At most 60 characters. */
    title: string;
    /** At most 155 characters. */
    description: string;
    /** YYYY-MM-DD: when the words last changed (the page's "Updated" date and dateModified). */
    updated: string;
  };
  /** For the Open Graph image renderer: /og/<lang>.jpg. */
  og: { headline: string; tagline: string; alt: string };
  ui: {
    skip: string;
    menu: string;
    language: string;
    home: string;
    play: string;
    nav: { trailer: string; attractions: string; howToPlay: string; tutorials: string; faq: string };
    comingSoon: string;
    watch: string;
    playVideo: string;
    pauseLoop: string;
    playLoop: string;
    youtube: string;
    download: string;
    updated: string;
    scrollHint: string;
    minutes: string;
    seconds: string;
  };
  hero: {
    kicker: string;
    brand: string;
    what: string;
    lead: string;
    cta: string;
    secondary: string;
    badges: string[];
  };
  summary: { heading: string; paragraphs: string[] };
  facts: { heading: string; rows: { label: string; value: string }[] };
  trailer: { heading: string; lead: string; comingSoon: string; comingSoonNote: string; chapters: string };
  attractions: { heading: string; lead: string; groups: Group[] };
  howToPlay: {
    heading: string;
    lead: string;
    keyboard: ControlTable;
    touch: ControlTable;
    rides: ControlTable;
    notes: string[];
  };
  tickets: {
    heading: string;
    lead: string;
    cards: { tag: string; soon?: boolean; title: string; text: string }[];
    note: string;
  };
  tutorials: { heading: string; lead: string };
  faq: { heading: string; items: { q: string; a: string }[] };
  creator: {
    kicker: string;
    heading: string;
    paragraphs: string[];
    links: { label: string; href: string; icon: string }[];
    cta: string;
    /** The museum-style plaque beside the story. */
    plaque: { since: string; role: string };
  };
  cta: { heading: string; text: string; button: string; note: string };
  share: { heading: string; text: string; native: string; copy: string; copied: string };
  footer: {
    tagline: string;
    explore: string;
    legal: string;
    languages: string;
    terms: string;
    privacy: string;
    credits: string;
    contact: string;
    madeBy: string;
  };
  /** The language suggestion, written in this file's language (it's shown to people who read it). */
  banner: { text: string; go: string; dismiss: string };
  watch: { videos: string; inThisVideo: string; steps: string; transcript: string; more: string; breadcrumb: string; duration: string };
  hub: { title: string; description: string; heading: string; lead: string };
  notFound: { title: string; kicker: string; heading: string; text: string; home: string; play: string };
  /** Still name → its alt text in this language. */
  stills: Record<string, string>;
}

/** A still that exists on disk: public/media/stills/<name>-<w>.<format>. */
export interface Still {
  name: string;
  width: number;
  height: number;
  widths: number[];
  formats: ('avif' | 'webp')[];
}

/** An Open Graph image: /og/<lang>.jpg once rendered, the old shared one until then. */
export interface OgImage {
  src: string;
  width: number;
  height: number;
  type: string;
}

/** Everything a page is rendered from. */
export interface Site {
  /** The canonical origin, no trailing slash (SITE_URL). */
  url: string;
  content: Record<Lang, LandingContent>;
  /** Per language; a missing video falls back to the English words. */
  videoText: Record<Lang, Partial<Record<VideoId, VideoText>>>;
  media: MediaManifest;
  /** Only the stills whose files exist. */
  stills: Record<string, Still>;
  /** Whether credits.html is part of this build. */
  credits: boolean;
  og: Record<Lang, OgImage>;
  /** The tags that load the landing page's CSS and JS: the sources in dev, the hashed bundles in a build. */
  assets: string;
}
