import * as THREE from 'three';

export const PALETTE = {
  candy: '#ff4d6d',
  candyDark: '#c9304f',
  cream: '#fff5e3',
  mustard: '#ffc23d',
  teal: '#2ec4b6',
  violet: '#7b5cd6',
  ink: '#1d1238',
  sky: '#5a8dee',
  mint: '#7ee2b8',
  orange: '#ff8a3d',
};

/** Bright (HDR) colour for things that should glow through the bloom pass. */
export const hdr = (c: THREE.ColorRepresentation, k: number) => new THREE.Color(c).multiplyScalar(k);

export const DISPLAY_FONT = '"Lilita One", "Arial Rounded MT Bold", sans-serif';
export const BODY_FONT = '"DM Sans", system-ui, sans-serif';

export interface LabelOptions {
  width?: number;
  height?: number;
  bg?: string;
  fg?: string;
  border?: string;
  sub?: string;
  subColor?: string;
  font?: string;
  radius?: number;
  fontSize?: number;
  bulbs?: boolean;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function finish(canvas: HTMLCanvasElement, renderer?: THREE.WebGLRenderer) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  return tex;
}

/** A carnival sign: rounded board, optional marquee bulbs, title + subtitle. */
export function signTexture(title: string, o: LabelOptions = {}) {
  const w = o.width ?? 1024;
  const h = o.height ?? 384;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const r = o.radius ?? 48;
  const pad = 10;

  ctx.fillStyle = o.border ?? PALETTE.candy;
  roundRect(ctx, 0, 0, w, h, r);
  ctx.fill();
  ctx.fillStyle = o.bg ?? PALETTE.cream;
  roundRect(ctx, pad * 3, pad * 3, w - pad * 6, h - pad * 6, r * 0.6);
  ctx.fill();

  if (o.bulbs !== false) {
    const step = 46;
    ctx.fillStyle = '#fff6c9';
    for (let x = r; x < w - r / 2; x += step) {
      dot(ctx, x, pad * 1.5);
      dot(ctx, x, h - pad * 1.5);
    }
    for (let y = r; y < h - r / 2; y += step) {
      dot(ctx, pad * 1.5, y);
      dot(ctx, w - pad * 1.5, y);
    }
  }

  ctx.fillStyle = o.fg ?? PALETTE.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = o.fontSize ?? (o.sub ? h * 0.36 : h * 0.46);
  ctx.font = `${size}px ${o.font ?? DISPLAY_FONT}`;
  while (ctx.measureText(title).width > w - 120 && size > 20) {
    size -= 4;
    ctx.font = `${size}px ${o.font ?? DISPLAY_FONT}`;
  }
  ctx.fillText(title, w / 2, o.sub ? h * 0.42 : h * 0.53);

  if (o.sub) {
    let sub = h * 0.13;
    ctx.font = `700 ${sub}px ${BODY_FONT}`;
    while (ctx.measureText(o.sub).width > w - 120 && sub > 12) {
      sub -= 2;
      ctx.font = `700 ${sub}px ${BODY_FONT}`;
    }
    ctx.fillStyle = o.subColor ?? PALETTE.violet;
    ctx.fillText(o.sub, w / 2, h * 0.72);
  }
  const tex = finish(c);

  // Emissive mask: a faintly back-lit board with the marquee bulbs fully lit (they bloom).
  const e = document.createElement('canvas');
  e.width = w;
  e.height = h;
  const ectx = e.getContext('2d')!;
  ectx.fillStyle = '#000';
  ectx.fillRect(0, 0, w, h);
  ectx.globalAlpha = 0.07;
  ectx.drawImage(c, 0, 0);
  ectx.globalAlpha = 1;
  if (o.bulbs !== false) {
    const step = 46;
    ectx.fillStyle = '#ffe9b0';
    for (let x = r; x < w - r / 2; x += step) {
      dot(ectx, x, pad * 1.5);
      dot(ectx, x, h - pad * 1.5);
    }
    for (let y = r; y < h - r / 2; y += step) {
      dot(ectx, pad * 1.5, y);
      dot(ectx, w - pad * 1.5, y);
    }
  }
  tex.userData.emissive = finish(e);
  return tex;
}

/** Material for a sign texture: lit board, glowing marquee bulbs. */
export function signMaterial(tex: THREE.Texture, opts: THREE.MeshStandardMaterialParameters = {}) {
  return new THREE.MeshStandardMaterial({
    map: tex,
    emissive: '#ffffff',
    emissiveMap: (tex.userData.emissive as THREE.Texture | undefined) ?? tex,
    emissiveIntensity: 3.2,
    roughness: 0.55,
    metalness: 0,
    ...opts,
  });
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
}

/** Floating text without a board (for sprites). */
export function floatingTextTexture(text: string, sub?: string, color = PALETTE.cream) {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = sub ? 320 : 220;
  const ctx = c.getContext('2d')!;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `120px ${DISPLAY_FONT}`;
  ctx.lineWidth = 18;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText(text, 512, 110);
  ctx.fillStyle = color;
  ctx.fillText(text, 512, 110);
  if (sub) {
    ctx.font = `700 58px ${BODY_FONT}`;
    ctx.lineWidth = 12;
    ctx.strokeText(sub, 512, 245);
    ctx.fillStyle = PALETTE.mustard;
    ctx.fillText(sub, 512, 245);
  }
  return finish(c);
}

export function makeSprite(tex: THREE.Texture, worldWidth: number) {
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  const img = tex.image as HTMLCanvasElement;
  s.scale.set(worldWidth, (worldWidth * img.height) / img.width, 1);
  return s;
}

/** Crate face with its points value. */
export function crateTexture(label: string, color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 256, 256);
  // planks
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let y = 0; y < 256; y += 64) ctx.fillRect(0, y, 256, 4);
  ctx.strokeStyle = 'rgba(29,18,56,0.55)';
  ctx.lineWidth = 16;
  ctx.strokeRect(8, 8, 240, 240);
  ctx.fillStyle = PALETTE.cream;
  ctx.beginPath();
  ctx.arc(128, 128, 92, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let size = 64;
  ctx.font = `${size}px ${DISPLAY_FONT}`;
  while (ctx.measureText(label).width > 160 && size > 20) {
    size -= 2;
    ctx.font = `${size}px ${DISPLAY_FONT}`;
  }
  ctx.fillText(label, 128, 134);
  return finish(c);
}

/** Vertical candy stripes, used on tents, canopies and the rocket. */
export function stripeTexture(a: string, b: string, stripes = 8, horizontal = false) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const step = 256 / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? a : b;
    if (horizontal) ctx.fillRect(0, i * step, 256, step);
    else ctx.fillRect(i * step, 0, step, 256);
  }
  const t = finish(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export interface PathSpec {
  points: [number, number][];
  width: number;
}

/** A coloured band set into a plaza's paving (a district's colour), at radius r. */
export interface Inlay {
  x: number;
  z: number;
  r: number;
  color: string;
}

/** Paints sandy paths (with a darker edge) and decorated plazas, then grains the sand. */
function paintSand(
  ctx: CanvasRenderingContext2D,
  toX: (x: number) => number,
  toZ: (z: number) => number,
  k: number,
  paths: PathSpec[],
  plazas: [number, number, number][],
  rnd: () => number,
  inlays: Inlay[] = [],
) {
  const drawPaths = (color: string, extra: number) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const p of paths) {
      ctx.lineWidth = (p.width + extra) * k;
      ctx.beginPath();
      p.points.forEach(([x, z], i) => (i ? ctx.lineTo(toX(x), toZ(z)) : ctx.moveTo(toX(x), toZ(z))));
      ctx.stroke();
    }
    for (const [x, z, r] of plazas) {
      ctx.beginPath();
      ctx.arc(toX(x), toZ(z), (r + extra / 2) * k, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  drawPaths('#b98a5a', 1.2); // edge
  drawPaths('#e2b989', 0); // sand

  // plaza decoration: concentric rings + a faint sunburst
  for (const [x, z, r] of plazas) {
    const cx = toX(x);
    const cy = toZ(z);
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = '#c99868';
    ctx.lineWidth = 0.35 * k;
    for (let rr = r * 0.35; rr < r * 0.95; rr += r * 0.3) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#ffffff';
    const rays = 16;
    for (let i = 0; i < rays; i += 2) {
      const a0 = (i / rays) * Math.PI * 2;
      const a1 = ((i + 1) / rays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r * 0.65 * k, a0, a1);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // districts' colours, set into their plazas: a band of tiles with a thin dark edge either side
  for (const { x, z, r, color } of inlays) {
    ctx.save();
    ctx.lineWidth = 1.1 * k;
    ctx.strokeStyle = 'rgba(70, 45, 25, 0.45)';
    ctx.beginPath();
    ctx.arc(toX(x), toZ(z), r * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 0.8 * k;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.restore();
  }

  // sand grain (single read-back, then per-pixel noise on sandy pixels only)
  const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  const px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 200 && px[i + 1] > 160) {
      const n = (rnd() - 0.5) * 26;
      px[i] += n;
      px[i + 1] += n;
      px[i + 2] += n;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Paints grass, dirt paths and plazas into one big ground texture. */
export function groundTexture(
  size: number,
  ground: { x: number; z: number; size: number },
  paths: PathSpec[],
  plazas: [number, number, number][],
  inlays: Inlay[] = [],
): { texture: THREE.CanvasTexture; isSand: (x: number, z: number) => boolean } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const worldSize = ground.size;
  const k = size / worldSize;
  const toX = (x: number) => (x - ground.x + worldSize / 2) * k;
  const toZ = (z: number) => (z - ground.z + worldSize / 2) * k;

  const grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.05, size / 2, size / 2, size * 0.7);
  grad.addColorStop(0, '#4f9a5e');
  grad.addColorStop(1, '#2f6b48');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // grass speckles
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 26000; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(120,190,110,0.18)' : 'rgba(20,60,40,0.18)';
    ctx.fillRect(rnd() * size, rnd() * size, 2 + rnd() * 3, 2 + rnd() * 3);
  }

  paintSand(ctx, toX, toZ, k, paths, plazas, rnd, inlays);

  const t = finish(c);
  t.anisotropy = 8;

  // Low-res mask of sandy areas (+ a margin) so grass never grows on the paths.
  const M = 512;
  const mc = document.createElement('canvas');
  mc.width = mc.height = M;
  const mctx = mc.getContext('2d')!;
  const mk = M / worldSize;
  const mx = (x: number) => (x - ground.x + worldSize / 2) * mk;
  const mz = (z: number) => (z - ground.z + worldSize / 2) * mk;
  mctx.strokeStyle = mctx.fillStyle = '#fff';
  mctx.lineCap = mctx.lineJoin = 'round';
  for (const p of paths) {
    mctx.lineWidth = (p.width + 2.4) * mk;
    mctx.beginPath();
    p.points.forEach(([x, z], i) => (i ? mctx.lineTo(mx(x), mz(z)) : mctx.moveTo(mx(x), mz(z))));
    mctx.stroke();
  }
  for (const [x, z, r] of plazas) {
    mctx.beginPath();
    mctx.arc(mx(x), mz(z), (r + 1.2) * mk, 0, Math.PI * 2);
    mctx.fill();
  }
  const md = mctx.getImageData(0, 0, M, M).data;
  const isSand = (x: number, z: number) => {
    const px = Math.floor(mx(x));
    const pz = Math.floor(mz(z));
    if (px < 0 || pz < 0 || px >= M || pz >= M) return false;
    return md[(pz * M + px) * 4] > 100;
  };
  return { texture: t, isSand };
}

/**
 * A patch of the park's lawn (same gradient and speckle as the park's ground texture, so the two
 * meet seamlessly) with its paths and plazas, over the rectangle x0..x1, z0..z1: for ground beyond
 * the main ground texture. Its edges fade to transparent: `fade` metres at the sides and the far
 * (z0) end, `fadeNear` metres at the z1 end where it overlaps the park ground.
 */
export function lawnPatchTexture(
  rect: { x0: number; z0: number; x1: number; z1: number },
  pxPerMetre: number,
  ground: { x: number; z: number; size: number },
  fade: { side: number; near: number },
  paths: PathSpec[],
  plazas: [number, number, number][],
) {
  const { x0, z0, x1, z1 } = rect;
  const k = pxPerMetre;
  const c = document.createElement('canvas');
  const w = (c.width = Math.ceil((x1 - x0) * k));
  const h = (c.height = Math.ceil((z1 - z0) * k));
  const ctx = c.getContext('2d')!;
  const toX = (x: number) => (x - x0) * k;
  const toZ = (z: number) => (z - z0) * k;

  // the park ground's radial gradient, centred on the park
  const worldSize = ground.size;
  const grad = ctx.createRadialGradient(toX(ground.x), toZ(ground.z), worldSize * 0.05 * k, toX(ground.x), toZ(ground.z), worldSize * 0.7 * k);
  grad.addColorStop(0, '#4f9a5e');
  grad.addColorStop(1, '#2f6b48');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // grass speckles at the same density and size as on the park ground
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const speckles = Math.round((26000 * (x1 - x0) * (z1 - z0)) / (worldSize * worldSize));
  for (let i = 0; i < speckles; i++) {
    ctx.fillStyle = rnd() > 0.5 ? 'rgba(120,190,110,0.18)' : 'rgba(20,60,40,0.18)';
    const s = (0.13 + rnd() * 0.19) * k;
    ctx.fillRect(rnd() * w, rnd() * h, s, s);
  }

  paintSand(ctx, toX, toZ, k, paths, plazas, rnd);

  // fade the edges out into the surrounding country
  ctx.globalCompositeOperation = 'destination-in';
  const across = ctx.createLinearGradient(0, 0, w, 0);
  const sx = fade.side / (x1 - x0);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(sx, 'rgba(0,0,0,1)');
  across.addColorStop(1 - sx, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, w, h);
  const along = ctx.createLinearGradient(0, 0, 0, h);
  along.addColorStop(0, 'rgba(0,0,0,0)');
  along.addColorStop(fade.side / (z1 - z0), 'rgba(0,0,0,1)');
  along.addColorStop(1 - fade.near / (z1 - z0), 'rgba(0,0,0,1)');
  along.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = along;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';

  const t = finish(c);
  t.anisotropy = 8;
  return t;
}

/** Tileable fine-grain normal map (soil/grass bumps) — shines under the low sunset sun. */
export function detailNormalTexture(size = 512) {
  const grid = (n: number, seed: number) => {
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Float32Array.from({ length: n * n }, rnd);
  };
  const octaves = [
    { n: 16, a: 0.5, g: grid(16, 11) },
    { n: 48, a: 0.3, g: grid(48, 23) },
    { n: 128, a: 0.2, g: grid(128, 37) },
  ];
  const sample = (o: (typeof octaves)[number], u: number, v: number) => {
    const x = u * o.n;
    const y = v * o.n;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (i: number, j: number) => o.g[(((j % o.n) + o.n) % o.n) * o.n + (((i % o.n) + o.n) % o.n)];
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
  const hgt = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (const o of octaves) v += sample(o, x / size, y / size) * o.a;
      hgt[y * size + x] = v;
    }
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const strength = 6;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const h = (i: number, j: number) => hgt[((j + size) % size) * size + ((i + size) % size)];
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** Soft warm disc used for lamp light pools on the ground. */
export function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,214,150,1)');
  g.addColorStop(0.35, 'rgba(255,190,120,0.55)');
  g.addColorStop(1, 'rgba(255,170,100,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return finish(c);
}

export function glowTexture(color = '#ffe9a8') {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, color);
  g.addColorStop(0.25, color + 'aa');
  g.addColorStop(1, color + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return finish(c);
}
