/**
 * Client fog of war (critique "Client fog rendering", fog memo §3, perf memo §1).
 *
 * ONE half-resolution RenderTexture per frame, no sprite alpha masks anywhere (a single Sprite
 * mask cost ~20 ms GPU per frame in v1):
 *   1. a screen-sized rect in the darkness colour (alpha from sampleEnv light / fog),
 *   2. the soft 180° cone texture and the awareness disc drawn with blend 'erase' (holes with soft
 *      edges = what the player can see),
 *   3. shadow quads from the shared occluder grid (back faces of every SIGHT solid) drawn back in
 *      the darkness colour with blend 'max', so overlapping quads and quads over already dark areas
 *      never get darker than the darkness itself,
 *   4. the RT is composited as ONE screen sprite above the world.
 * The static map stays visible under it, only darkened ("memory"). Dynamic entities (remote
 * players, items, corpses) are not masked; the renderer gives each of them an alpha from
 * `visibility()` = coneAlpha × CPU line of sight, which matches what the RT shows.
 *
 * The client cone (90°, fading from 70°) and awareness (72 px) are narrower than the server's
 * (105°, 110 px) and the octagon occluders are a superset of the server's circles, so the client
 * never shows something the server hid; entities the server still sends fade out here instead.
 */

import { Container, Mesh, MeshGeometry, RenderTexture, Sprite, Texture, type Renderer } from "pixi.js";
import {
  ENV,
  PLAYER,
  SOLID,
  VISION,
  buildOccluderGrid,
  coneAlpha,
  raycastSolidsDDA,
  shadowQuads,
  visionRangeMult,
  type CollisionIndex,
  type EnvSample,
  type OccluderGrid,
  type OccluderSource,
} from "@extract/shared";

export const FOG = {
  /** The visibility RT is this fraction of the screen (CSS px); linear upscaling softens edges. */
  RT_RES: 0.5,
  /** Preallocated shadow quads (~600 at range 1000 on a dense map, fog memo); extra quads are dropped. */
  MAX_QUADS: 2048,
  /** Cone texture: forward half only (the cone never exceeds ±90°). Radius in texels. */
  CONE_TEX_R: 256,
  /** Awareness disc texture radius in texels (covers AWARE_R + AWARE_FADE). */
  AWARE_TEX_R: 64,
  /**
   * Darkness over unseen ground ("memory"): day / night alpha and the fog-weather mist colour.
   * The night tint below already darkens the whole world, so the overlay stays at or under 0.72:
   * roads, buildings and tree lines must stay readable at night (playtest: 0.82 read as black).
   */
  DAY_COLOR: 0x0b1020,
  DAY_ALPHA: 0.45,
  NIGHT_ALPHA: 0.72,
  MIST_COLOR: 0x8f99a4,
  MIST_ALPHA: 0.6,
  /** World tint at full night (multiplied over the visible world as well). */
  NIGHT_TINT: 0x5b6890,
  /** Per-entity alpha follows its visibility with this time constant (fade in / out). */
  FADE_MS: 150,
} as const;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export function lerpColor(a: number, b: number, t: number): number {
  const k = clamp01(t);
  const r = Math.round(lerp((a >> 16) & 255, (b >> 16) & 255, k));
  const g = Math.round(lerp((a >> 8) & 255, (b >> 8) & 255, k));
  const bl = Math.round(lerp(a & 255, b & 255, k));
  return (r << 16) | (g << 8) | bl;
}

/** 0 at full daylight .. 1 at the darkest night light (ENV.NIGHT_LIGHT). */
export function nightFactor(light: number): number {
  return clamp01((1 - light) / (1 - ENV.NIGHT_LIGHT));
}

export interface FogLook {
  /** Darkness colour and alpha over everything outside vision. */
  color: number;
  alpha: number;
  /** Multiplied over the whole world container (night / storm darkening of the visible area too). */
  tint: number;
}

/**
 * How dark the unseen world is. Night raises the overlay alpha and tints the world; fog weather
 * turns the darkness into a light grey mist so unseen ground reads as haze, not as night.
 */
export function fogLook(env: Pick<EnvSample, "light" | "fog"> | null): FogLook {
  if (!env) return { color: FOG.DAY_COLOR, alpha: FOG.DAY_ALPHA, tint: 0xffffff };
  const night = nightFactor(env.light);
  let alpha = lerp(FOG.DAY_ALPHA, FOG.NIGHT_ALPHA, night);
  // Mist only reads as mist while there is light to scatter; at night it is just darkness.
  const mist = clamp01(env.fog) * (1 - night);
  const color = lerpColor(FOG.DAY_COLOR, FOG.MIST_COLOR, mist);
  alpha = lerp(alpha, Math.max(alpha, FOG.MIST_ALPHA), mist);
  return { color, alpha, tint: lerpColor(0xffffff, FOG.NIGHT_TINT, night * 0.85) };
}

/** Client vision range in world px for an environment sample (same clamp as the server). */
export function fogRange(env: Pick<EnvSample, "vis"> | null): number {
  return VISION.RANGE * (env ? visionRangeMult(env.vis) : 1);
}

/**
 * Cone texture alpha at (dx, dy) in units of the range (forward = +x): the client cone of
 * coneAlpha() without the awareness term. 1 inside ±(CONE_HALF − CONE_FADE)° and 80 % of the range,
 * smooth to 0 at ±CONE_HALF° and the full range.
 */
export function coneTexAlpha(dx: number, dy: number): number {
  const d = Math.hypot(dx, dy);
  if (d >= 1) return 0;
  if (d < 1e-9) return 1;
  const deg = (Math.abs(Math.atan2(dy, dx)) * 180) / Math.PI;
  const full = VISION.CONE_HALF_DEG - VISION.CONE_FADE_DEG;
  const ang = 1 - smoothstep(full, VISION.CONE_HALF_DEG, deg);
  const rad = 1 - smoothstep(VISION.RANGE_FADE_FROM, 1, d);
  return ang * rad;
}

/** Awareness disc alpha at a world distance d (same ramp as coneAlpha's awareness term). */
export function awareTexAlpha(d: number): number {
  if (d <= VISION.AWARE_R) return 1;
  if (d >= VISION.AWARE_R + VISION.AWARE_FADE) return 0;
  return 1 - (d - VISION.AWARE_R) / VISION.AWARE_FADE;
}

/** RGBA pixels (premultiplied white) of the cone texture: width R, height 2R, eye at (0, R). */
export function conePixels(R: number = FOG.CONE_TEX_R): Uint8ClampedArray {
  const w = R, h = 2 * R;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = Math.round(coneTexAlpha((x + 0.5) / R, (y + 0.5 - R) / R) * 255);
      const o = (y * w + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = 255;
      out[o + 3] = a;
    }
  }
  return out;
}

/**
 * RGBA pixels of the awareness disc: 2R × 2R, R texels = AWARE_R + AWARE_FADE world px.
 * The ramp is eased (smoothstep of the linear awareness term, same 0 / 1 end points) so the disc
 * melts into the cone's soft edges instead of reading as a separate, brighter bubble behind the
 * player. Inside the cone both holes are fully open, so the visible world gets exactly one
 * lighting (the world tint) whether it is seen through the cone or the disc.
 */
export function awarePixels(R: number = FOG.AWARE_TEX_R): Uint8ClampedArray {
  const n = 2 * R;
  const worldPerTexel = (VISION.AWARE_R + VISION.AWARE_FADE) / R;
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - R, y + 0.5 - R) * worldPerTexel;
      const o = (y * n + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = 255;
      out[o + 3] = Math.round(smoothstep(0, 1, awareTexAlpha(d)) * 255);
    }
  }
  return out;
}

/** Static index buffer for `quads` quads (a, b, b', a' → two triangles each). */
export function quadIndices(quads: number): Uint32Array {
  const idx = new Uint32Array(quads * 6);
  for (let q = 0; q < quads; q++) {
    const v = q * 4, o = q * 6;
    idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
    idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
  }
  return idx;
}

/**
 * Writes this frame's shadow quads into `positions` (8 floats per quad, as shadowQuads packs them)
 * and zeroes the quads the previous frame used but this one does not, so they become degenerate.
 * Returns { n, dirtyQuads } — upload only the first dirtyQuads quads.
 */
export function writeShadowQuads(
  grid: OccluderGrid, ex: number, ey: number, R: number, positions: Float32Array, maxQuads: number, prevN: number,
): { n: number; dirtyQuads: number } {
  const n = shadowQuads(grid, ex, ey, R, positions, maxQuads);
  if (prevN > n) positions.fill(0, n * 8, prevN * 8);
  return { n, dirtyQuads: Math.max(n, prevN) };
}

/** What the fog needs to know about the viewer this frame. */
export interface FogEye {
  x: number;
  y: number;
  aim: number;
  /** Vision range (fogRange(env)). */
  range: number;
}

/**
 * Line of sight from the eye to a target of radius `pad`: the centre or either side point is
 * unobstructed (SIGHT mask), like the server's canSee side rays, so a body half behind a crate
 * still shows.
 */
export function losVisible(idx: CollisionIndex, ex: number, ey: number, x: number, y: number, pad: number): boolean {
  if (raycastSolidsDDA(idx, ex, ey, x, y, SOLID.SIGHT) === Infinity) return true;
  if (pad <= 0) return false;
  const dx = x - ex, dy = y - ey;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  const px = (-dy / d) * pad, py = (dx / d) * pad;
  return (
    raycastSolidsDDA(idx, ex, ey, x + px, y + py, SOLID.SIGHT) === Infinity ||
    raycastSolidsDDA(idx, ex, ey, x - px, y - py, SOLID.SIGHT) === Infinity
  );
}

/**
 * Per-entity visibility 0..1: coneAlpha (cone × range × awareness) × line of sight. The LOS ray is
 * skipped when the cone already says 0 (most entities behind the player).
 */
export function entityVisibility(idx: CollisionIndex | null, eye: FogEye, x: number, y: number, pad: number): number {
  const a = coneAlpha(eye.aim, x - eye.x, y - eye.y, eye.range + pad);
  if (a <= 0.001) return 0;
  if (!idx) return a;
  return losVisible(idx, eye.x, eye.y, x, y, pad) ? a : 0;
}

/** Frame-rate independent approach of `cur` to `target` with time constant FADE_MS. */
export function fadeToward(cur: number, target: number, dtMs: number, tauMs: number = FOG.FADE_MS): number {
  if (cur === target) return cur;
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  const v = cur + (target - cur) * k;
  return Math.abs(v - target) < 0.01 ? target : v;
}

/** Pad for a player body (as canSee's side points). */
export const PLAYER_PAD = PLAYER.RADIUS;

function canvasTexture(pixels: Uint8ClampedArray, w: number, h: number): Texture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return Texture.WHITE;
  // ImageData is not premultiplied; the canvas source uploads it premultiplied.
  const img = ctx.createImageData(w, h);
  img.data.set(pixels);
  ctx.putImageData(img, 0, 0);
  return Texture.from(c);
}

export interface FogFrame {
  eye: FogEye;
  /** Camera centre in world units and zoom (screen px per world px). */
  camX: number;
  camY: number;
  zoom: number;
  screenW: number;
  screenH: number;
  look: FogLook;
}

export interface FogStats {
  quads: number;
  /** CPU ms spent building the quads and the RT scene this frame (not GPU time). */
  cpuMs: number;
}

/** The fog pass. Create after the map is known; add `sprite` above the world. */
export class FogOfWar {
  /** Screen-space composite of the visibility RT. */
  readonly sprite: Sprite;
  readonly grid: OccluderGrid;
  readonly stats: FogStats = { quads: 0, cpuMs: 0 };

  private rt: RenderTexture;
  private readonly scene = new Container();
  private readonly dark: Sprite;
  private readonly worldCam = new Container();
  private readonly cone: Sprite;
  private readonly aware: Sprite;
  private readonly mesh: Mesh<MeshGeometry>;
  private readonly positions: Float32Array;
  private readonly coneTex: Texture;
  private readonly awareTex: Texture;
  private prevN = 0;
  private w = 0;
  private h = 0;
  private destroyed = false;

  constructor(
    private readonly renderer: Renderer,
    map: OccluderSource,
    screenW: number,
    screenH: number,
  ) {
    this.grid = buildOccluderGrid(map);
    this.w = Math.max(1, Math.round(screenW));
    this.h = Math.max(1, Math.round(screenH));
    this.rt = RenderTexture.create({ width: this.w, height: this.h, resolution: FOG.RT_RES, antialias: false });

    this.dark = new Sprite(Texture.WHITE);
    this.dark.width = this.w;
    this.dark.height = this.h;

    const R = FOG.CONE_TEX_R;
    this.coneTex = canvasTexture(conePixels(R), R, 2 * R);
    this.cone = new Sprite(this.coneTex);
    this.cone.anchor.set(0, 0.5);
    this.cone.blendMode = "erase";

    const A = FOG.AWARE_TEX_R;
    this.awareTex = canvasTexture(awarePixels(A), 2 * A, 2 * A);
    this.aware = new Sprite(this.awareTex);
    this.aware.anchor.set(0.5);
    this.aware.blendMode = "erase";
    const awareWorld = 2 * (VISION.AWARE_R + VISION.AWARE_FADE);
    this.aware.width = awareWorld;
    this.aware.height = awareWorld;

    this.positions = new Float32Array(FOG.MAX_QUADS * 8);
    const geometry = new MeshGeometry({
      positions: this.positions,
      uvs: new Float32Array(FOG.MAX_QUADS * 8),
      indices: quadIndices(FOG.MAX_QUADS),
    });
    this.mesh = new Mesh({ geometry, texture: Texture.WHITE });
    // GL_MAX of premultiplied colours: shadows restore exactly the darkness, never darker.
    this.mesh.blendMode = "max";

    this.worldCam.addChild(this.cone, this.aware, this.mesh);
    this.scene.addChild(this.dark, this.worldCam);

    this.sprite = new Sprite(this.rt);
    this.sprite.eventMode = "none";
    this.sprite.label = "fog";
  }

  /** Vision RT for the current frame. */
  update(f: FogFrame): void {
    if (this.destroyed) return;
    const t0 = performance.now();
    if (Math.round(f.screenW) !== this.w || Math.round(f.screenH) !== this.h) this.resize(f.screenW, f.screenH);
    const { eye, look } = f;

    this.dark.tint = look.color;
    this.dark.alpha = look.alpha;
    this.mesh.tint = look.color;
    this.mesh.alpha = look.alpha;

    this.worldCam.scale.set(f.zoom);
    this.worldCam.position.set(this.w / 2 - f.camX * f.zoom, this.h / 2 - f.camY * f.zoom);

    this.cone.position.set(eye.x, eye.y);
    this.cone.rotation = eye.aim;
    this.cone.scale.set(eye.range / FOG.CONE_TEX_R);
    this.aware.position.set(eye.x, eye.y);

    // Edges beyond the range cannot shade anything inside it (shadows point away from the eye), and
    // everything beyond the range is dark anyway: R = range is enough.
    const { n, dirtyQuads } = writeShadowQuads(this.grid, eye.x, eye.y, eye.range, this.positions, FOG.MAX_QUADS, this.prevN);
    this.prevN = n;
    if (dirtyQuads > 0) this.mesh.geometry.getBuffer("aPosition").update(dirtyQuads * 8 * 4);
    this.stats.quads = n;

    this.renderer.render({ container: this.scene, target: this.rt, clear: true });
    this.stats.cpuMs = performance.now() - t0;
  }

  resize(screenW: number, screenH: number): void {
    this.w = Math.max(1, Math.round(screenW));
    this.h = Math.max(1, Math.round(screenH));
    // A fresh RT instead of rt.resize(): resizing a live render target in place left the GL
    // framebuffer at the old size (darkness covered only the old screen area, seen in the harness).
    const old = this.rt;
    this.rt = RenderTexture.create({ width: this.w, height: this.h, resolution: FOG.RT_RES, antialias: false });
    this.sprite.texture = this.rt;
    old.destroy(true);
    this.dark.width = this.w;
    this.dark.height = this.h;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.sprite.destroy();
    this.scene.destroy({ children: true });
    this.rt.destroy(true);
    this.coneTex.destroy(true);
    this.awareTex.destroy(true);
  }
}
