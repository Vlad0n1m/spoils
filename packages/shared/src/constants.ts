/** In-game mass uses the same scale as the historical lamport-based build; 1 US cent of stake = 1_000_000 mass units. */
export const MASS_UNITS_PER_CENT = 1_000_000n;
export const CENTS_PER_DOLLAR = 100n;

export const ROUND_MS = 120_000;
export const LOCKIN_MS = 60_000;
export const EXTRACT_CHANNEL_MS = 15_000;

export const MIN_PLAYERS = 15;
export const MATCHMAKING_TIMEOUT_MS = 3_000;

export const SERVER_TICK_HZ = 20;
export const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;

/** Stake tiers in US dollar cents: $0.10, $1, $5, $10. */
export const ENTRY_TIERS_CENTS: readonly bigint[] = [
  10n,
  100n,
  500n,
  1_000n,
];

/**
 * Body length and segment growth use economic mass scaled to the minimum tier so all buy-ins
 * feel like the $0.10 lobby; `Player.massUnits` and payouts stay in real tier-sized units.
 */
export const SNAKE_LENGTH_REFERENCE_TIER_CENTS: bigint =
  ENTRY_TIERS_CENTS[0] ?? 10n;

/** Map ledger mass → mass basis used only for snake length (`targetSegmentCount` / body sync). */
export function economicMassToSnakeLengthMass(
  economicMassUnits: bigint,
  entryTierCents: bigint,
): bigint {
  if (entryTierCents <= 0n) return economicMassUnits;
  return (economicMassUnits * SNAKE_LENGTH_REFERENCE_TIER_CENTS) / entryTierCents;
}

export const WORLD = {
  R0: 2000,
  /** Final radius when the round timer ends; 0 = zone closes completely (playable point). */
  R_END: 0,
  AMBIENT_ORB_FRACTION: 0.5,
  /**
   * Ambient orb count at start = this × player count (same for all buy-in tiers).
   * Lower = fewer, heavier orbs (same total ambient mass) so pickups feel meaningful vs segment steps.
   */
  AMBIENT_ORBS_PER_PLAYER: 6,
} as const;

export const SNAKE = {
  BASE_SPEED: 180,
  BOOST_MULT: 1.8,
  /** Body length: one extra segment per this many mass units (length is primary growth). */
  MASS_UNITS_PER_EXTRA_SEGMENT: 400_000n,
  /** Max body segments to avoid unbounded state on huge mass. */
  MAX_SEGMENTS: 3000,
  BASE_HEAD_RADIUS: 12,
  /** Kept for compatibility; head collision radius is fixed (see `radiusFor` in sim). */
  HEAD_RADIUS_MASS_K: 0.000_000_03,
  SEGMENT_SPACING: 14,
  STARTING_SEGMENTS: 8,
  TURN_RATE_PER_SEC: 6,
} as const;

export const ORB = {
  PICKUP_RADIUS_BONUS: 4,
} as const;

export const PAYOUT = {
  FIRST_OUT_MULT: 0.8,
  LAST_OUT_MULT: 1.1,
} as const;

export const HEADERS = {
  GAME_SERVER_SIG: "x-game-server-signature",
  GAME_SERVER_TS: "x-game-server-timestamp",
} as const;
