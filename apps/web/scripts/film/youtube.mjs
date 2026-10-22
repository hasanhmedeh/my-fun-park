// Everything a video needs on YouTube, in scripts/film/out/youtube/<id>/, ready for its owner to
// upload by hand (nothing here talks to YouTube):
//
//   <id>.master.mp4     the film for upload: 1920 × 1080 H.264 at a high bitrate (CRF 17, closed
//                       GOPs of half a second) and AAC at 320 kbit/s, with a 12 s end card laid
//                       out for YouTube's end screen (the logo and address on the left, its
//                       elements on the right)
//   thumbnail.jpg       1280 × 720, under 2 MB: the poster frame, the logo and a few words
//   <lang>.title.txt    the title, per language
//   <lang>.description.txt
//                       the hook, the play link, the page in that language, the long description,
//                       the chapters ("0:00 Label"), the other tutorials and 3–5 hashtags
//   tags.txt            the tags, comma-separated (YouTube's 500 characters at most)
//   <lang>.vtt, .srt    the subtitles, per language
//   UPLOAD.md           what goes where in YouTube Studio, with the owner's decisions marked
//
//   node scripts/film/youtube.mjs <id> [--draft] [--refilm] [--verbose]
//
// The game's takes are shared with film.mjs (the same cache), so a video that has been filmed
// isn't filmed again; only the end card is drawn again, in its YouTube layout. --draft makes the
// package from the draft takes at 960 × 540, for checking it: never upload a draft.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { checkFonts, page as cardPage, thumbnail, WEB_URL } from './lib/cards.mjs';
import { launch } from './lib/chrome.mjs';
import { credit, frame, render } from './lib/media.mjs';
import { toSrt, toVtt } from './lib/timeline.mjs';
import { CONTENT, cut, filmShots, FILM, LANGS, loadList, parseArgs, report, SITE_URL, sizeOf, textId, texts } from './film.mjs';

/** The landing page's videos in page order (src/landing/videos.ts VIDEOS): id = slug. */
const VIDEO_IDS = ['trailer', 'getting-started', 'tickets-and-account', 'thrill-rides', 'games-and-races', 'coaster-workshop', 'fly-to-palm-cay', 'your-look'];
const TUTORIALS = VIDEO_IDS.slice(1);
/** The game itself (src/landing/render/layout.ts PLAY_HREF). */
const PLAY_URL = `${SITE_URL}/park`;
/** How long YouTube's end card runs: its end screen needs 5–20 s at the end. */
const END_SECONDS = 12;
/** YouTube's limits. */
const MAX_TITLE = 100;
const MAX_DESCRIPTION = 5000;
const MAX_TAGS = 500;
const MAX_THUMBNAIL = 2 * 1024 * 1024;
const PLAYLIST = 'The Funfair tutorials';

/** A path on the site in a language (src/landing/render/langs.ts localPath): English has no prefix. */
const localPath = (lang, path = '/') => (lang === 'en' ? path : path === '/' ? `/${lang}` : `/${lang}${path}`);
const watchUrl = (lang, id) => `${SITE_URL}${localPath(lang, `/videos/${id}`)}`;

/** m:ss (h:mm:ss past an hour), as YouTube reads chapter times. */
function clock(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** A tag as a hashtag: "browser game" → #BrowserGame (words without capitals, like Arabic, are joined with _). */
function hashtag(tag) {
  const words = tag.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const cased = words.some((w) => w.toLowerCase() !== w.toUpperCase());
  return `#${cased ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join('') : words.join('_')}`;
}

/** 3–5 hashtags: the park's name, then the video's tags. */
function hashtags(tags) {
  const out = ['#TheFunfair'];
  for (const t of [...(tags ?? []), 'browser game', 'theme park game']) {
    const h = hashtag(t);
    if (h && !out.some((x) => x.toLowerCase() === h.toLowerCase())) out.push(h);
    if (out.length === 5) break;
  }
  return out;
}

/** content/<lang>.json, for the page's own words (the play button, "More videos", the game's language). */
function landingWords(lang) {
  const read = (l) => JSON.parse(readFileSync(join(CONTENT, `${l}.json`), 'utf8'));
  const own = existsSync(join(CONTENT, `${lang}.json`)) ? read(lang) : read('en');
  // the facts table's "Game language" row (found by its English label: the rows are in the same order in every language)
  const row = read('en').facts.rows.findIndex((r) => /language/i.test(r.label));
  const gameLanguage = own.facts?.rows?.[row] ?? null;
  return { home: own.ui.home, play: own.ui.play, chapters: own.watch.inThisVideo, more: own.watch.more, gameLanguage };
}

/** YouTube refuses < and > in titles and descriptions. */
const clean = (s) => s.replace(/</g, '‹').replace(/>/g, '›');

/** The description for `lang`: the hook, the links, the long description, the chapters, the other tutorials, the music's credit, the hashtags. */
function description(id, lang, words, chapters, all, music) {
  const page = landingWords(lang);
  const lines = [words.description, '', `▶ ${page.play}: ${PLAY_URL}`, `${page.home}: ${SITE_URL}${localPath(lang)}`];
  // the game's interface is English only: say so wherever the words aren't
  if (lang !== 'en' && page.gameLanguage) lines.push(`${page.gameLanguage.label}: ${page.gameLanguage.value}`);
  lines.push('', words.longDescription.trim(), '', `${page.chapters}:`);
  for (const c of chapters) lines.push(`${clock(c.start)} ${words.chapters[c.id]}`);
  const others = TUTORIALS.filter((t) => t !== id);
  lines.push('', `${page.more}:`);
  for (const t of others) {
    const title = all[t]?.[lang]?.title ?? all[t]?.en?.title;
    if (title) lines.push(`• ${title}: ${watchUrl(lang, t)}`);
  }
  // (the music is CC0: no credit is owed, but it's given, as on the site's credits page)
  if (music) lines.push('', `♪ ${music}`);
  lines.push('', hashtags(words.tags).join(' '));
  return clean(lines.join('\n'));
}

/** The tags of every language, once each, cut to YouTube's 500 characters (a tag with a space counts its quotes too). */
function tagList(byLang) {
  const out = [];
  let used = 0;
  for (const lang of LANGS) {
    for (const t of byLang[lang]?.tags ?? []) {
      if (out.some((x) => x.toLowerCase() === t.toLowerCase())) continue;
      const cost = [...t].length + (/\s/.test(t) ? 2 : 0) + (out.length ? 1 : 0);
      if (used + cost > MAX_TAGS) continue;
      out.push(t);
      used += cost;
    }
  }
  return out;
}

/** The thumbnail: the poster frame under the logo and the list's words, drawn at 1280 × 720. */
async function makeThumbnail(list, master, at, dir) {
  const png = join(dir, 'poster.png');
  await frame(master, at, png);
  const card = thumbnail({ image: pathToFileURL(png).href, words: list.thumbnail?.words ?? '', kicker: list.thumbnail?.kicker ?? '' });
  const chrome = await launch({ width: 1280, height: 720, log: () => {} });
  let shot;
  try {
    await chrome.setContent(cardPage(card, { width: 1280, height: 720 }), WEB_URL);
    await checkFonts(chrome);
    shot = await chrome.screenshot({ format: 'png' });
  } finally {
    await chrome.close();
    rmSync(png, { force: true });
  }
  for (let q = 92; q >= 60; q -= 8) {
    const buf = await sharp(shot).jpeg({ quality: q, mozjpeg: true }).toBuffer();
    if (buf.length <= MAX_THUMBNAIL) {
      writeFileSync(join(dir, 'thumbnail.jpg'), buf);
      return buf.length;
    }
  }
  throw new Error('the thumbnail is over 2 MB even at JPEG 60');
}

/** UPLOAD.md: the Studio's fields, in the order the upload asks for them. */
function uploadNotes({ id, list, draft, master, info, thumbBytes, byLang, langs, chapters, tags, endAt, subtitles, music }) {
  const en = byLang.en;
  const i = VIDEO_IDS.indexOf(id);
  const next = list.kind === 'trailer' ? TUTORIALS[0] : (TUTORIALS[TUTORIALS.indexOf(id) + 1] ?? 'trailer');
  const nextTitle = texts(next).en?.title ?? next;
  const out = [];
  out.push(`# ${en.title}`, '');
  if (draft) out.push('> **DRAFT.** Made from the 960 × 540 draft takes to check the package. Do not upload it: run `node scripts/film/youtube.mjs ' + id + '` (without --draft) for the real one.', '');
  out.push(
    'Nothing has been uploaded: this folder is for the channel owner to upload by hand in YouTube Studio.',
    '',
    '## Files',
    '',
    `- \`${master}\`: ${info.video.width} × ${info.video.height}, ${info.duration.toFixed(2)} s, ${(info.bytes / 1e6).toFixed(1)} MB (H.264 High, CRF 17, AAC 320 kbit/s, 48 kHz)`,
    `- \`thumbnail.jpg\`: 1280 × 720, ${(thumbBytes / 1024).toFixed(0)} KB`,
    `- titles and descriptions: ${langs.map((l) => `\`${l}.title.txt\`, \`${l}.description.txt\``).join('; ')}`,
    `- subtitles: ${subtitles.length ? subtitles.map((l) => `\`${l}.srt\` (and \`${l}.vtt\`)`).join(', ') : 'none (this video has no spoken words or subtitles)'}`,
    '- `tags.txt`',
    '',
    '## Details',
    '',
    `- **Title** (English): ${en.title}`,
    '- **Description** (English): paste `en.description.txt` as it is (the chapters in it make YouTube\'s chapters).',
    '- **Thumbnail**: `thumbnail.jpg`.',
    `- **Playlist**: ${list.kind === 'trailer' ? `"${PLAYLIST}", first (and the channel trailer, if the owner wants one)` : `"${PLAYLIST}", in the page's order (number ${i} of ${TUTORIALS.length} after the trailer)`}.`,
    '- **Audience ("made for kids")**: the owner\'s decision; YouTube asks it on every upload. For reference, the game\'s sign-up asks players to be 15 or older or to have a parent\'s permission.',
    '- **Age restriction**: none needed (no violence, no mature content).',
    '- **Altered or synthetic content**: the footage is real gameplay recorded from the game in a browser, driven by scripted keyboard and mouse input; nothing realistic was generated.',
    '- **Paid promotion**: no.',
    `- **Tags**: paste \`tags.txt\` (${tags.length} tags, ${tags.join(', ').length} characters).`,
    `- **Language**: video language English, title and description language English${subtitles.length ? ', caption certification: none (no TV broadcast)' : ''}.`,
    '- **Category**: Gaming.',
    '- **Licence**: Standard YouTube Licence (the owner may prefer otherwise). Comments: the owner\'s choice.',
    '',
    '## Translations (Studio → Subtitles → Add language)',
    '',
  );
  for (const lang of langs.filter((l) => l !== 'en')) {
    const w = byLang[lang];
    const same = w.title === en.title && w.description === en.description;
    out.push(`- **${lang}**: title and description from \`${lang}.title.txt\` and \`${lang}.description.txt\`${subtitles.includes(lang) ? `, subtitles \`${lang}.srt\`` : ''}.${same ? ' **Not translated yet** (the words are still the English ones): skip this language until they are.' : ''}`);
  }
  if (subtitles.includes('en')) out.push('- **en** subtitles: `en.srt` (upload "with timing").');
  out.push('', '## Chapters', '', 'They are in every description; YouTube makes them from the lines below (the first at 0:00, each at least 10 s).', '', '```');
  for (const c of chapters) out.push(`${clock(c.start)} ${en.chapters[c.id]}`);
  out.push('```', '', '## End screen', '');
  out.push(
    `The last ${END_SECONDS} s (from ${clock(endAt)}) are the end card: the logo, "free in your browser" and the address on the left half; the right half is left empty for the end screen. Suggested, from ${clock(endAt + 1)} to the end:`,
    '',
    `- a video element: "${nextTitle}"${list.kind === 'trailer' ? ' (the first tutorial)' : ' (the next one in the playlist)'}, at the top right;`,
    `- a playlist element: "${PLAYLIST}", below it;`,
    '- the subscribe button, at the bottom right.',
    '',
    'Keep the elements off the left half, where the address is.',
    '',
  );
  if (music) out.push('## Music', '', `${music}. CC0, so no credit is owed; the description gives one anyway (the ♪ line). If Content ID ever claims it, dispute the claim with the source link.`, '');
  out.push('## Links in the description', '', `- play: ${PLAY_URL}`, `- the page: ${langs.map((l) => `${SITE_URL}${localPath(l)}`).join(', ')}`, `- the other tutorials' watch pages (${SITE_URL}/videos/<id>): they open once those videos are published on the page.`, '');
  return `${out.join('\n')}\n`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.id) throw new Error('which video? node scripts/film/youtube.mjs <id> (a file in scripts/film/shots/)');
  const list = await loadList(o.id);
  if (list.kind === 'vertical') throw new Error(`${list.id} is vertical: a YouTube package is for the 16:9 films`);
  if (!report(list)) throw new Error('fix the errors above first');
  const id = list.id;
  const byLang = texts(textId(list));
  const langs = LANGS.filter((l) => byLang[l]);
  if (!byLang.en) throw new Error(`no English words for ${id} in content/videos.en.json`);
  const size = sizeOf(list, { draft: o.draft });
  const width = size.width * size.scale;
  const height = size.height * size.scale;
  const dir = join(FILM, 'out', 'youtube', id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  // YouTube's end card: longer, for its end screen, and laid out to leave it room
  const overrides = Object.fromEntries(list.shots.filter((s) => s.card?.type === 'end').map((s) => [s.id, { duration: END_SECONDS, beats: undefined }]));
  console.log(`the YouTube package for ${id} at ${width} × ${height}${o.draft ? ' (draft)' : ''}`);
  const { files } = await filmShots(list, list.shots, { width: size.width, height: size.height, scale: size.scale, draft: o.draft, refilm: o.refilm, verbose: o.verbose, overrides, youtube: true });
  const c = await cut(list, list.shots, files, { width, height, overrides });
  const masterName = `${id}.master.mp4`;
  const master = join(dir, masterName);
  const t1 = Date.now();
  const info = await render({ cut: { ...c, seconds: c.lay.duration }, encode: 'youtube', out: master, cwd: dir });
  console.log(`  ${masterName}: ${info.duration.toFixed(2)} s, ${(info.bytes / 1e6).toFixed(1)} MB, ${((info.bytes * 8) / info.duration / 1e6).toFixed(1)} Mbit/s (encoded in ${((Date.now() - t1) / 1000).toFixed(0)} s)`);
  // the thumbnail, from the list's poster frame
  const at = list.poster ? (c.lay.shots.find((p) => p.shot.id === list.poster.shot)?.start ?? 0) + (list.poster.at ?? 0) : c.lay.duration * 0.3;
  const thumbBytes = await makeThumbnail(list, master, at, dir);
  // the words
  const music = c.music ? credit(c.music.credit) : null;
  const all = Object.fromEntries(VIDEO_IDS.map((v) => [v, texts(v)]));
  for (const lang of langs) {
    const w = byLang[lang];
    const title = clean(w.title);
    if ([...title].length > MAX_TITLE) throw new Error(`${lang}: the title is over ${MAX_TITLE} characters`);
    const text = description(id, lang, w, c.lay.chapters, all, music);
    if ([...text].length > MAX_DESCRIPTION) throw new Error(`${lang}: the description is ${[...text].length} characters (YouTube takes ${MAX_DESCRIPTION})`);
    writeFileSync(join(dir, `${lang}.title.txt`), `${title}\n`);
    writeFileSync(join(dir, `${lang}.description.txt`), `${text}\n`);
  }
  const tags = tagList(byLang);
  writeFileSync(join(dir, 'tags.txt'), `${tags.join(', ')}\n`);
  // the subtitles: every language that has words for every cue
  const subtitles = [];
  if (c.lay.cues.length) {
    for (const lang of langs) {
      const words = byLang[lang].captions;
      if (!words || !c.lay.cues.every((q) => words[q.id])) continue;
      writeFileSync(join(dir, `${lang}.vtt`), toVtt(c.lay.cues, words, lang));
      writeFileSync(join(dir, `${lang}.srt`), toSrt(c.lay.cues, words, lang));
      subtitles.push(lang);
    }
  }
  const endAt = c.lay.shots.find((p) => p.shot.card?.type === 'end')?.start ?? c.lay.duration - END_SECONDS;
  writeFileSync(join(dir, 'UPLOAD.md'), uploadNotes({ id, list, draft: o.draft, master: masterName, info, thumbBytes, byLang, langs, chapters: c.lay.chapters, tags, endAt, subtitles, music }));
  console.log(`  thumbnail.jpg ${(thumbBytes / 1024).toFixed(0)} KB; ${langs.join(', ')} titles and descriptions; subtitles: ${subtitles.join(', ') || 'none'}; ${tags.length} tags`);
  console.log(`${dir} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try {
    await main();
  } catch (e) {
    console.error(e.message ?? e);
    process.exitCode = 1;
  }
}
