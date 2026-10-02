/**
 * Game tuning shared by the game server (authoritative simulation) and the web client
 * (prediction, rendering, HUD). Units: pixels, milliseconds, radians.
 * See docs/GAME_DESIGN.md for the rules these numbers implement.
 */

export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** Client samples input at a fixed rate; each input moves the player by exactly INPUT_DT_MS. */
export const INPUT_HZ = 30;
export const INPUT_DT_MS = 1000 / INPUT_HZ;
/** Server-side cap on queued inputs per player (anti speed-hack + memory bound). */
export const MAX_QUEUED_INPUTS = 15;

export const MATCH = {
  /** Total match length; players still on the map at the end lose what they carry. */
  DURATION_MS: 8 * 60_000,
  /** Extraction points open after this (the "drop" phase before it). */
  EXTRACT_OPEN_AT_MS: 60_000,
  /** Standing inside an open extraction circle this long extracts the player. */
  EXTRACT_CHANNEL_MS: 10_000,
  /** Fraction of extraction points that close early (at CLOSE_EARLY_AT of the match). */
  EXTRACT_CLOSE_EARLY_FRACTION: 0.5,
  EXTRACT_CLOSE_EARLY_AT: 0.7,
  /** Players per match (humans + bots in demo). */
  MAX_PLAYERS: 16,
  /** Demo matchmaking waits this long, then fills with bots. */
  MATCHMAKING_TIMEOUT_MS: 4_000,
  /** Room stays alive this long after the end so clients receive the final messages. */
  DISPOSE_AFTER_END_MS: 8_000,
} as const;

export const WORLD = {
  WIDTH: 4800,
  HEIGHT: 4800,
  /** Thickness of the boundary walls around the map. */
  BORDER: 40,
} as const;

export const PLAYER = {
  RADIUS: 24,
  MAX_HP: 100,
  SPEED: 260,
  /** Speed multiplier while healing. */
  HEAL_SPEED_MULT: 0.45,
  /** Pick up ground items / open chests within this distance from the player center. */
  INTERACT_RADIUS: 80,
  /** Ammo and meds are picked up automatically within this distance. */
  AUTO_PICKUP_RADIUS: 40,
} as const;

/** On death every non-free item breaks with this chance (decided by Vlad, 50%). */
export const BREAK_CHANCE_ON_DEATH = 0.5;

/**
 * Heals are channels: all HP lands when the channel completes (Player.healUntil). Firing or
 * switching weapons cancels the heal and the item is NOT consumed — so HP must not trickle in
 * during the channel, or cancelling would give free healing.
 */
export const HEAL = {
  bandage: { HP: 25, MS: 3_000, MAX_CARRY: 10 },
  medkit: { HP: 75, MS: 6_000, MAX_CARRY: 3 },
} as const;

/** Free starter kit: everyone drops with it; it never breaks or drops. */
export const FREE_KIT = {
  WEAPON: "pistol",
  AMMO_LIGHT: 36,
  BANDAGES: 1,
} as const;

/** Shared HTTP headers between game server and web API. */
export const HEADERS = {
  GAME_SERVER_SIG: "x-game-server-signature",
  GAME_SERVER_TS: "x-game-server-timestamp",
} as const;

/** Join tickets older than this are rejected by the game server. */
export const JOIN_TICKET_TTL_MS = 5 * 60_000;
