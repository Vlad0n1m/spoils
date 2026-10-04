/**
 * DTOs of /admin and /api/admin/** (client-safe: no server imports). The admin UI is the owner's
 * tool, so its copy is Russian; player-facing UI stays English.
 */

/** A signed-in user whose users.role is 'admin' (lib/admin/guard.ts findAdmin). */
export interface AdminUser {
  id: string;
  nickname: string;
}

/** Exit kinds counted on the metrics page (raid_exits.exit; 'timeout' only on legacy rows). */
export const EXIT_KINDS = ["extract", "dead", "mia", "timeout"] as const;
export type ExitKind = (typeof EXIT_KINDS)[number];

/** One UTC day of the 7-day window (the last one is today, still running). */
export interface AdminDay {
  /** YYYY-MM-DD (UTC). */
  day: string;
  /** World entries minted that day (raid_entries), guests included. */
  entries: number;
  entriesGuest: number;
  /** Entries with the player's own gear (free_kit = false). */
  entriesGear: number;
  /** Settled exits by kind (raid_exits), guests included. */
  exits: Record<ExitKind, number>;
  /** = exits.dead. */
  deaths: number;
  /** pvp_kills rows (kills by registered players), ranked and not. */
  pvpKills: number;
  pvpRanked: number;
  /** credit_ledger: Σ positive deltas / Σ |negative deltas|. */
  crIn: number;
  crOut: number;
  /** money_ledger account 'house', minor units as a decimal string. */
  houseMinor: string;
}

export interface AdminShardOnline {
  shard: number;
  matchId: string;
  registered: number;
  guests: number;
}

export interface AdminOnline {
  cycle: number;
  mapNumber: number;
  /** Running world rows of the current cycle with their active entries. */
  shards: AdminShardOnline[];
  total: number;
  registered: number;
  guests: number;
  /** Active entries of older cycles (should be 0: the void-raids cron settles them). */
  staleActive: number;
}

export interface AdminCreditReason {
  reason: string;
  in7d: number;
  out7d: number;
  inToday: number;
  outToday: number;
}

export interface AdminHouseReason {
  reason: string;
  /** Minor units as decimal strings. */
  today: string;
  d7: string;
  all: string;
}

export type KpiStatus = "ok" | "warn" | "alarm" | "none";

/** One KPI row of docs/ALPHA_PLAN.md §4 (plus a few from GAME_DESIGN §22). */
export interface AdminKpi {
  id: string;
  label: string;
  /** Formatted value, or null = «нет данных». */
  value: string | null;
  norm: string;
  alarm: string;
  status: KpiStatus;
  /** How it is counted / why there is no data. */
  note: string;
  /** "§4" (ALPHA_PLAN) or "§22" (GAME_DESIGN extra). */
  source: "§4" | "§22";
}

export interface AdminMetrics {
  generatedAt: number;
  /** Start of the window (UTC midnight six days before today). */
  since: number;
  online: AdminOnline;
  /** Seven UTC days, oldest first; the last one is today. */
  days: AdminDay[];
  credits: { byReason: AdminCreditReason[]; in7d: number; out7d: number };
  items: { byState: Array<{ state: string; n: number }>; total: number };
  house: { currency: string; byReason: AdminHouseReason[]; d7: string; all: string };
  kpis: AdminKpi[];
}

// ------------------------------------------------------------------ stop-cranes (economy_params)

export interface AdminParam {
  key: string;
  label: string;
  /** What it does and who reads it. */
  help: string;
  kind: "number" | "int";
  min: number;
  max: number;
  step: number;
  /** The code default used while no row is stored. */
  def: number;
  /** Effective value (stored, or the default). */
  value: number;
  /** A row exists in economy_params. */
  stored: boolean;
  updatedAt: number | null;
  /** One-click values (all inside min..max). */
  quick: Array<{ label: string; value: number }>;
}

export interface AdminReadOnlyParam {
  key: string;
  note: string;
  value: unknown;
  updatedAt: number | null;
}

export interface AdminAuditEntry {
  id: number;
  at: number;
  admin: string;
  action: string;
  target: string;
  oldValue: unknown;
  newValue: unknown;
  note: string | null;
}

export interface AdminParamsDto {
  params: AdminParam[];
  readOnly: AdminReadOnlyParam[];
  audit: AdminAuditEntry[];
}

/** POST /api/admin/params body. `expected` = the value the admin saw (stale → 409). */
export interface AdminParamSetBody {
  key: string;
  value: number;
  expected: number;
  note?: string;
}

export type AdminParamSetError = "bad_body" | "unknown_param" | "out_of_range" | "stale";

export type AdminParamSetResult =
  | { ok: true; param: AdminParam; audit: AdminAuditEntry }
  | { ok: false; error: AdminParamSetError; message: string; current?: number };
