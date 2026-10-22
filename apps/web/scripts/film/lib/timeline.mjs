// A shot list laid end to end: where each shot starts in the finished video (a crossfade overlaps
// two shots, a cut doesn't), where the chapters start, and when each subtitle shows. Also the
// checks a video must pass before it's worth filming (lint): YouTube's chapter rules, the
// contract's lengths (src/landing/videos.ts), subtitles that can be read at a natural pace.
//
// A shot list (scripts/film/shots/<id>.mjs) is { id, fps, music, defaults, shots: [...] }; each
// shot has `duration` (seconds) or `beats` (of the music's tempo), `in` ('cut', { xfade: s } or
// { fade: s } from black), `out` ({ fade: s } to black), an optional `chapter` id and `cues`:
// [{ id, at, end?, dur? }] in seconds from the shot's start.

/** Seconds of a shot: its `duration`, or its `beats` at the list's music tempo. */
export function shotSeconds(list, shot) {
  if (typeof shot.duration === 'number') return shot.duration;
  if (typeof shot.beats === 'number') {
    const bpm = list.music?.bpm;
    if (!bpm) throw new Error(`${list.id}/${shot.id}: beats need the music's bpm`);
    return (shot.beats * 60) / bpm;
  }
  throw new Error(`${list.id}/${shot.id}: no duration`);
}

/** How long a shot's start overlaps the shot before it (a crossfade), in seconds. */
const overlapOf = (shot) => (shot.in && typeof shot.in === 'object' && shot.in.xfade ? shot.in.xfade : 0);

/**
 * The shots in `cut` order with their place in the video: { shot, start, duration, overlap }, the
 * video's length, its chapters ({ id, start }: whole seconds, as YouTube shows them) and its cues
 * ({ id, start, end }, seconds, to the millisecond).
 */
export function layout(list, shots = list.shots) {
  const placed = [];
  let t = 0;
  for (const [i, shot] of shots.entries()) {
    const duration = shotSeconds(list, shot);
    const overlap = i === 0 ? 0 : overlapOf(shot);
    const start = i === 0 ? 0 : t - overlap;
    placed.push({ shot, start, duration, overlap });
    t = start + duration;
  }
  const duration = t;
  const chapters = [];
  for (const p of placed) {
    if (!p.shot.chapter) continue;
    // (a crossfade's chapter starts where the new shot is half in)
    const start = chapters.length === 0 ? 0 : Math.round(p.start + p.overlap / 2);
    chapters.push({ id: p.shot.chapter, start });
  }
  const cues = [];
  for (const p of placed)
    for (const c of p.shot.cues ?? []) {
      const start = p.start + c.at;
      const end = c.end !== undefined ? p.start + c.end : c.dur !== undefined ? start + c.dur : p.start + p.duration - 0.25;
      cues.push({ id: c.id, start: round3(start), end: round3(Math.min(end, duration)) });
    }
  cues.sort((a, b) => a.start - b.start);
  return { shots: placed, duration: round3(duration), chapters, cues };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------------------------

/** The most characters a subtitle line should have (videos.ts: two lines of about 42). */
export const LINE = 42;
/** Characters per second a viewer reads comfortably (the BBC's and Netflix's guidance is 15–17 for adults). */
export const READING_CPS = 17;

/**
 * A subtitle's text in lines: its own line breaks if it has them, otherwise one line, or two
 * balanced ones when it's longer than LINE.
 */
export function lines(text) {
  const t = String(text).trim();
  if (t.includes('\n')) return t.split('\n').map((l) => l.trim());
  if (t.length <= LINE) return [t];
  // the space nearest the middle that keeps both lines short
  const words = t.split(' ');
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { a, b, score };
  }
  return best ? [best.a, best.b] : [t];
}

const RLM = '‏';
/** Right-to-left languages: each line starts with a right-to-left mark, so a line that opens with a Latin word or a number still reads from the right. */
export const RTL = new Set(['ar']);

function stamp(seconds, sep) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(f).padStart(3, '0')}`;
}

/** The cues that have text in `captions` (cue id → text), as lines ready to write. */
function cueLines(cues, captions, lang) {
  return cues
    .filter((c) => captions[c.id])
    .map((c) => ({ ...c, lines: lines(captions[c.id]).map((l) => (RTL.has(lang) ? `${RLM}${l}` : l)) }));
}

/** WebVTT for the page's <track> and YouTube. */
export function toVtt(cues, captions, lang) {
  const body = cueLines(cues, captions, lang)
    .map((c) => `${c.id}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}`)
    .join('\n\n');
  return `WEBVTT\nLanguage: ${lang}\n\n${body}\n`;
}

/** SubRip, for YouTube (and anything that won't take WebVTT). */
export function toSrt(cues, captions, lang) {
  return `${cueLines(cues, captions, lang)
    .map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}`)
    .join('\n\n')}\n`;
}

/**
 * Advanced SubStation (libass), for subtitles burnt into a picture `width` × `height` (a review
 * copy, the vertical teaser): the park's cream on a translucent ink box, a font every Windows
 * has (Segoe UI shapes Arabic too; libass mirrors right-to-left lines itself).
 */
export function toAss(cues, captions, lang, { width, height }) {
  const portrait = height > width;
  const size = Math.round(height * (portrait ? 0.034 : 0.05));
  const margin = Math.round(height * (portrait ? 0.2 : 0.07));
  const t = (s) => {
    const cs = Math.round(s * 100);
    return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  };
  const events = cueLines(cues, captions, lang)
    .map((c) => `Dialogue: 0,${t(c.start)},${t(c.end)},Film,,0,0,0,,${c.lines.map((l) => l.replace(/[{}]/g, '')).join('\\N')}`)
    .join('\n');
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Film,Segoe UI,${size},&H00E3F5FF,&H00E3F5FF,&H4038121D,&H4038121D,-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,2,${Math.round(width * 0.08)},${Math.round(width * 0.08)},${margin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

/** The contract's limits (src/landing/videos.ts) and YouTube's chapter rules (research.md 7). */
const LIMITS = { title: 70, description: 160, trailer: [60, 90], tutorial: [60, 120], vertical: [20, 30], chapterMin: 10, chaptersMin: 3 };

/**
 * Everything wrong with a video before it's filmed: { errors, warnings }. `texts` is lang → that
 * language's VideoText for this video (English at least). Errors stop a render; warnings don't.
 */
export function lint(list, texts) {
  const errors = [];
  const warnings = [];
  const { duration, chapters, cues } = layout(list);
  const kind = list.kind ?? 'tutorial';
  const [min, max] = LIMITS[kind] ?? [0, Infinity];
  if (duration < min || duration > max) (kind === 'vertical' ? warnings : errors).push(`${duration.toFixed(1)} s long: a ${kind} should be ${min}–${max} s`);
  // shots
  const ids = new Set();
  for (const s of list.shots) {
    if (ids.has(s.id)) errors.push(`two shots called "${s.id}"`);
    ids.add(s.id);
  }
  // chapters (YouTube: the first at 0:00, at least three, each at least 10 s, in order)
  if (kind !== 'vertical') {
    if (chapters.length < LIMITS.chaptersMin) errors.push(`${chapters.length} chapters: YouTube needs at least ${LIMITS.chaptersMin}`);
    if (chapters.length && chapters[0].start !== 0) errors.push('the first chapter must start at 0:00');
    for (const [i, c] of chapters.entries()) {
      const end = chapters[i + 1]?.start ?? duration;
      if (end - c.start < LIMITS.chapterMin) errors.push(`chapter "${c.id}" lasts ${(end - c.start).toFixed(1)} s: YouTube needs ${LIMITS.chapterMin} s or more`);
    }
    const seen = new Set();
    for (const c of chapters) {
      if (seen.has(c.id)) errors.push(`chapter "${c.id}" starts twice`);
      seen.add(c.id);
    }
  }
  // cues: in order, not overlapping, long enough to read
  for (const [i, c] of cues.entries()) {
    if (c.end - c.start < 1) errors.push(`cue "${c.id}" shows for ${(c.end - c.start).toFixed(2)} s: under a second`);
    const next = cues[i + 1];
    if (next && next.start < c.end - 0.001) errors.push(`cues "${c.id}" and "${next.id}" overlap (${c.end.toFixed(2)} > ${next.start.toFixed(2)})`);
  }
  // the words, per language
  for (const [lang, text] of Object.entries(texts)) {
    if (!text) {
      warnings.push(`${lang}: no text for this video yet`);
      continue;
    }
    const where = `${lang}`;
    if (!text.title) errors.push(`${where}: no title`);
    else if ([...text.title].length > LIMITS.title) errors.push(`${where}: the title is ${[...text.title].length} characters (at most ${LIMITS.title})`);
    if (!text.description) errors.push(`${where}: no description`);
    else if ([...text.description].length > LIMITS.description) errors.push(`${where}: the description is ${[...text.description].length} characters (at most ${LIMITS.description})`);
    if (!text.longDescription) errors.push(`${where}: no long description`);
    if (kind === 'tutorial' && !text.steps?.length) errors.push(`${where}: a tutorial needs its steps`);
    for (const c of chapters) if (!text.chapters?.[c.id]) errors.push(`${where}: no label for chapter "${c.id}"`);
    for (const id of Object.keys(text.chapters ?? {})) if (!chapters.some((c) => c.id === id)) warnings.push(`${where}: chapter "${id}" has a label but no shot starts it`);
    const cueIds = new Set(cues.map((c) => c.id));
    for (const id of Object.keys(text.captions ?? {})) if (!cueIds.has(id)) warnings.push(`${where}: caption "${id}" is never shown (no shot cues it)`);
    for (const c of cues) {
      const words = text.captions?.[c.id];
      if (!words) {
        errors.push(`${where}: no words for cue "${c.id}"`);
        continue;
      }
      const ls = lines(words);
      if (ls.length > 2) errors.push(`${where}: cue "${c.id}" runs to ${ls.length} lines`);
      for (const l of ls) if ([...l].length > LINE + 4) errors.push(`${where}: cue "${c.id}" has a ${[...l].length}-character line: "${l}"`);
      const cps = [...words.replace(/\s+/g, ' ')].length / (c.end - c.start);
      if (lang === 'en' && cps > READING_CPS) warnings.push(`${where}: cue "${c.id}" reads at ${cps.toFixed(1)} characters a second (over ${READING_CPS}): give it more time or fewer words`);
    }
  }
  return { errors, warnings, duration, chapters, cues };
}
