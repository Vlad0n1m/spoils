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
  "dirt_tile",
] as const;

export type SpriteName = (typeof SPRITE_NAMES)[number];
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
  const tiles = name === "grass_tile" || name === "dirt_tile";
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
