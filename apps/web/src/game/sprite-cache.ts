/**
 * Battle sprite images, downloaded and decoded once per page and kept across raids (no Pixi here,
 * so the menu can warm the cache without pulling the renderer into its bundle).
 *
 * Why: the server puts a raider on the map at the room join, and the battle canvas only appears once
 * every sprite is loaded. Block C took that from 34 sprites (2 MiB) to 77 (4 MiB), so on a phone
 * the raider stood on the map unseen for longer. Now the menu warms the cache while idle, the
 * battle screen finishes the warm-up (capped) before it joins, and assets.ts builds its textures
 * from the decoded images: a raid start, and every raid after the first, only uploads to the GPU.
 */

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
  // Map v2 (MAP_GEN_VERSION 4, art/map-v2.json): windows, floor / ground tile variety, furniture,
  // prop variants (MapRect.v) and decor decals. A missing file draws nothing (or the old art).
  "window_h",
  "window_h_broken",
  "floor_wood_tile",
  "floor_ceramic_tile",
  "floor_concrete_tile",
  "grass_lush_tile",
  "grass_dry_tile",
  "dirt_rough_tile",
  "gravel_tile",
  "asphalt_cracked_tile",
  "table_wood",
  "table_round",
  "desk",
  "shelf_metal",
  "shelf_wood",
  "sofa",
  "armchair",
  "bed",
  "counter",
  "lockers",
  "crate_small",
  "crate_open",
  "crate_military",
  "car_wreck_burnt",
  "car_wreck_pickup",
  "fence_wood",
  "fence_corrugated",
  "fence_barbed",
  "barrel_blue",
  "rug_red",
  "rug_round",
  "debris_bricks",
  "debris_planks",
  "debris_papers",
  "lamp_post",
  "sign_post",
  "sign_board",
  // Weapons v2 (art/guns-v2.json, docs/WEAPONS_V2.md): guns in the hands, the hand grenade (ground
  // item icon), the crossbow bolt in flight. The explosion sheet and the ammo / icon_<gun> art load
  // lazily (grenades.ts, the icon cache).
  "smg",
  "lmg",
  "revolver",
  "crossbow",
  "grenade",
  "bolt",
  // Loot containers (art/containers.json): one closed and one opened-empty look per ContainerKind.
  "box_crate",
  "box_crate_open",
  "box_toolbox",
  "box_toolbox_open",
  "box_fridge",
  "box_fridge_open",
  "box_pc",
  "box_pc_open",
  "box_med_case",
  "box_med_case_open",
  "box_weapon_box",
  "box_weapon_box_open",
  "box_safe",
  "box_safe_open",
  "box_stash",
  "box_stash_open",
] as const;

export type SpriteName = (typeof SPRITE_NAMES)[number];

/** How long the battle screen waits for the warm-up before it joins anyway. */
export const SPRITE_WARM_MAX_MS = 8_000;
/** Downloads in flight at once while warming (the menu keeps the network for itself). */
const WARM_CONCURRENCY = 3;

const cache = new Map<SpriteName, Promise<HTMLImageElement | null>>();

/** The decoded image of `name` (cached; null when it failed: a failure is retried on the next call). */
export function spriteImage(name: SpriteName): Promise<HTMLImageElement | null> {
  const hit = cache.get(name);
  if (hit) return hit;
  const p = (async () => {
    if (typeof Image === "undefined") return null;
    const img = new Image();
    img.src = `/sprites/${name}.png`;
    try {
      await img.decode();
      return img;
    } catch {
      cache.delete(name);
      return null;
    }
  })();
  cache.set(name, p);
  return p;
}

let warming: Promise<void> | null = null;

/** Download and decode every battle sprite, WARM_CONCURRENCY at a time. Idempotent. */
export function warmSprites(): Promise<void> {
  if (warming) return warming;
  const queue = [...SPRITE_NAMES];
  const worker = async () => {
    for (let n = queue.shift(); n; n = queue.shift()) await spriteImage(n);
  };
  warming = Promise.all(Array.from({ length: WARM_CONCURRENCY }, worker)).then(
    () => undefined,
    () => undefined,
  );
  // A sprite that failed stays out of the cache, so a later warm-up may try again.
  void warming.then(() => {
    if (SPRITE_NAMES.some((n) => !cache.has(n))) warming = null;
  });
  return warming;
}

/** Warm the cache once the browser is idle (the menu). Returns a cancel function. */
export function warmSpritesWhenIdle(delayMs = 1_500): () => void {
  if (typeof window === "undefined") return () => {};
  let idle: number | null = null;
  const timer = window.setTimeout(() => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) idle = ric(() => void warmSprites(), { timeout: 5_000 });
    else void warmSprites();
  }, delayMs);
  return () => {
    window.clearTimeout(timer);
    const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (idle !== null && cic) cic(idle);
  };
}

/** Wait for the warm-up, but never longer than `maxMs`. */
export function warmSpritesFor(maxMs = SPRITE_WARM_MAX_MS): Promise<void> {
  return Promise.race([warmSprites(), new Promise<void>((r) => setTimeout(r, maxMs))]);
}
