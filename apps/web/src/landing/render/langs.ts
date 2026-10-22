// What differs between the three languages besides the words: the address, the direction, the
// locale for link previews, and the fonts. Each language's name is written in that language, so the
// switcher reads right whatever page you're on (and it can't come from the copied content files).

import type { Lang } from '../videos.ts';

interface LangInfo {
  /** The language's own name, for the switcher. */
  name: string;
  /** A short tag for the compact switcher. */
  short: string;
  dir: 'ltr' | 'rtl';
  /** og:locale (Meta uses ar_AR as its umbrella Arabic locale). */
  ogLocale: string;
  /** Google Fonts families for this language (display=swap is added). */
  fonts: string;
}

// DM Sans and Lilita One are the game's own faces. Neither has Arabic letters, so /ar adds Lalezar
// (a heavy, playful display face in Lilita One's role) and Readex Pro (a clean text face beside
// DM Sans). The Latin faces stay first in the stacks, so Latin words keep the brand look and Arabic
// letters fall through to the Arabic faces. Each family downloads only the subsets a page uses.
const LATIN = 'family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&family=Lilita+One';
const ARABIC = 'family=Lalezar&family=Readex+Pro:wght@400;500;700';

export const LANG_INFO: Record<Lang, LangInfo> = {
  en: { name: 'English', short: 'EN', dir: 'ltr', ogLocale: 'en_US', fonts: LATIN },
  fr: { name: 'Français', short: 'FR', dir: 'ltr', ogLocale: 'fr_FR', fonts: LATIN },
  ar: { name: 'العربية', short: 'ع', dir: 'rtl', ogLocale: 'ar_AR', fonts: `${LATIN}&${ARABIC}` },
};

/** The Google Fonts stylesheet for a language. */
export const fontsHref = (lang: Lang) => `https://fonts.googleapis.com/css2?${LANG_INFO[lang].fonts}&display=swap`;

/**
 * A site path in a language: English has no prefix ('/videos/trailer'), the others do
 * ('/fr/videos/trailer'). `path` starts with '/'; '/' itself is the language's home page ('/fr').
 */
export function localPath(lang: Lang, path = '/'): string {
  if (lang === 'en') return path;
  return path === '/' ? `/${lang}` : `/${lang}${path}`;
}

/** A link to a section of the language's landing page ('/#faq', '/fr#faq'). */
export const sectionHref = (lang: Lang, id: string, onLanding: boolean) => (onLanding ? `#${id}` : `${localPath(lang)}#${id}`);
