// The landing page's Open Graph images, one per language: public/og/<lang>.jpg, 1200 × 630 and
// under 300 KB, as link previews show them. The hero still with the logo, and the page's own
// headline and tagline (content/<lang>.json "og", English where a language hasn't got them),
// drawn by headless Chrome so Arabic is shaped and laid out right to left. The landing plugin
// uses /og/<lang>.jpg once it's there (src/landing/plugin.ts).
//
//   node scripts/film/og.mjs            every language in src/landing/content/
//   node scripts/film/og.mjs en fr      just these

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { checkFonts, ogImage, page, WEB, WEB_URL } from './lib/cards.mjs';
import { launch } from './lib/chrome.mjs';
import { RTL } from './lib/timeline.mjs';

const CONTENT = join(WEB, 'src/landing/content');
const OUT = join(WEB, 'public/og');
/** The background: the hero still (public/media/stills/, made by stills.mjs). */
const STILL = 'public/media/stills/hero-1920.webp';
const SIZE = { width: 1200, height: 630 };
/** Link previews (and some apps' limits): keep each image under this. */
const MAX_BYTES = 300 * 1024;

/** The languages with a content/<lang>.json (not the videos.<lang>.json files). */
function languages() {
  return readdirSync(CONTENT)
    .map((f) => /^([a-z]{2})\.json$/.exec(f)?.[1])
    .filter(Boolean);
}

/** content/<lang>.json's og words, English for any that are missing. */
function words(lang) {
  const read = (l) => JSON.parse(readFileSync(join(CONTENT, `${l}.json`), 'utf8')).og ?? {};
  const en = read('en');
  const own = lang === 'en' ? en : read(lang);
  return { headline: own.headline || en.headline, tagline: own.tagline || en.tagline };
}

/** A JPEG of `png` under MAX_BYTES: the best quality that fits. */
async function jpeg(png) {
  for (let q = 88; q >= 50; q -= 6) {
    const buf = await sharp(png).jpeg({ quality: q, mozjpeg: true, chromaSubsampling: '4:2:0' }).toBuffer();
    if (buf.length <= MAX_BYTES) return { buf, quality: q };
  }
  throw new Error(`can't get the image under ${MAX_BYTES / 1024} KB`);
}

async function main() {
  const known = languages();
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const l of asked) if (!known.includes(l)) throw new Error(`no content/${l}.json (there are: ${known.join(', ')})`);
  const langs = asked.length ? asked : known;
  if (!existsSync(join(WEB, STILL))) throw new Error(`no ${STILL}: make the stills first (node scripts/film/stills.mjs)`);
  mkdirSync(OUT, { recursive: true });
  const chrome = await launch({ ...SIZE, log: (line) => (/error|failed/i.test(line) && !/X4122/.test(line) ? console.log(`  ${line.slice(0, 300)}`) : null) });
  try {
    for (const lang of langs) {
      const dir = RTL.has(lang) ? 'rtl' : 'ltr';
      const { headline, tagline } = words(lang);
      await chrome.setContent(page(ogImage({ image: STILL, headline, tagline, lang, dir }), { ...SIZE, lang, dir }), WEB_URL);
      await checkFonts(chrome);
      const png = await chrome.screenshot({ format: 'png' });
      const { buf, quality } = await jpeg(png);
      const file = join(OUT, `${lang}.jpg`);
      writeFileSync(file, buf);
      console.log(`${file}: ${SIZE.width} × ${SIZE.height}, ${(buf.length / 1024).toFixed(0)} KB (JPEG ${quality}), "${headline}" / "${tagline}"`);
    }
  } finally {
    await chrome.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await main();
  } catch (e) {
    console.error(e.message ?? e);
    process.exitCode = 1;
  }
}
