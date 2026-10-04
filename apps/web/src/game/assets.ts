/**
 * Sprite loading and shared visual constants.
 * Textures are created per renderer instance (not through the global Assets cache) so that
 * stop() can destroy them without breaking a second renderer that React StrictMode / a quick
 * rematch may have started in parallel. The decoded images behind them are shared and kept for the
 * page's lifetime (sprite-cache.ts), so a texture only costs a GPU upload.
 */

import { ImageSource, Texture } from "pixi.js";
import type { WeaponId } from "@extract/shared";
import { SPRITE_NAMES, spriteImage, type SpriteName } from "./sprite-cache";

// The sprite list and the decoded-image cache live in sprite-cache.ts (no Pixi: the menu warms it).
export { SPRITE_NAMES, type SpriteName } from "./sprite-cache";

/** Seamless ground tiles: sampled with repeat (TilingSprite, canvas patterns). */
const TILE_SPRITES: ReadonlySet<SpriteName> = new Set<SpriteName>([
  "grass_tile",
  "dirt_plain",
  "forest_tile",
  "asphalt_tile",
  "concrete_tile",
  "wood_floor_tile",
  "floor_wood_tile",
  "floor_ceramic_tile",
  "floor_concrete_tile",
  "grass_lush_tile",
  "grass_dry_tile",
  "dirt_rough_tile",
  "gravel_tile",
  "asphalt_cracked_tile",
]);

/**
 * Opaque content box of a sprite inside its texture, in texture px (measured from the PNG alpha,
 * threshold 40). Props are sized so this box — not the transparent padding — covers the collision
 * shape; otherwise a bullet would visibly stop in mid-air next to a car.
 */
export const SPRITE_CONTENT: Partial<Record<SpriteName, { x: number; y: number; w: number; h: number }>> = {
  car_wreck: { x: 0, y: 67, w: 320, h: 185 },
  shipping_container: { x: 0, y: 58, w: 320, h: 203 },
  sandbags: { x: 0, y: 59, w: 224, h: 105 },
  sandbags_straight: { x: 0, y: 96, w: 256, h: 63 },
  fence: { x: 0, y: 90, w: 256, h: 76 },
  watchtower: { x: 32, y: 0, w: 223, h: 288 },
  log_pile: { x: 14, y: 0, w: 196, h: 224 },
  puddle: { x: 17, y: 0, w: 158, h: 192 },
  barrel: { x: 2, y: 0, w: 124, h: 128 },
  // Map v2 art (docs/map-v2-art.png; measured like the rest, alpha > 40).
  window_h: { x: 0, y: 102, w: 256, h: 51 },
  window_h_broken: { x: 0, y: 93, w: 256, h: 69 },
  table_wood: { x: 1, y: 0, w: 189, h: 192 },
  table_round: { x: 3, y: 0, w: 153, h: 160 },
  desk: { x: 0, y: 8, w: 192, h: 175 },
  shelf_metal: { x: 0, y: 87, w: 256, h: 82 },
  shelf_wood: { x: 0, y: 88, w: 256, h: 80 },
  sofa: { x: 0, y: 63, w: 256, h: 129 },
  armchair: { x: 4, y: 0, w: 151, h: 160 },
  bed: { x: 50, y: 0, w: 124, h: 224 },
  counter: { x: 0, y: 106, w: 320, h: 108 },
  lockers: { x: 0, y: 85, w: 256, h: 85 },
  crate_small: { x: 1, y: 0, w: 125, h: 128 },
  crate_open: { x: 0, y: 9, w: 192, h: 174 },
  crate_military: { x: 0, y: 28, w: 192, h: 135 },
  car_wreck_burnt: { x: 0, y: 79, w: 320, h: 162 },
  car_wreck_pickup: { x: 0, y: 69, w: 320, h: 181 },
  fence_wood: { x: 0, y: 111, w: 256, h: 33 },
  fence_corrugated: { x: 0, y: 104, w: 256, h: 48 },
  fence_barbed: { x: 0, y: 91, w: 256, h: 73 },
  barrel_blue: { x: 3, y: 0, w: 122, h: 128 },
  rug_red: { x: 0, y: 22, w: 256, h: 212 },
  rug_round: { x: 0, y: 0, w: 224, h: 223 },
  debris_bricks: { x: 0, y: 0, w: 192, h: 192 },
  debris_planks: { x: 10, y: 0, w: 171, h: 192 },
  debris_papers: { x: 0, y: 1, w: 160, h: 157 },
  lamp_post: { x: 0, y: 54, w: 192, h: 84 },
  sign_post: { x: 24, y: 0, w: 111, h: 160 },
  sign_board: { x: 0, y: 10, w: 192, h: 171 },
};
export type Textures = Record<SpriteName, Texture>;

async function loadOne(name: SpriteName): Promise<Texture> {
  // Decoded once per page (sprite-cache.ts: the menu and the battle screen warm it before the join).
  const img = await spriteImage(name);
  if (!img) {
    // A missing sprite should not take the whole match down: draw nothing for it.
    console.warn(`[game] sprite ${name} failed to load`);
    return Texture.EMPTY;
  }
  const tiles = TILE_SPRITES.has(name);
  return new Texture({
    source: new ImageSource({
      resource: img,
      // Sprites are drawn at ~1/4 of their pixel size; mipmaps keep the outlines from shimmering.
      autoGenerateMipmaps: true,
      scaleMode: "linear",
      addressMode: tiles ? "repeat" : "clamp-to-edge",
    }),
  });
}

export async function loadTextures(): Promise<Textures> {
  const list = await Promise.all(SPRITE_NAMES.map(loadOne));
  const out = {} as Textures;
  SPRITE_NAMES.forEach((n, i) => {
    out[n] = list[i]!;
  });
  return out;
}

/**
 * The decoded image behind a loaded texture, for canvas drawing (ground bake, minimap); null when
 * the sprite failed to load (Texture.EMPTY) or the source is not an image.
 */
export function textureImage(t: Texture | undefined): CanvasImageSource | null {
  if (!t || t === Texture.EMPTY) return null;
  const res = t.source?.resource as unknown;
  if (typeof HTMLImageElement !== "undefined" && res instanceof HTMLImageElement) return res;
  if (typeof ImageBitmap !== "undefined" && res instanceof ImageBitmap) return res;
  if (typeof HTMLCanvasElement !== "undefined" && res instanceof HTMLCanvasElement) return res;
  return null;
}

export function destroyTextures(t: Textures): void {
  for (const n of SPRITE_NAMES) {
    const tex = t[n];
    if (tex && tex !== Texture.EMPTY && !tex.destroyed) tex.destroy(true);
  }
}

/** Player ring / name colors by Player.color. */
export const PLAYER_PALETTE = [
  0x4dabf7, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b, 0x22b8cf, 0xf06595,
  0x94d82d, 0x845ef7, 0x20c997, 0xfab005, 0x339af0, 0xe64980, 0x74c0fc, 0xffa94d,
] as const;

export function playerColor(index: number): number {
  return PLAYER_PALETTE[((index % PLAYER_PALETTE.length) + PLAYER_PALETTE.length) % PLAYER_PALETTE.length]!;
}

/** The player sprite (256 px, backpack → hands) is drawn this wide so the shoulders match PLAYER.RADIUS. */
export const PLAYER_SPRITE_SIZE = 60;

/**
 * Weapon sprite length in the hands. The muzzle end sits at WeaponDef.muzzle from the player
 * center (that is where the server spawns bullets), the grip end goes under the arms.
 */
export const WEAPON_HELD_LENGTH: Record<WeaponId, number> = {
  pistol: 26,
  rifle: 54,
  shotgun: 52,
  sniper: 66,
  smg: 40,
  lmg: 70,
  revolver: 30,
  crossbow: 52,
};

/** Weapon icon length when lying on the ground. */
export const WEAPON_GROUND_LENGTH: Record<WeaponId, number> = {
  pistol: 30,
  rifle: 50,
  shotgun: 50,
  sniper: 58,
  smg: 42,
  lmg: 62,
  revolver: 32,
  crossbow: 50,
};

/** Weapons v2: drawn size of a grenade in flight (px; the 128 px icon is scaled to it). */
export const GRENADE_DRAW_PX = 16;
export const EXPLOSION_FRAMES = 8;
export const EXPLOSION_FRAME_MS = 50;
/** Explosion sprite size on screen (the blast radius is GRENADE.EDGE_PX; the fireball is smaller). */
export const EXPLOSION_DRAW_PX = 220;
/** The crossbow bolt sprite (128 px, tip to the right) is drawn this long. */
export const BOLT_DRAW_PX = 34;

export const CHEST_SPRITES = ["chest_common", "chest_rare", "chest_epic", "chest_legendary"] as const;
export const CHEST_SIZE = [52, 56, 58, 66] as const;

/**
 * Tints for the old shared "ammo" sprite. Weapons v2 gives every ammo type its own icon
 * (ammo_light / shell / heavy / bolt), drawn untinted; the tint applies only to the old box.
 */
export const AMMO_TINT: Record<string, number> = {
  light: 0xffffff,
  shell: 0xff9f8f,
  heavy: 0x9fd0ff,
  bolt: 0xd8ffb0,
};

export const COLORS = {
  background: 0x1b2616,
  wallFill: 0xd9b382,
  wallHighlight: 0xf0d3a4,
  wallOutline: 0x3a2716,
  borderFill: 0x6f7466,
  borderHighlight: 0x8d927f,
  floorFill: 0x3d4654,
  floorLine: 0x2f3742,
  floorEdge: 0x262c35,
  shadow: 0x000000,
  extractOpen: 0x3ee07a,
  extractWaiting: 0xb5bcc4,
  extractClosed: 0x5b6168,
  tracer: 0xfff1a8,
  tracerCore: 0xffffff,
  hitFlesh: 0xff4d4d,
  hitArmor: 0x7cc4ff,
  damageDealt: 0xffe066,
  damageTaken: 0xff5252,
} as const;
