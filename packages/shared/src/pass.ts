/**
 * Alpha Pass (docs/GAME_DESIGN.md §18e): a 10-tier cosmetic track fed by Alpha Points (AP) from tasks.
 * The contract between the web's settlement (apps/web lib/pass, called from the exit transaction
 * next to the daily tasks), the menu, the admin and the tests.
 *
 * - AP comes only from the server: a daily task finished in a settled exit (PASS.AP_DAILY each), the
 *   weekly tasks (3 a week, rolled per user and UTC week, PASS.AP_WEEKLY each), and the one-time
 *   tester tasks (TESTER_TASKS: tutorial, party, phone, accepted bug report, survey).
 * - No CR, no items, nothing tradable, no power. Every reward is a cosmetic (economy.ts COSMETICS,
 *   `grant`), owned through a pass_unlocks row once the tier is claimed. AP, claims and unlocks are
 *   PERMANENT: the alpha item wipe never touches pass_ap_log / pass_unlocks / pass_weekly (only items,
 *   stash, CR and the market are wiped; docs/ALPHA_PLAN.md).
 * - Alpha top 10 (ALPHA_TROPHY): the first ten ranks of each all-time board at the end of the alpha
 *   get the trophy title, granted by an admin action (/admin, "Grant alpha trophies").
 * - Invite reward (PASS.INVITE_RAIDS): a friend you invited (you sent the friend request) who then
 *   dropped with you in a party and settles their 3rd raid gives you the "Recruiter" title.
 */
import { XP } from "./economy.js";
import { mulberry32, pickWeighted } from "./rng.js";
import type { ExitType } from "./types.js";

export const PASS = {
  /** AP of one finished daily task (3 a day). */
  AP_DAILY: 10,
  /** AP of one finished weekly task (3 a week). */
  AP_WEEKLY: 40,
  WEEKLY_SLOTS: 3,
  /** A tester task done in a raid (party, phone) needs this long on the map: no drop-and-leave. */
  TESTER_MIN_ONMAP_MS: 3 * 60_000,
  /** Settled raids an invited friend plays before the inviter gets t-recruiter. */
  INVITE_RAIDS: 3,
  /** Bug report text limits (characters). */
  BUG_MIN: 10,
  BUG_MAX: 1_000,
  /** Open (not yet reviewed) bug reports a player may have at once. */
  BUG_OPEN_MAX: 5,
} as const;

// ---------------------------------------------------------------- tiers

export interface PassTier {
  tier: number;
  /** Cumulative AP to reach this tier. */
  ap: number;
  /** Cosmetic id (economy.ts COSMETICS, grant "pass"). */
  reward: string;
}

/**
 * The track. Tier 1 = the tutorial task alone (30 AP). A tester who does every tester task, half the
 * daily tasks and two weekly tasks a week reaches tier 10 in about four weeks of the alpha.
 */
export const PASS_TIERS: readonly PassTier[] = [
  { tier: 1, ap: 30, reward: "t-alpha-raider" },
  { tier: 2, ap: 80, reward: "t-field-tester" },
  { tier: 3, ap: 140, reward: "f-founder" },
  { tier: 4, ap: 210, reward: "t-bug-hunter" },
  { tier: 5, ap: 290, reward: "c-alpha-mint" },
  { tier: 6, ap: 380, reward: "t-signal-runner" },
  { tier: 7, ap: 480, reward: "f-alpha-signal" },
  { tier: 8, ap: 590, reward: "s-alpha-veteran" },
  { tier: 9, ap: 700, reward: "c-alpha-dawn" },
  { tier: 10, ap: 820, reward: "b-founder" },
];

/** Tiers reached with `ap` (0..10). */
export function passTierOf(ap: number): number {
  const a = Number.isFinite(ap) ? ap : 0;
  let t = 0;
  for (const x of PASS_TIERS) if (a >= x.ap) t = x.tier;
  return t;
}

/** The first tier above `ap`, or null at the top. */
export function nextPassTier(ap: number): PassTier | null {
  const a = Number.isFinite(ap) ? ap : 0;
  return PASS_TIERS.find((x) => a < x.ap) ?? null;
}

/** The tier whose reward is `id`, or null. */
export function passTierOfReward(id: string): PassTier | null {
  return PASS_TIERS.find((x) => x.reward === id) ?? null;
}

/** The skin a pass-tier-8 player wears (also drawn in the raid as a tint). */
export const ALPHA_SKIN = "s-alpha-veteran";
/** The permanent leaderboard badge (tier 10). */
export const FOUNDER_BADGE = "b-founder";

/** The alpha trophy rule: the top `top` ranks (ties included) of each board, all time, at the end of the alpha. */
export const ALPHA_TROPHY = {
  reward: "t-alpha-top10",
  top: 10,
  boards: ["level", "kills", "npc"] as const,
} as const;

/** The invite reward. */
export const INVITE_REWARD = "t-recruiter";

// ---------------------------------------------------------------- weekly tasks

export type WeeklyId =
  | "w_boss"
  | "w_epic"
  | "w_streak3"
  | "w_extract5"
  | "w_marauders15"
  | "w_guards3"
  | "w_containers40"
  | "w_bodies8";

export interface WeeklyDef {
  id: WeeklyId;
  label: string;
  short: string;
  hint: string;
  need: number;
  weight: number;
}

export const WEEKLY_POOL: readonly WeeklyDef[] = [
  { id: "w_boss", label: "Kill a boss", short: "Boss kill", hint: "Any event boss. The kill counts even if you don't make it out.", need: 1, weight: 2 },
  {
    id: "w_epic",
    label: "Extract an epic item",
    short: "Epic extract",
    hint: "Extract with an epic or legendary weapon, armor or backpack in your bag.",
    need: 1,
    weight: 2,
  },
  {
    id: "w_streak3",
    label: "Survive 3 raids in a row",
    short: "3 in a row",
    hint: "Three extracts after 8+ minutes on the map, no death in between. A death or MIA starts over.",
    need: 3,
    weight: 3,
  },
  { id: "w_extract5", label: "Extract 5 times (8+ min)", short: "Extract ×5", hint: "Each extract after 8 or more minutes on the map counts.", need: 5, weight: 3 },
  { id: "w_marauders15", label: "Kill 15 marauders", short: "15 marauders", hint: "Marauders anywhere on the map. Guards and bosses don't count.", need: 15, weight: 3 },
  { id: "w_guards3", label: "Kill 3 boss guards", short: "3 guards", hint: "Guards around an event boss.", need: 3, weight: 2 },
  { id: "w_containers40", label: "Search 40 containers", short: "40 containers", hint: "A container counts once its search opens, once per map.", need: 40, weight: 2 },
  { id: "w_bodies8", label: "Search 8 bodies", short: "8 bodies", hint: "Marauder, guard or raider bodies, once each. Your own doesn't count.", need: 8, weight: 2 },
];

export function weeklyDef(id: unknown): WeeklyDef | null {
  return WEEKLY_POOL.find((q) => q.id === id) ?? null;
}

/** What one settled exit did, for the pass (the web fills it in the exit transaction). */
export interface PassExitFacts {
  exit: ExitType;
  onMapMs: number;
  /** RaidStats.containersSearched / corpsesSearched. */
  containers: number;
  bodies: number;
  /** npcKills − guardKills, guardKills, bossKills. */
  marauders: number;
  guards: number;
  bosses: number;
  /** An extracted unique of rarity ≥ 2 (epic, legendary). */
  epicExtracted: boolean;
  /** The entry dropped in a party drop of 2+ members (party_drops of this match). */
  party: boolean;
  /** The game server saw this entry on touch controls (PlayerExitReport.touch). */
  touch: boolean;
}

const cnt = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/** A qualified extract (the XP rule): exit "extract" after ≥ XP.MIN_ONMAP_MS. */
function qualified(f: PassExitFacts): boolean {
  return f.exit === "extract" && (Number.isFinite(f.onMapMs) ? f.onMapMs : 0) >= XP.MIN_ONMAP_MS;
}

/**
 * The progress of weekly task `id` after this exit (capped at need by the caller):
 *   w_streak3: qualified ? progress + 1 : (exit dead / mia → 0; a short extract keeps it)
 *   w_extract5: + qualified;  w_epic: + (extract and epicExtracted);  w_boss: + bosses
 *   w_marauders15 / w_guards3: + kills;  w_containers40 / w_bodies8: + searches, 0 for "mia"
 */
export function weeklyNext(id: WeeklyId, progress: number, f: PassExitFacts): number {
  const p = cnt(progress);
  const searched = f.exit !== "mia";
  switch (id) {
    case "w_streak3":
      if (qualified(f)) return p + 1;
      return f.exit === "dead" || f.exit === "mia" ? 0 : p;
    case "w_extract5":
      return p + (qualified(f) ? 1 : 0);
    case "w_epic":
      return p + (f.exit === "extract" && f.epicExtracted ? 1 : 0);
    case "w_boss":
      return p + Math.min(16, cnt(f.bosses));
    case "w_marauders15":
      return p + Math.min(1_000, cnt(f.marauders));
    case "w_guards3":
      return p + Math.min(1_000, cnt(f.guards));
    case "w_containers40":
      return p + (searched ? Math.min(XP.CONTAINER_MAX, cnt(f.containers)) : 0);
    case "w_bodies8":
      return p + (searched ? Math.min(1_000, cnt(f.bodies)) : 0);
  }
}

export interface WeeklySlotState {
  slot: number;
  id: WeeklyId;
  need: number;
  progress: number;
  done: boolean;
}

/** One exit applied to the weekly slots: open slots move (weeklyNext, capped at need); reaching need finishes them. */
export function applyWeeklyExit(slots: readonly WeeklySlotState[], f: PassExitFacts): { slots: WeeklySlotState[]; finished: WeeklySlotState[] } {
  const finished: WeeklySlotState[] = [];
  const next = slots.map((s) => {
    if (s.done) return { ...s };
    const progress = Math.min(s.need, weeklyNext(s.id, s.progress, f));
    const done = progress >= s.need;
    const out = { ...s, progress, done };
    if (done) finished.push(out);
    return out;
  });
  return { slots: next, finished };
}

/** "2026-10-05": Monday (UTC) of the week holding `ms` — weekly tasks turn at Monday 00:00 UTC. */
export function passWeek(ms: number): string {
  const day = Math.floor(ms / 86_400_000);
  // 1970-01-01 was a Thursday: (day + 3) % 7 is 0 on Mondays.
  const monday = day - ((day + 3) % 7);
  return new Date(monday * 86_400_000).toISOString().slice(0, 10);
}

/** The next Monday 00:00 UTC after `ms`. */
export function passWeekResetAt(ms: number): number {
  return Date.parse(`${passWeek(ms)}T00:00:00Z`) + 7 * 86_400_000;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The weekly task of `slot` for `userId` in `week` (deterministic; never one of `exclude`). */
export function rollWeekly(userId: string, week: string, slot: number, exclude: readonly string[] = []): WeeklyId {
  const open = WEEKLY_POOL.filter((q) => !exclude.includes(q.id));
  const from = open.length > 0 ? open : WEEKLY_POOL;
  const rng = mulberry32(fnv1a(`weekly|${userId.toLowerCase()}|${week}|${slot}`));
  return pickWeighted(rng, from).id;
}

/** The week's three tasks of `userId`, all different. */
export function rollWeeklyTasks(userId: string, week: string): WeeklyId[] {
  const out: WeeklyId[] = [];
  for (let s = 0; s < PASS.WEEKLY_SLOTS; s++) out.push(rollWeekly(userId, week, s, out));
  return out;
}

// ---------------------------------------------------------------- tester tasks

export type TesterId = "tutorial" | "party" | "touch" | "bug" | "survey";

export interface TesterDef {
  id: TesterId;
  label: string;
  hint: string;
  ap: number;
}

export const TESTER_TASKS: readonly TesterDef[] = [
  { id: "tutorial", label: "Finish the tutorial", hint: "In one raid: search a container, kill a marauder and extract.", ap: 30 },
  { id: "party", label: "Play a raid in a party", hint: "Drop together with a friend and stay 3+ minutes on the map.", ap: 40 },
  { id: "touch", label: "Play a raid on a phone", hint: "Touch controls, 3+ minutes on the map.", ap: 40 },
  { id: "bug", label: "Report a bug", hint: "Send it from the Pass. It counts once the team accepts it.", ap: 50 },
  { id: "survey", label: "Answer the alpha survey", hint: "Four short questions in the Pass.", ap: 30 },
];

export function testerDef(id: unknown): TesterDef | null {
  return TESTER_TASKS.find((t) => t.id === id) ?? null;
}

/** Tester tasks this settled exit completes (the bug report and the survey never come from a raid). */
export function testerDoneByExit(f: PassExitFacts): TesterId[] {
  const onMap = Number.isFinite(f.onMapMs) ? f.onMapMs : 0;
  const out: TesterId[] = [];
  if (f.exit === "extract" && cnt(f.containers) >= 1 && cnt(f.marauders) + cnt(f.guards) + cnt(f.bosses) >= 1) out.push("tutorial");
  if (f.party && onMap >= PASS.TESTER_MIN_ONMAP_MS) out.push("party");
  if (f.touch && onMap >= PASS.TESTER_MIN_ONMAP_MS) out.push("touch");
  return out;
}

// ---------------------------------------------------------------- survey

export interface SurveyQuestion {
  id: string;
  text: string;
  /** Choices; an empty list = free text (optional, ≤ SURVEY_TEXT_MAX). */
  choices: readonly string[];
}

export const SURVEY_TEXT_MAX = 300;

export const ALPHA_SURVEY: readonly SurveyQuestion[] = [
  { id: "device", text: "Where do you play most?", choices: ["Phone", "Computer", "Both"] },
  { id: "fun", text: "How fun was your last raid?", choices: ["1", "2", "3", "4", "5"] },
  { id: "fix", text: "What should we fix first?", choices: ["Combat", "Loot", "Menus", "Performance", "Other"] },
  { id: "note", text: "Anything else? (optional)", choices: [] },
];

/** Normalized answers, or null when a choice question is missing or invalid. */
export function parseSurvey(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const q of ALPHA_SURVEY) {
    const v = r[q.id];
    if (q.choices.length === 0) {
      if (typeof v === "string" && v.trim()) out[q.id] = v.trim().slice(0, SURVEY_TEXT_MAX);
      continue;
    }
    if (typeof v !== "string" || !q.choices.includes(v)) return null;
    out[q.id] = v;
  }
  return out;
}

// ---------------------------------------------------------------- API (apps/web app/api/pass)

export interface PassTierDto {
  tier: number;
  ap: number;
  reward: string;
  name: string;
  kind: string;
  reached: boolean;
  claimed: boolean;
}

export interface WeeklySlotDto {
  slot: number;
  id: WeeklyId;
  label: string;
  short: string;
  hint: string;
  need: number;
  progress: number;
  done: boolean;
}

export interface TesterTaskDto {
  id: TesterId;
  label: string;
  hint: string;
  ap: number;
  done: boolean;
  /** The bug task: a report waits for review. */
  pending?: boolean;
}

/** GET /api/pass (registered players, private, no-store). */
export interface PassDto {
  serverTime: number;
  ap: number;
  tier: number;
  tiers: PassTierDto[];
  /** The next tier to reach, null at the top. */
  next: { tier: number; ap: number; reward: string; name: string } | null;
  daily: { apEach: number; doneToday: number; max: number };
  weekly: { week: string; resetAt: number; apEach: number; slots: WeeklySlotDto[] };
  tester: TesterTaskDto[];
  /** Grant cosmetics the player owns (pass tiers claimed, trophy, invite). */
  owned: string[];
  /** Equipped skin id or null. */
  skin: string | null;
  /** AP and tier from this alpha survive the wipe (always true; shown in the UI). */
  permanent: true;
}
