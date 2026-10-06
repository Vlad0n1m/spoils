/**
 * Daily tasks and earn-only cosmetics on the web (docs/RETENTION.md §5; rules in @extract/shared
 * quests.ts and the economy.ts level reward table). Tables: quest_slots, quest_log, users.title /
 * name_color / badge_frame (migration 008).
 *
 * - getQuests (GET /api/quests): issues the day's tasks at the first look of a UTC day — every slot
 *   finished on an earlier day gets a new roll, open tasks carry over with their progress.
 * - advanceQuestsForExit: called once inside applyExit's transaction (raids.ts), after xpForExit, for
 *   registered players only. Progress comes from the settled report's counters, never from the
 *   client; a finished task pays its XP (QUEST.DAILY_XP_MAX a UTC day, outside xp_grind) and logs
 *   one quest_log row (one mark). A player who has never been issued tasks gets none here.
 * - rerollQuest: the day's one free swap of an open task.
 * - equipCosmetic: picks a title / name colour / badge frame the player has unlocked.
 * Lock order in every writing transaction: the users row first, then the player's quest_slots rows
 * (applyExit already holds the users row FOR UPDATE when it calls in), so the exit, the menu's first
 * look of the day, a swap and an equip never deadlock. A look at slots already on today only reads.
 */
import { sql } from "drizzle-orm";
import {
  QUEST,
  applyQuestExit,
  cosmeticDef,
  cosmeticUnlocked,
  fillQuestSlots,
  levelForXp,
  questDay,
  questDef,
  questResetAt,
  rollQuest,
  FOUNDER_BADGE,
  type EquippedCosmetics,
  type WearableKind,
  type QuestExitFacts,
  type QuestId,
  type QuestSlotDto,
  type QuestsDto,
} from "@extract/shared";
import type { Db, Tx } from "../inventory/db";
import { grantedOf } from "../pass/pass";
import { SEEKER_BADGE_SQL } from "../seeker/seeker";

type SlotRow = {
  slot: number;
  quest_id: string;
  need: number;
  xp: number;
  progress: number;
  issued_day: string;
  done_day: string | null;
  rerolled_day: string | null;
};

const SLOT_COLS = sql`slot, quest_id, need, xp, progress, issued_day::text as issued_day, done_day::text as done_day,
  rerolled_day::text as rerolled_day`;

function normRow(r: SlotRow): SlotRow {
  return { ...r, slot: Number(r.slot), need: Number(r.need), xp: Number(r.xp), progress: Number(r.progress) };
}

/** The player's slot rows, locked for the rest of the transaction. */
async function lockSlots(tx: Tx, userId: string): Promise<SlotRow[]> {
  const r = await tx.execute<SlotRow>(sql`
    select ${SLOT_COLS} from quest_slots where user_id = ${userId} order by slot for update`);
  return r.rows.map(normRow);
}

/**
 * The task each slot keeps on `day`, or null where it needs a new roll: a missing slot, a slot
 * finished before `day`, an open slot whose task left the pool.
 */
function keptTasks(rows: readonly SlotRow[], day: string): Array<QuestId | null> {
  const bySlot = new Map(rows.map((r) => [r.slot, r]));
  const keep: Array<QuestId | null> = [];
  for (let s = 0; s < QUEST.SLOTS; s++) {
    const r = bySlot.get(s);
    const stale = !r || (r.done_day !== null && r.done_day < day) || (r.done_day === null && !questDef(r.quest_id));
    keep.push(stale ? null : (r!.quest_id as QuestId));
  }
  return keep;
}

/**
 * Brings the slots to `day`: every slot keptTasks marks gets fillQuestSlots' roll for `day`
 * (deterministic per user, day and slot). Writes only what changed and returns the slots in order.
 */
async function refreshSlots(tx: Tx, userId: string, day: string, rows: SlotRow[]): Promise<SlotRow[]> {
  const keep = keptTasks(rows, day);
  if (keep.every((v) => v !== null)) return rows.filter((r) => r.slot < QUEST.SLOTS);
  const ids = fillQuestSlots(userId, day, keep);
  for (let s = 0; s < QUEST.SLOTS; s++) {
    if (keep[s] !== null) continue;
    const def = questDef(ids[s])!;
    await tx.execute(sql`
      insert into quest_slots (user_id, slot, quest_id, need, xp, progress, issued_day, done_day, rerolled_day, updated_at)
      values (${userId}, ${s}, ${def.id}, ${def.need}, ${def.xp}, 0, ${day}::date, null, null, now())
      on conflict (user_id, slot) do update set
        quest_id = excluded.quest_id, need = excluded.need, xp = excluded.xp, progress = 0,
        issued_day = excluded.issued_day, done_day = null, rerolled_day = null, updated_at = now()`);
  }
  return lockSlots(tx, userId);
}

/** Task XP paid on `day` (≤ QUEST.DAILY_XP_MAX). */
async function questXpOn(tx: Tx | Db, userId: string, day: string): Promise<number> {
  const r = await tx.execute<{ xp: number }>(sql`
    select coalesce(sum(xp), 0)::int as xp from quest_log where user_id = ${userId} and day = ${day}::date`);
  return Number(r.rows[0]?.xp ?? 0);
}

/** Completed tasks, all time (task marks). */
export async function questMarks(q: Tx | Db, userId: string): Promise<number> {
  const r = await q.execute<{ n: number }>(sql`select count(*)::int as n from quest_log where user_id = ${userId}`);
  return Number(r.rows[0]?.n ?? 0);
}

function slotDto(r: SlotRow, day: string): QuestSlotDto {
  const def = questDef(r.quest_id);
  const done = r.done_day !== null;
  return {
    slot: r.slot,
    id: r.quest_id as QuestId,
    label: def?.label ?? "Retired task",
    short: def?.short ?? "Retired task",
    hint: def?.hint ?? "",
    need: r.need,
    progress: Math.min(r.need, r.progress),
    xp: r.xp,
    done,
    carried: !done && r.issued_day < day,
  };
}

type UserRow = { xp: number; title: string | null; name_color: string | null; badge_frame: string | null; skin: string | null };

/** Locks the users row for key share (the lock order of this module); null for an unknown user. */
async function lockUser(tx: Tx, userId: string, mode: "share" | "update"): Promise<UserRow | null> {
  const r =
    mode === "update"
      ? await tx.execute<UserRow>(sql`select xp, title, name_color, badge_frame, skin from users where id = ${userId} for update`)
      : await tx.execute<UserRow>(sql`select xp, title, name_color, badge_frame, skin from users where id = ${userId} for key share`);
  return r.rows[0] ?? null;
}

/** Equipped ids that still exist and are still owned (a retired cosmetic reads as none). */
function equippedOf(u: UserRow, level: number, marks: number, granted: ReadonlySet<string>): EquippedCosmetics {
  const ok = (id: string | null, kind: WearableKind) =>
    id && cosmeticDef(id)?.kind === kind && cosmeticUnlocked(id, level, marks, granted) ? id : null;
  return { title: ok(u.title, "title"), color: ok(u.name_color, "color"), frame: ok(u.badge_frame, "frame"), skin: ok(u.skin, "skin") };
}

/**
 * GET /api/quests: the player's tasks for the UTC day of `now`. Read-only when the slots are already
 * on that day; otherwise the day's tasks are issued in a transaction (users row, then slots).
 */
export async function getQuests(db: Db, userId: string, now = new Date()): Promise<QuestsDto | null> {
  const day = questDay(now.getTime());
  const ur = await db.execute<UserRow>(sql`select xp, title, name_color, badge_frame, skin from users where id = ${userId}`);
  const user = ur.rows[0] ?? null;
  if (!user) return null;
  const cur = await db.execute<SlotRow>(sql`select ${SLOT_COLS} from quest_slots where user_id = ${userId} order by slot`);
  let rows = cur.rows.map(normRow).filter((r) => r.slot < QUEST.SLOTS);
  if (keptTasks(rows, day).some((v) => v === null)) {
    rows = await db.transaction(async (tx) => {
      if (!(await lockUser(tx, userId, "share"))) return [];
      return refreshSlots(tx, userId, day, await lockSlots(tx, userId));
    });
  }
  const xpToday = await questXpOn(db, userId, day);
  const marks = await questMarks(db, userId);
  const level = levelForXp(Number(user.xp));
  const granted = await grantedOf(db, userId);
  return {
    serverTime: now.getTime(),
    day,
    resetAt: questResetAt(now.getTime()),
    slots: rows.map((r) => slotDto(r, day)),
    rerollAvailable: !rows.some((r) => r.rerolled_day === day),
    xpToday,
    xpMax: QUEST.DAILY_XP_MAX,
    marks,
    level,
    equipped: equippedOf(user, level, marks, granted),
    granted: [...granted],
  };
}

export type QuestErr = "no_user" | "bad_slot" | "reroll_used" | "task_done" | "locked" | "bad_cosmetic";

export const QUEST_ERR: Readonly<Record<QuestErr, { status: number; message: string }>> = {
  no_user: { status: 403, message: "Register to get daily tasks." },
  bad_slot: { status: 400, message: "No such task." },
  reroll_used: { status: 409, message: "You already swapped a task today. New swap at 00:00 UTC." },
  task_done: { status: 409, message: "This task is already done." },
  locked: { status: 403, message: "You haven't unlocked that yet." },
  bad_cosmetic: { status: 400, message: "Unknown reward." },
};

export type QuestResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: QuestErr };

/**
 * POST /api/quests/reroll: replaces the open task in `slot` with rollQuest(user, day, slot, every
 * task on the board, salt 1) — progress starts over. One a UTC day for the player.
 */
export async function rerollQuest(db: Db, userId: string, slot: number, now = new Date()): Promise<QuestResult<{ id: QuestId }>> {
  if (!Number.isInteger(slot) || slot < 0 || slot >= QUEST.SLOTS) return { ok: false, code: "bad_slot" };
  const day = questDay(now.getTime());
  return db.transaction(async (tx) => {
    if (!(await lockUser(tx, userId, "share"))) return { ok: false, code: "no_user" } as const;
    const rows = await refreshSlots(tx, userId, day, await lockSlots(tx, userId));
    if (rows.some((r) => r.rerolled_day === day)) return { ok: false, code: "reroll_used" } as const;
    const target = rows.find((r) => r.slot === slot);
    if (!target) return { ok: false, code: "bad_slot" } as const;
    if (target.done_day !== null) return { ok: false, code: "task_done" } as const;
    const id = rollQuest(userId, day, slot, rows.map((r) => r.quest_id), 1);
    const def = questDef(id)!;
    await tx.execute(sql`
      update quest_slots set quest_id = ${def.id}, need = ${def.need}, xp = ${def.xp}, progress = 0,
        issued_day = ${day}::date, done_day = null, rerolled_day = ${day}::date, updated_at = now()
      where user_id = ${userId} and slot = ${slot}`);
    return { ok: true, id } as const;
  });
}

const COSMETIC_COL: Readonly<Record<WearableKind, string>> = { title: "title", color: "name_color", frame: "badge_frame", skin: "skin" };

/**
 * POST /api/quests/equip: wear cosmetic `id` of `kind`, or take it off (`id` null). The id must be
 * of that kind and unlocked (levelForXp(users.xp) or the player's task marks).
 */
export async function equipCosmetic(
  db: Db,
  userId: string,
  kind: WearableKind,
  id: string | null,
): Promise<QuestResult<{ equipped: EquippedCosmetics }>> {
  return db.transaction(async (tx) => {
    const user = await lockUser(tx, userId, "update");
    if (!user) return { ok: false, code: "no_user" } as const;
    const marks = await questMarks(tx, userId);
    const level = levelForXp(Number(user.xp));
    const granted = await grantedOf(tx, userId);
    if (id !== null) {
      const def = cosmeticDef(id);
      if (!def || def.kind !== kind) return { ok: false, code: "bad_cosmetic" } as const;
      if (!cosmeticUnlocked(id, level, marks, granted)) return { ok: false, code: "locked" } as const;
    }
    const col = sql.raw(COSMETIC_COL[kind]);
    await tx.execute(sql`update users set ${col} = ${id} where id = ${userId}`);
    const next: UserRow = {
      ...user,
      title: kind === "title" ? id : user.title,
      name_color: kind === "color" ? id : user.name_color,
      badge_frame: kind === "frame" ? id : user.badge_frame,
      skin: kind === "skin" ? id : user.skin,
    };
    return { ok: true, equipped: equippedOf(next, level, marks, granted) } as const;
  });
}

/** What advanceQuestsForExit paid: XP and the tasks this exit finished. */
export interface QuestExitResult {
  xp: number;
  completed: Array<{ slot: number; id: QuestId; xp: number }>;
}

/**
 * The exit hook (raids.ts applyExit, registered players, inside its transaction which already holds
 * the users row FOR UPDATE): refreshes the slots to the exit's UTC day, applies the report's facts
 * (applyQuestExit), writes the progress and one quest_log row per finished task. Returns the task
 * XP for the "quest" line of the XP receipt; the caller adds it to users.xp but not to xp_grind.
 * No slots yet (tasks never issued) → nothing.
 */
export async function advanceQuestsForExit(
  tx: Tx,
  userId: string,
  facts: QuestExitFacts,
  entryId: string,
  now: Date,
): Promise<QuestExitResult> {
  const none: QuestExitResult = { xp: 0, completed: [] };
  const locked = await lockSlots(tx, userId);
  if (locked.length === 0) return none;
  const day = questDay(now.getTime());
  const rows = await refreshSlots(tx, userId, day, locked);
  const open = rows.filter((r) => r.done_day === null && questDef(r.quest_id));
  if (open.length === 0) return none;
  const xpToday = await questXpOn(tx, userId, day);
  const res = applyQuestExit(
    open.map((r) => ({ slot: r.slot, id: r.quest_id as QuestId, need: r.need, xp: r.xp, progress: r.progress, done: false })),
    facts,
    xpToday,
  );
  const out: QuestExitResult = { xp: 0, completed: [] };
  for (let i = 0; i < res.slots.length; i++) {
    const s = res.slots[i]!;
    if (s.progress === open[i]!.progress && !s.done) continue;
    await tx.execute(sql`
      update quest_slots set progress = ${s.progress}, done_day = ${s.done ? sql`${day}::date` : sql`null`}, updated_at = now()
      where user_id = ${userId} and slot = ${s.slot}`);
  }
  for (const a of res.awards) {
    // (user, day, slot) is unique: a slot finishes at most once a UTC day, so this never pays twice.
    const ins = await tx.execute<{ xp: number }>(sql`
      insert into quest_log (user_id, day, slot, quest_id, xp, entry_id, at)
      values (${userId}, ${day}::date, ${a.slot}, ${a.id}, ${a.xp}, ${entryId}, ${now})
      on conflict (user_id, day, slot) do nothing
      returning xp`);
    if (ins.rows.length === 0) continue;
    out.xp += a.xp;
    out.completed.push(a);
  }
  return out;
}

/**
 * Equipped cosmetics of up to 100 registered players by nickname (leaderboard rows), plus the
 * Founder badge (Alpha Pass tier 10, owned = shown) and the Seeker badge (lib/seeker: the linked
 * wallet holds a Seeker Genesis Token). Players with nothing to show are left out;
 * ids are checked against the tables, not re-checked for unlocks (equipCosmetic did that, and
 * unlocks never go away).
 */
export async function cosmeticBadges(
  db: Db,
  nicknames: readonly string[],
): Promise<Record<string, Partial<EquippedCosmetics> & { badge?: string; seeker?: boolean }>> {
  const names = [...new Set(nicknames)].slice(0, 100);
  if (names.length === 0) return {};
  const r = await db.execute<{ nickname: string; title: string | null; name_color: string | null; badge_frame: string | null; founder: boolean; seeker: boolean }>(sql`
    select u.nickname, u.title, u.name_color, u.badge_frame,
      exists (select 1 from pass_unlocks p where p.user_id = u.id and p.reward_id = ${FOUNDER_BADGE}) as founder,
      ${SEEKER_BADGE_SQL} as seeker
    from users u
    where u.nickname in (${sql.join(names.map((n) => sql`${n}`), sql`, `)})`);
  const out: Record<string, Partial<EquippedCosmetics> & { badge?: string; seeker?: boolean }> = {};
  for (const u of r.rows) {
    const b: Partial<EquippedCosmetics> & { badge?: string; seeker?: boolean } = {};
    if (u.title && cosmeticDef(u.title)?.kind === "title") b.title = u.title;
    if (u.name_color && cosmeticDef(u.name_color)?.kind === "color") b.color = u.name_color;
    if (u.badge_frame && cosmeticDef(u.badge_frame)?.kind === "frame") b.frame = u.badge_frame;
    if (u.founder) b.badge = FOUNDER_BADGE;
    if (u.seeker) b.seeker = true;
    if (b.title || b.color || b.frame || b.badge || b.seeker) out[u.nickname] = b;
  }
  return out;
}
