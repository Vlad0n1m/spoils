/**
 * Weather textures, generated once on a canvas (no asset files, no license questions) and shared
 * by every WeatherFx instance through a ref count, so a rematch does not regenerate them.
 *
 *  - streak: 4×32 vertical gradient (a rain drop in motion);
 *  - ring:   32×32 thin ring (a splash on the ground);
 *  - fog:    256² tileable value noise, soft (fog banks);
 *  - cloud:  256² tileable, few large blobs (cloud shadows).
 *
 * The noise generator is pure (tested); only `acquireWeatherTextures` touches the DOM.
 */
import { Texture } from "pixi.js";

/** mulberry32: tiny deterministic PRNG so the textures look the same on every client. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Tileable fractal value noise in 0..1, `size`² row-major. The lattice wraps (cells divides the
 * texture exactly), so the left/right and top/bottom edges match and a TilingSprite shows no seam.
 * @param cells lattice cells across the first octave (each octave doubles it)
 */
export function tileableNoise(size: number, cells: number, octaves: number, seed: number): Float32Array {
  const out = new Float32Array(size * size);
  const r = rng(seed);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = cells << o;
    const lattice = new Float32Array(n * n);
    for (let i = 0; i < lattice.length; i++) lattice[i] = r();
    const cell = size / n;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy) % n;
      const y1 = (y0 + 1) % n;
      const ty = smooth(fy - Math.floor(fy));
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx) % n;
        const x1 = (x0 + 1) % n;
        const tx = smooth(fx - Math.floor(fx));
        const a = lattice[y0 * n + x0]!;
        const b = lattice[y0 * n + x1]!;
        const c = lattice[y1 * n + x0]!;
        const d = lattice[y1 * n + x1]!;
        const top = a + (b - a) * tx;
        const bot = c + (d - c) * tx;
        out[y * size + x]! += (top + (bot - top) * ty) * amp;
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

/** Maps noise to alpha with a soft threshold: below `lo` transparent, above `hi` opaque. */
export function noiseToAlpha(v: number, lo: number, hi: number): number {
  if (v <= lo) return 0;
  if (v >= hi) return 1;
  return smooth((v - lo) / (hi - lo));
}

export interface WeatherTextures {
  streak: Texture;
  ring: Texture;
  fog: Texture;
  cloud: Texture;
}

let shared: WeatherTextures | null = null;
let refs = 0;

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** White pixels with alpha from a noise field (tinted by the sprite). */
function noiseCanvas(size: number, field: Float32Array, lo: number, hi: number, maxAlpha: number): HTMLCanvasElement {
  const [c, g] = canvas(size, size);
  const img = g.createImageData(size, size);
  for (let i = 0; i < field.length; i++) {
    const p = i * 4;
    img.data[p] = 255;
    img.data[p + 1] = 255;
    img.data[p + 2] = 255;
    img.data[p + 3] = Math.round(255 * maxAlpha * noiseToAlpha(field[i]!, lo, hi));
  }
  g.putImageData(img, 0, 0);
  return c;
}

function build(): WeatherTextures {
  const [sc, sg] = canvas(4, 32);
  const grad = sg.createLinearGradient(0, 0, 0, 32);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.7, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0.9)");
  sg.fillStyle = grad;
  sg.fillRect(1, 0, 2, 32);

  const [rc, rg] = canvas(32, 32);
  rg.strokeStyle = "rgba(255,255,255,0.9)";
  rg.lineWidth = 2;
  rg.beginPath();
  rg.arc(16, 16, 13, 0, Math.PI * 2);
  rg.stroke();

  const fog = noiseCanvas(256, tileableNoise(256, 4, 4, 0xf09), 0.35, 0.8, 1);
  const cloud = noiseCanvas(256, tileableNoise(256, 2, 3, 0xc10d), 0.5, 0.75, 1);

  const tex = (c: HTMLCanvasElement, repeat: boolean) => {
    const t = Texture.from(c, true);
    if (repeat) t.source.style.addressMode = "repeat";
    return t;
  };
  return { streak: tex(sc, false), ring: tex(rc, false), fog: tex(fog, true), cloud: tex(cloud, true) };
}

/** Shared textures; pair every call with `releaseWeatherTextures`. */
export function acquireWeatherTextures(): WeatherTextures {
  if (!shared) shared = build();
  refs++;
  return shared;
}

export function releaseWeatherTextures(): void {
  if (refs <= 0) return;
  refs--;
  if (refs === 0 && shared) {
    for (const t of Object.values(shared)) t.destroy(true);
    shared = null;
  }
}
