// The map's tiles: the world painted (map-paint.ts) into 512 px squares at five levels of detail,
// from 3 px/m (the minimap on foot, ~170 m a tile) down to 0.012 px/m (the World map and the
// minimap's widest flight view, ~44 km a tile). They're painted the first time a view needs them and kept in a small cache, so the
// minimap only ever blits a few of them each frame, and a painter (the land's cover is sampled,
// the airfields' paint is thousands of strokes) never runs more than a few times a second.

import { paintWorld, type Box } from './map-paint';

/** Pixels per metre at each level. */
export const TILE_LEVELS = [3, 0.75, 0.1875, 0.046875, 0.01171875];
/** Tile size, in pixels. */
export const TILE_PX = 512;
/**
 * The land's cover is sampled this many times across a tile at each level (blurred, then smoothed
 * up when drawn): ~5 m apart on foot, where forests are big shapes against a fine map, and finer
 * than the levels' tile sizes alone would give out in flight, where the forests' edges are what
 * shows. Sampling is most of a tile's cost (each sample is several noise lookups).
 */
const COVER_SAMPLES = [32, 64, 72, 88, 96];
/** How many tiles are kept (each is 1 MB of canvas). */
const MAX_TILES = 28;
/** Painting new tiles stops for a frame (~16 ms) once it has taken this long (ms); at least one is always painted. */
const FRAME_BUDGET = 6;

interface Tile {
  canvas: HTMLCanvasElement;
  used: number;
}

/** Metres a tile covers at a level. */
export const tileMetres = (level: number) => TILE_PX / TILE_LEVELS[level];

/** The level that draws at `ppm` (screen pixels per metre) without blurring: the coarsest at least that sharp. */
export function levelFor(ppm: number) {
  for (let l = TILE_LEVELS.length - 1; l >= 0; l--) if (TILE_LEVELS[l] >= ppm * 0.85) return l;
  return 0;
}

class TileCache {
  private tiles = new Map<string, Tile>();
  private clock = 0;
  /** When this frame's painting started, and what it has spent (shared by everything that draws a map in it). */
  private frameStart = -Infinity;
  private spent = 0;
  private painted = 0;

  /**
   * The tile (level, i, j), covering x from i·m to (i+1)·m and z from j·m, m = tileMetres(level);
   * or null if it isn't painted yet and this frame's painting budget has gone.
   */
  get(level: number, i: number, j: number): HTMLCanvasElement | null {
    const key = `${level}:${i}:${j}`;
    const t = this.tiles.get(key);
    if (t) {
      t.used = ++this.clock;
      return t.canvas;
    }
    const t0 = performance.now();
    if (t0 - this.frameStart > 16) {
      this.frameStart = t0;
      this.spent = 0;
      this.painted = 0;
    }
    if (this.painted > 0 && this.spent > FRAME_BUDGET) return null;
    const canvas = this.paint(level, i, j);
    this.spent += performance.now() - t0;
    this.painted++;
    this.tiles.set(key, { canvas, used: ++this.clock });
    this.evict();
    return canvas;
  }

  /** Forgets every tile overlapping `box` (all of them when it's left out): the world there changed. */
  invalidate(box?: Box) {
    for (const [key, t] of this.tiles) {
      if (box) {
        const [l, i, j] = key.split(':').map(Number);
        const m = tileMetres(l);
        if (i * m > box.x1 || (i + 1) * m < box.x0 || j * m > box.z1 || (j + 1) * m < box.z0) continue;
      }
      t.canvas.width = 0; // let the browser free it straight away
      this.tiles.delete(key);
    }
  }

  private paint(level: number, i: number, j: number) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = TILE_PX;
    const g = canvas.getContext('2d')!;
    const s = TILE_LEVELS[level];
    const m = tileMetres(level);
    const x0 = i * m;
    const z0 = j * m;
    paintWorld(g, (x) => (x - x0) * s, (z) => (z - z0) * s, s, { x0, z0, x1: x0 + m, z1: z0 + m }, COVER_SAMPLES[level]);
    return canvas;
  }

  private evict() {
    while (this.tiles.size > MAX_TILES) {
      let oldest: string | null = null;
      let used = Infinity;
      for (const [key, t] of this.tiles)
        if (t.used < used) {
          used = t.used;
          oldest = key;
        }
      if (!oldest) return;
      this.tiles.get(oldest)!.canvas.width = 0;
      this.tiles.delete(oldest);
    }
  }
}

/** The one cache both maps draw from. */
export const mapTiles = new TileCache();

/**
 * Draws the world into `g` (in the units of its current transform): the view centred on (cx, cz)
 * at `ppm` units per metre, `w` × `h` units, from the level sharp enough for `ppm × density`
 * device pixels per metre. Tiles not painted yet are filled from a coarser level when that one's
 * ready, so a fresh area never flashes empty. Returns false while any tile is still missing (the
 * caller draws again next frame).
 */
export function drawTiles(g: CanvasRenderingContext2D, cx: number, cz: number, ppm: number, w: number, h: number, density = 1) {
  const x0 = cx - w / 2 / ppm;
  const z0 = cz - h / 2 / ppm;
  const x1 = cx + w / 2 / ppm;
  const z1 = cz + h / 2 / ppm;
  // never a level whose tiles for this view would overrun the cache: it would paint, evict and
  // paint again every frame without finishing (a coarser level is a little soft, but steady)
  let level = levelFor(ppm * density);
  const across = (l: number) => {
    const m = tileMetres(l);
    return (Math.floor(x1 / m) - Math.floor(x0 / m) + 1) * (Math.floor(z1 / m) - Math.floor(z0 / m) + 1);
  };
  while (level < TILE_LEVELS.length - 1 && across(level) > MAX_TILES / 2) level++;
  let complete = true;
  const blit = (l: number, i: number, j: number, sx: number, sz: number, sw: number) => {
    const c = mapTiles.get(l, i, j);
    if (!c) return false;
    const m = tileMetres(l);
    // the part of tile (l, i, j) under the box (sx, sz)–(sx + sw, sz + sw) of the world
    const k = TILE_PX / m;
    g.drawImage(c, (sx - i * m) * k, (sz - j * m) * k, sw * k, sw * k, (sx - x0) * ppm, (sz - z0) * ppm, sw * ppm + 0.5, sw * ppm + 0.5);
    return true;
  };
  const m = tileMetres(level);
  for (let j = Math.floor(z0 / m); j * m < z1; j++)
    for (let i = Math.floor(x0 / m); i * m < x1; i++) {
      if (blit(level, i, j, i * m, j * m, m)) continue;
      complete = false;
      // stand in with the coarser level's piece of the same square
      for (let l = level + 1; l < TILE_LEVELS.length; l++) {
        const M = tileMetres(l);
        if (blit(l, Math.floor((i * m) / M), Math.floor((j * m) / M), i * m, j * m, m)) break;
      }
    }
  return complete;
}
