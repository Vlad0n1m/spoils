/**
 * Daily tasks (docs/RETENTION.md §5.1): the contract between the web's settlement (apps/web
 * lib/quests, called from the exit transaction in lib/inventory/raids.ts), the menu and the API.
 *
 * - QUEST.SLOTS slots per registered player. At the first look on a UTC day (GET /api/quests, or an
 *   exit settlement once the player has tasks) every slot finished on an earlier day gets a new task
 *   rolled from QUEST_POOL. An unfinished task stays with its progress (a missed day costs nothing).
 * - Rolls are deterministic per (user, UTC day, slot): rollQuest hashes them into a mulberry32 seed,
 *   so a replayed or raced fill gives the same task. One slot never repeats another slot's task.
 * - One free swap a day (QUEST.REROLLS_PER_DAY) of an unfinished task; there is no paid swap, for SOL
 *   or CR.
 * - Progress comes only from settled exit reports, on the server (questStep over the same counters
 *   as XP: an extract counts after XP.MIN_ONMAP_MS on the map, containers and bodies only once their
 *   search opened and once per map, kills are real NPCs). The client never claims anything.
 * - Reward: XP only, QUEST.XP per task and at most QUEST.DAILY_XP_MAX a UTC day. That XP is outside
 *   the daily soft cap (raid_exits.xp_grind) and after the first-extract bonus, so it neither fills
 *   the cap for raids nor gets doubled. Each completed task also counts one mark toward the
 *   cosmetic MARK_REWARDS (economy.ts). No CR, no items, nothing tradable.
 */
import { XP } from "./economy.js";
import { mulberry32, pickWeighted } from "./rng.js";
import type { ExitType } from "./types.js";

export const QUEST = {
  SLOTS: 3,
  /** XP of one task. */
  XP: 100,
  /** XP from tasks per UTC day (3 × 100). */
  DAILY_XP_MAX: 300,
  /** Free swaps of an unfinished task per UTC day. */
  REROLLS_PER_DAY: 1,
  /** "Extract after 12+ min on the map". */
  LONG_STAY_MS: 12 * 60_000,
  /** "Extract with 300+ CR of junk": the exit's junk CR, dog tags excluded. */
  JUNK_CR: 300,
} as const;

export type QuestId = "extract_twice" | "containers_10" | "marauders_3" | "junk_300" | "bodies_2" | "long_stay";

export interface QuestDef {
  id: QuestId;
  /** Menu text. */
  label: string;
  /** Short form for a narrow card. */
  short: string;
  /** What counts, one sentence. */
  hint: string;
  need: number;
  xp: number;
  /** Weight in the daily roll. */
  weight: number;
}

/** The daily pool (RETENTION.md §5.1). No PvP task: a pair of alt accounts could close it together. */
export const QUEST_POOL: readonly QuestDef[] = [
  {
    id: "extract_twice",
    label: "Extract twice (8+ min on the map)",
    short: "Extract ×2",
    hint: "Each extract after 8 or more minutes on the map counts.",
    need: 2,
    xp: QUEST.XP,
    weight: 3,
  },
  {
    id: "containers_10",
    label: "Search 10 containers",
    short: "10 containers",
    hint: "A container counts once its search opens, once per map — the same rule as container XP.",
    need: 10,
    xp: QUEST.XP,
    weight: 3,
  },
  {
    id: "marauders_3",
    label: "Kill 3 marauders",
    short: "3 marauders",
    hint: "Marauders anywhere on the map. Guards and bosses don't count.",
    need: 3,
    xp: QUEST.XP,
    weight: 3,
  },
  {
    id: "junk_300",
    label: "Extract with 300+ CR of junk",
    short: "300+ CR haul",
    hint: "One extract after 8+ minutes whose junk sells for 300 CR or more (dog tags don't count).",
    need: 1,
    xp: QUEST.XP,
    weight: 2,
  },
  {
    id: "bodies_2",
    label: "Search 2 bodies",
    short: "2 bodies",
    hint: "Marauder, guard or raider bodies, once each. Your own body doesn't count.",
    need: 2,
    xp: QUEST.XP,
    weight: 2,
  },
  {
    id: "long_stay",
    label: "Extract after 12+ min on the map",
    short: "12+ min extract",
    hint: "Stay on the map 12 minutes or longer, then extract.",
    need: 1,
    xp: QUEST.XP,
    weight: 2,
  },
];

/** The pool entry of `id`, or null (a task removed from the pool). */
export function questDef(id: unknown): QuestDef | null {
  return QUEST_POOL.find((q) => q.id === id) ?? null;
}

/** What one settled exit did, in the counters that XP uses (raids.ts fills it next to xpForExit). */
export interface QuestExitFacts {
  exit: ExitType;
  onMapMs: number;
  /** Junk CR of the exit's autosell receipt, dog tags excluded (XpInput.haulCr). */
  haulCr: number;
  /** RaidStats.containersSearched. */
  containers: number;
  /** npcKillCount(report) − guardKills (XpInput.marauders). */
  marauders: number;
  /** RaidStats.corpsesSearched. */
  bodies: number;
}

const cnt = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/**
 * Progress units this exit adds to task `id`:
 *   qualified = exit "extract" after ≥ XP.MIN_ONMAP_MS on the map
 *   extract_twice: qualified ? 1 : 0;  long_stay: exit "extract" after ≥ QUEST.LONG_STAY_MS ? 1 : 0
 *   junk_300: qualified and haulCr ≥ QUEST.JUNK_CR ? 1 : 0
 *   containers_10: min(XP.CONTAINER_MAX, containers), bodies_2: bodies — both 0 for "mia" (D9: a
 *   wiped player keeps the kill lines only, as in xpForExit)
 *   marauders_3: marauders
 */
export function questStep(id: QuestId, f: QuestExitFacts): number {
  const onMap = Number.isFinite(f.onMapMs) ? Math.max(0, f.onMapMs) : 0;
  const extracted = f.exit === "extract";
  const qualified = extracted && onMap >= XP.MIN_ONMAP_MS;
  const searched = f.exit !== "mia";
  switch (id) {
    case "extract_twice":
      return qualified ? 1 : 0;
    case "long_stay":
      return extracted && onMap >= QUEST.LONG_STAY_MS ? 1 : 0;
    case "junk_300":
      return qualified && cnt(f.haulCr) >= QUEST.JUNK_CR ? 1 : 0;
    case "containers_10":
      return searched ? Math.min(XP.CONTAINER_MAX, cnt(f.containers)) : 0;
    case "bodies_2":
      return searched ? Math.min(1_000, cnt(f.bodies)) : 0;
    case "marauders_3":
      return Math.min(1_000, cnt(f.marauders));
  }
}

/** "2026-10-04": the UTC day of `ms` (task days and the XP day both turn at 00:00 UTC). */
export function questDay(ms: number): string {
  return new Date(Math.floor(ms / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `ms` (new tasks). */
export function questResetAt(ms: number): number {
  return (Math.floor(ms / 86_400_000) + 1) * 86_400_000;
}

/** FNV-1a 32-bit of a string (the roll seed). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The task rolled into `slot` of `userId` on UTC `day`: weighted pick from QUEST_POOL minus the ids
 * in `exclude` (the other slots' tasks; on a swap also the swapped one). Same inputs → same task.
 * `salt` separates a swap (1) from the day's fill (0).
 */
export function rollQuest(userId: string, day: string, slot: number, exclude: readonly string[] = [], salt = 0): QuestId {
  const open = QUEST_POOL.filter((q) => !exclude.includes(q.id));
  const from = open.length > 0 ? open : QUEST_POOL;
  const rng = mulberry32(fnv1a(`${userId.toLowerCase()}|${day}|${slot}|${salt}`));
  return pickWeighted(rng, from).id;
}

/**
 * Fills the empty (null) entries of `slots` for `day` in slot order, each excluding the tasks of the
 * other slots (filled ones included), so no two slots hold the same task.
 */
export function fillQuestSlots(userId: string, day: string, slots: ReadonlyArray<QuestId | null>): QuestId[] {
  const out: Array<QuestId | null> = [...slots];
  while (out.length < QUEST.SLOTS) out.push(null);
  for (let s = 0; s < out.length; s++) {
    if (out[s]) continue;
    const others = out.filter((v, i): v is QuestId => i !== s && v !== null);
    out[s] = rollQuest(userId, day, s, others);
  }
  return out as QuestId[];
}

/** The three tasks a player with no tasks gets on `day`. */
export function rollDailyQuests(userId: string, day: string): QuestId[] {
  return fillQuestSlots(userId, day, []);
}

/** XP a task completed now may still pay today: min(xp, DAILY_XP_MAX − xpToday), never below 0. */
export function questXpRoom(xpToday: number, xp: number = QUEST.XP): number {
  const today = Number.isFinite(xpToday) ? Math.max(0, Math.floor(xpToday)) : 0;
  return Math.max(0, Math.min(Math.max(0, Math.floor(xp)), QUEST.DAILY_XP_MAX - today));
}

/** One slot as settlement sees it. */
export interface QuestSlotState {
  slot: number;
  id: QuestId;
  need: number;
  xp: number;
  progress: number;
  done: boolean;
}

export interface QuestAward {
  slot: number;
  id: QuestId;
  xp: number;
}

/**
 * One exit applied to the slots: every open slot gains questStep (progress capped at need); a slot
 * that reaches need is done and pays questXpRoom(xpToday + the XP paid by earlier slots of this
 * exit, slot.xp). Done slots do not move. Pure: the web writes the result in the exit transaction.
 */
export function applyQuestExit(
  slots: readonly QuestSlotState[],
  facts: QuestExitFacts,
  xpToday: number,
): { slots: QuestSlotState[]; awards: QuestAward[]; xp: number } {
  let paid = 0;
  const awards: QuestAward[] = [];
  const next = slots.map((s) => {
    if (s.done) return { ...s };
    const progress = Math.min(s.need, s.progress + questStep(s.id, facts));
    if (progress < s.need) return { ...s, progress };
    const xp = questXpRoom(xpToday + paid, s.xp);
    paid += xp;
    awards.push({ slot: s.slot, id: s.id, xp });
    return { ...s, progress, done: true };
  });
  return { slots: next, awards, xp: paid };
}

// ---------------------------------------------------------------- API (apps/web app/api/quests)

/** One task in GET /api/quests. */
export interface QuestSlotDto {
  slot: number;
  id: QuestId;
  label: string;
  short: string;
  hint: string;
  need: number;
  progress: number;
  xp: number;
  /** Finished: stays until the next UTC day, then the slot gets a new task. */
  done: boolean;
  /** Issued on an earlier UTC day and still open (carried over with its progress). */
  carried: boolean;
}

/** Equipped cosmetic ids (economy.ts COSMETICS), null = none. */
export interface EquippedCosmetics {
  title: string | null;
  color: string | null;
  frame: string | null;
  /** Character skin (Alpha Pass tier 8), null = the default look. */
  skin: string | null;
}

/** GET /api/quests (registered players, private, no-store). */
export interface QuestsDto {
  serverTime: number;
  /** UTC day of these tasks, "YYYY-MM-DD". */
  day: string;
  /** Next 00:00 UTC (finished slots get new tasks). */
  resetAt: number;
  slots: QuestSlotDto[];
  /** The day's free swap is still unused. */
  rerollAvailable: boolean;
  /** Task XP paid today / the daily maximum. */
  xpToday: number;
  xpMax: number;
  /** Completed tasks, all time (MARK_REWARDS). */
  marks: number;
  level: number;
  equipped: EquippedCosmetics;
  /** Granted cosmetics owned (Alpha Pass tiers claimed, trophy, invite): wearable next to the level ones. */
  granted: string[];
}

/** GET /api/quests/badges?n=<nickname>…: equipped cosmetics of those players (leaderboards). */
export interface CosmeticBadgesDto {
  /**
   * `badge`: an owned leaderboard badge (Alpha Pass tier 10 "Founder"); never equipped, always shown.
   * `seeker`: the linked wallet holds a Seeker Genesis Token (apps/web lib/seeker); shown, never worn.
   */
  badges: Record<string, Partial<EquippedCosmetics> & { badge?: string; seeker?: boolean }>;
}
