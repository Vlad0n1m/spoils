/**
 * Sprite loading and shared visual constants.
 * Textures are created per renderer instance (not through the global Assets cache) so that
 * stop() can destroy them without breaking a second renderer that React StrictMode / a quick
 * rematch may have started in parallel.
 */

import { ImageSource, Texture } from "pixi.js";
import type { WeaponId } from "@extract/shared";

export const SPRITE_NAMES = [
  "player",
  "pistol",
  "rifle",
  "shotgun",
  "sniper",
  "chest_common",
  "chest_rare",
  "chest_epic",
  "chest_legendary",
  "armor_1",
  "armor_2",
  "armor_3",
  "bandage",
  "medkit",
  "ammo",
  "bush",
  "tree",
  "crate",
  "rock",
  "grass_tile",
  "dirt_plain",
  // v2 map (WP-M3): ground tiles and props baked into the chunked world.
  "forest_tile",
  "asphalt_tile",
  "concrete_tile",
  "wood_floor_tile",
  "car_wreck",
  "shipping_container",
  "barrel",
  "sandbags",
  "sandbags_straight",
  "fence",
  "watchtower",
  "log_pile",
  "puddle",
] as const;

export type SpriteName = (typeof SPRITE_NAMES)[number];

/** Seamless ground tiles: sampled with repeat (TilingSprite, canvas patterns). */
const TILE_SPRITES: ReadonlySet<SpriteName> = new Set<SpriteName>([
  "grass_tile",
  "dirt_plain",
  "forest_tile",
  "asphalt_tile",
  "concrete_tile",
  "wood_floor_tile",
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
};
export type Textures = Record<SpriteName, Texture>;

async function loadOne(name: SpriteName): Promise<Texture> {
  const img = new Image();
  img.src = `/sprites/${name}.png`;
  try {
    await img.decode();
  } catch {
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
};

/** Weapon icon length when lying on the ground. */
export const WEAPON_GROUND_LENGTH: Record<WeaponId, number> = {
  pistol: 30,
  rifle: 50,
  shotgun: 50,
  sniper: 58,
};

export const CHEST_SPRITES = ["chest_common", "chest_rare", "chest_epic", "chest_legendary"] as const;
export const CHEST_SIZE = [52, 56, 58, 66] as const;

/** Tints for the single ammo sprite so the three ammo types read differently. */
export const AMMO_TINT: Record<string, number> = {
  light: 0xffffff,
  shell: 0xff9f8f,
  heavy: 0x9fd0ff,
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
