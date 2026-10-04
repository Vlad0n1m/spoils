/**
 * Alpha Pass on the web (docs/GAME_DESIGN.md §18e; rules in @extract/shared pass.ts). Tables of
 * migration 011: pass_ap_log, pass_weekly, pass_unlocks, bug_reports, alpha_survey, users.skin.
 * Everything here is PERMANENT: the alpha item wipe never touches these tables.
 *
 * - advancePassForExit: called once inside applyExit's transaction (raids.ts), right after the daily
 *   tasks, for registered players only. AP for the daily tasks this exit finished, weekly progress,
 *   the tester tasks a raid can complete (tutorial, party, phone) and the invite reward. Everything
 *   comes from the settled report and the DB, never from the client.
 * - getPass (GET /api/pass): AP, tiers, weekly tasks (issued at the first look of a week), tester tasks.
 * - claimPassTier: a reached tier's cosmetic → pass_unlocks (source "pass").
 * - submitBugReport / reviewBugReport (admin): an accepted report completes the "bug" tester task.
 * - submitSurvey: the in-menu survey completes the "survey" tester task.
 * - grantAlphaTrophies (admin): ALPHA_TROPHY to the top ranks of every all-time board.
 * AP awards are idempotent: pass_ap_log is unique on (user, source, task, period).
 * Lock order in writing transactions: the users row (applyExit holds it FOR UPDATE), then
 * pass_weekly rows — the same order as lib/quests.
 */
import { sql } from "drizzle-orm";
import {
  ALPHA_TROPHY,
  INVITE_REWARD,
  PASS,
  PASS_TIERS,
  TESTER_TASKS,
  applyWeeklyExit,
  cosmeticDef,
  itemDef,
  nextPassTier,
  parseSurvey,
  passTierOf,
  passWeek,
  passWeekResetAt,
  questDay,
  rollWeeklyTasks,
  testerDoneByExit,
  testerDef,
  weeklyDef,
  type PassDto,
  type PassExitFacts,
  type PlayerExitReport,
  type QuestAward,
  type TesterId,
  type WeeklyId,
  type WeeklySlotState,
} from "@extract/shared";
import type { Db, Tx } from "../inventory/db";
import { leaderboard } from "../world/leaderboards";

type Q = Pick<Db, "execute"> | Pick<Tx, "execute">;

type WeeklyRow = { slot: number; week: string; quest_id: string; need: number; progress: number; done_at: Date | string | null };

const WEEKLY_COLS = sql`slot, week::text as week, quest_id, need, progress, done_at`;

function normWeekly(r: WeeklyRow): WeeklyRow {
  return { ...r, slot: Number(r.slot), need: Number(r.need), progress: Number(r.progress) };
}

/** Total AP of a player. */
export async function passAp(q: Q, userId: string): Promise<number> {
  const r = await q.execute<{ ap: number }>(sql`select coalesce(sum(ap), 0)::int as ap from pass_ap_log where user_id = ${userId}`);
  return Number(r.rows[0]?.ap ?? 0);
}

/** Granted cosmetic ids the player owns (pass_unlocks). */
export async function grantedOf(q: Q, userId: string): Promise<Set<string>> {
  const r = await q.execute<{ reward_id: string }>(sql`select reward_id from pass_unlocks where user_id = ${userId}`);
  return new Set(r.rows.map((x) => x.reward_id).filter((id) => Boolean(cosmeticDef(id)?.grant)));
}

/** One AP award; false when it was already paid (same user, source, task, period). */
async function award(q: Q, userId: string, source: "daily" | "weekly" | "tester", task: string, period: string, ap: number, ref: string | null, now: Date): Promise<boolean> {
  if (!(ap > 0)) return false;
  const r = await q.execute(sql`
    insert into pass_ap_log (user_id, source, task, period, ap, ref, at)
    values (${userId}, ${source}, ${task}, ${period}, ${ap}, ${ref}, ${now})
    on conflict (user_id, source, task, period) do nothing
    returning id`);
  return r.rows.length > 0;
}

/** Completes tester task `id` once (AP from TESTER_TASKS). */
export async function completeTester(q: Q, userId: string, id: TesterId, ref: string | null, now = new Date()): Promise<boolean> {
  const def = testerDef(id);
  if (!def) return false;
  return award(q, userId, "tester", id, "once", def.ap, ref, now);
}

/**
 * The player's weekly slots on `week`, locked: a missing slot or a slot of an earlier week gets the
 * week's roll (rollWeeklyTasks, deterministic per user and week) with progress 0.
 */
async function weeklySlots(tx: Tx, userId: string, week: string): Promise<WeeklyRow[]> {
  const cur = await tx.execute<WeeklyRow>(sql`select ${WEEKLY_COLS} from pass_weekly where user_id = ${userId} order by slot for update`);
  const rows = cur.rows.map(normWeekly);
  const fresh = rows.length === PASS.WEEKLY_SLOTS && rows.every((r) => r.week === week && weeklyDef(r.quest_id));
  if (fresh) return rows;
  const ids = rollWeeklyTasks(userId, week);
  for (let s = 0; s < PASS.WEEKLY_SLOTS; s++) {
    const have = rows.find((r) => r.slot === s);
    if (have && have.week === week && weeklyDef(have.quest_id)) continue;
    const def = weeklyDef(ids[s])!;
    await tx.execute(sql`
      insert into pass_weekly (user_id, slot, week, quest_id, need, progress, done_at, updated_at)
      values (${userId}, ${s}, ${week}::date, ${def.id}, ${def.need}, 0, null, now())
      on conflict (user_id, slot) do update set week = excluded.week, quest_id = excluded.quest_id,
        need = excluded.need, progress = 0, done_at = null, updated_at = now()`);
  }
  const again = await tx.execute<WeeklyRow>(sql`select ${WEEKLY_COLS} from pass_weekly where user_id = ${userId} order by slot`);
  return again.rows.map(normWeekly);
}

/** What raids.ts hands the pass from a settled exit (registered players only). */
export interface PassExitInput {
  report: PlayerExitReport;
  onMapMs: number;
  npcKills: number;
  guardKills: number;
  bossKills: number;
  /** Daily tasks this exit finished (advanceQuestsForExit). */
  daily: readonly QuestAward[];
}

export interface PassExitResult {
  ap: number;
  weeklyDone: WeeklyId[];
  tester: TesterId[];
}

/** The PassExitFacts of a settled report (party from party_drops of this match). */
export async function passFactsOf(q: Q, userId: string, i: PassExitInput): Promise<PassExitFacts> {
  const r = i.report;
  const epic = i.report.exit === "extract" && r.extracted.some((s) => Boolean(s.uid) && itemDef(s.def)?.unique === true && s.rarity >= 2);
  const p = await q.execute<{ party: boolean }>(sql`
    select exists (
      select 1 from party_drops
      where match_id = ${r.matchId}::uuid and members ? ${userId} and jsonb_array_length(members) >= 2
    ) as party`);
  return {
    exit: r.exit,
    onMapMs: i.onMapMs,
    containers: Number(r.stats?.containersSearched ?? 0),
    bodies: Number(r.stats?.corpsesSearched ?? 0),
    marauders: Math.max(0, i.npcKills - i.guardKills),
    guards: i.guardKills,
    bosses: i.bossKills,
    epicExtracted: epic,
    party: Boolean(p.rows[0]?.party),
    touch: r.touch === true,
  };
}

/**
 * The exit hook (raids.ts applyExit, inside its transaction, after advanceQuestsForExit). Writes AP
 * rows (idempotent), weekly progress and, when this player is someone's invited friend reaching
 * PASS.INVITE_RAIDS settled raids, that inviter's invite reward. Pays no XP, CR or items.
 */
export async function advancePassForExit(tx: Tx, userId: string, input: PassExitInput, entryId: string, now: Date): Promise<PassExitResult> {
  const out: PassExitResult = { ap: 0, weeklyDone: [], tester: [] };
  const day = questDay(now.getTime());
  for (const d of input.daily) {
    if (await award(tx, userId, "daily", `d${d.slot}`, day, PASS.AP_DAILY, entryId, now)) out.ap += PASS.AP_DAILY;
  }
  const facts = await passFactsOf(tx, userId, input);

  const week = passWeek(now.getTime());
  const rows = await weeklySlots(tx, userId, week);
  const states: WeeklySlotState[] = rows.map((r) => ({
    slot: r.slot,
    id: r.quest_id as WeeklyId,
    need: r.need,
    progress: r.progress,
    done: r.done_at !== null,
  }));
  const res = applyWeeklyExit(states, facts);
  for (let i = 0; i < res.slots.length; i++) {
    const s = res.slots[i]!;
    const was = states[i]!;
    if (s.progress === was.progress && s.done === was.done) continue;
    await tx.execute(sql`
      update pass_weekly set progress = ${s.progress}, done_at = ${s.done ? now : null}, updated_at = now()
      where user_id = ${userId} and slot = ${s.slot}`);
  }
  for (const f of res.finished) {
    if (await award(tx, userId, "weekly", `w${f.slot}:${f.id}`, week, PASS.AP_WEEKLY, entryId, now)) {
      out.ap += PASS.AP_WEEKLY;
      out.weeklyDone.push(f.id);
    }
  }

  for (const t of testerDoneByExit(facts)) {
    if (await completeTester(tx, userId, t, entryId, now)) {
      out.ap += testerDef(t)!.ap;
      out.tester.push(t);
    }
  }

  await grantInviteRewards(tx, userId, now);
  return out;
}

/**
 * Invite reward: once `userId` has PASS.INVITE_RAIDS settled raids, every accepted friend who sent
 * them the friend request (requested_by) and dropped with them in a party (party_drops with both)
 * gets INVITE_REWARD. Idempotent (pass_unlocks primary key).
 */
export async function grantInviteRewards(q: Q, userId: string, now = new Date()): Promise<string[]> {
  const n = await q.execute<{ n: number }>(sql`
    select count(*)::int as n from raid_exits where user_id = ${userId} and not guest`);
  if (Number(n.rows[0]?.n ?? 0) < PASS.INVITE_RAIDS) return [];
  const r = await q.execute<{ inviter: string }>(sql`
    insert into pass_unlocks (user_id, reward_id, source, at)
    select f.requested_by, ${INVITE_REWARD}, 'invite', ${now}
    from friendships f
    where f.status = 'accepted' and (f.user_lo = ${userId} or f.user_hi = ${userId}) and f.requested_by <> ${userId}
      and exists (
        select 1 from party_drops d
        where d.members ? ${userId} and d.members ? (f.requested_by::text)
      )
    on conflict (user_id, reward_id) do nothing
    returning user_id as inviter`);
  return r.rows.map((x) => x.inviter);
}

// ---------------------------------------------------------------- menu

/** GET /api/pass. Issues the week's tasks in a short transaction on the first look of a week. */
export async function getPass(db: Db, userId: string, now = new Date()): Promise<PassDto | null> {
  const u = await db.execute<{ skin: string | null }>(sql`select skin from users where id = ${userId}`);
  if (!u.rows[0]) return null;
  const week = passWeek(now.getTime());
  const weekly = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from users where id = ${userId} for key share`);
    return weeklySlots(tx, userId, week);
  });
  const ap = await passAp(db, userId);
  const owned = await grantedOf(db, userId);
  const log = await db.execute<{ source: string; task: string; period: string }>(sql`
    select source, task, period from pass_ap_log where user_id = ${userId} and (source = 'tester' or (source = 'daily' and period = ${questDay(now.getTime())}))`);
  const testerDone = new Set(log.rows.filter((x) => x.source === "tester").map((x) => x.task));
  const dailyToday = log.rows.filter((x) => x.source === "daily").length;
  const pend = await db.execute<{ n: number }>(sql`select count(*)::int as n from bug_reports where user_id = ${userId} and status = 'open'`);
  const pendingBug = Number(pend.rows[0]?.n ?? 0) > 0;
  const tier = passTierOf(ap);
  const next = nextPassTier(ap);
  const skin = u.rows[0].skin && cosmeticDef(u.rows[0].skin)?.kind === "skin" && owned.has(u.rows[0].skin) ? u.rows[0].skin : null;
  return {
    serverTime: now.getTime(),
    ap,
    tier,
    tiers: PASS_TIERS.map((t) => {
      const d = cosmeticDef(t.reward)!;
      return { tier: t.tier, ap: t.ap, reward: t.reward, name: d.name, kind: d.kind, reached: ap >= t.ap, claimed: owned.has(t.reward) };
    }),
    next: next ? { tier: next.tier, ap: next.ap, reward: next.reward, name: cosmeticDef(next.reward)!.name } : null,
    daily: { apEach: PASS.AP_DAILY, doneToday: dailyToday, max: 3 },
    weekly: {
      week,
      resetAt: passWeekResetAt(now.getTime()),
      apEach: PASS.AP_WEEKLY,
      slots: weekly.map((r) => {
        const d = weeklyDef(r.quest_id)!;
        return { slot: r.slot, id: d.id, label: d.label, short: d.short, hint: d.hint, need: r.need, progress: Math.min(r.need, r.progress), done: r.done_at !== null };
      }),
    },
    tester: TESTER_TASKS.map((t) => ({
      id: t.id,
      label: t.label,
      hint: t.hint,
      ap: t.ap,
      done: testerDone.has(t.id),
      ...(t.id === "bug" && !testerDone.has("bug") && pendingBug ? { pending: true } : {}),
    })),
    owned: [...owned],
    skin,
    permanent: true,
  };
}

export type PassErr = "no_user" | "bad_tier" | "not_reached" | "bug_short" | "bug_long" | "bug_limit" | "survey_bad" | "survey_done";

export const PASS_ERR: Readonly<Record<PassErr, { status: number; message: string }>> = {
  no_user: { status: 403, message: "Register to use the Alpha Pass." },
  bad_tier: { status: 400, message: "No such tier." },
  not_reached: { status: 409, message: "You haven't reached that tier yet." },
  bug_short: { status: 400, message: `Describe the bug in at least ${PASS.BUG_MIN} characters.` },
  bug_long: { status: 400, message: `Keep it under ${PASS.BUG_MAX} characters.` },
  bug_limit: { status: 429, message: `You have ${PASS.BUG_OPEN_MAX} reports waiting for review. We'll get to them soon.` },
  survey_bad: { status: 400, message: "Answer every question." },
  survey_done: { status: 409, message: "You've already answered the survey. Thanks!" },
};

export type PassResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: PassErr };

/** POST /api/pass/claim: the reward of a reached tier becomes the player's for good. */
export async function claimPassTier(db: Db, userId: string, tier: number, now = new Date()): Promise<PassResult<{ reward: string }>> {
  const t = PASS_TIERS.find((x) => x.tier === tier);
  if (!t) return { ok: false, code: "bad_tier" };
  return db.transaction(async (tx) => {
    const u = await tx.execute(sql`select 1 from users where id = ${userId} for key share`);
    if (u.rows.length === 0) return { ok: false, code: "no_user" } as const;
    if ((await passAp(tx, userId)) < t.ap) return { ok: false, code: "not_reached" } as const;
    await tx.execute(sql`
      insert into pass_unlocks (user_id, reward_id, source, at) values (${userId}, ${t.reward}, 'pass', ${now})
      on conflict (user_id, reward_id) do nothing`);
    return { ok: true, reward: t.reward } as const;
  });
}

/** POST /api/pass/bug: a report for review (open until an admin accepts or rejects it). */
export async function submitBugReport(db: Db, userId: string, text: string, context: string | null, now = new Date()): Promise<PassResult<{ id: number }>> {
  const body = text.trim();
  if (body.length < PASS.BUG_MIN) return { ok: false, code: "bug_short" };
  if (body.length > PASS.BUG_MAX) return { ok: false, code: "bug_long" };
  return db.transaction(async (tx) => {
    const u = await tx.execute(sql`select 1 from users where id = ${userId} for update`);
    if (u.rows.length === 0) return { ok: false, code: "no_user" } as const;
    const open = await tx.execute<{ n: number }>(sql`select count(*)::int as n from bug_reports where user_id = ${userId} and status = 'open'`);
    if (Number(open.rows[0]?.n ?? 0) >= PASS.BUG_OPEN_MAX) return { ok: false, code: "bug_limit" } as const;
    const r = await tx.execute<{ id: number }>(sql`
      insert into bug_reports (user_id, text, context, status, created_at)
      values (${userId}, ${body}, ${context ? context.slice(0, 200) : null}, 'open', ${now}) returning id`);
    return { ok: true, id: Number(r.rows[0]!.id) } as const;
  });
}

/** POST /api/pass/survey: stores the answers once and completes the survey task. */
export async function submitSurvey(db: Db, userId: string, raw: unknown, now = new Date()): Promise<PassResult> {
  const answers = parseSurvey(raw);
  if (!answers) return { ok: false, code: "survey_bad" };
  return db.transaction(async (tx) => {
    const u = await tx.execute(sql`select 1 from users where id = ${userId} for key share`);
    if (u.rows.length === 0) return { ok: false, code: "no_user" } as const;
    const ins = await tx.execute(sql`
      insert into alpha_survey (user_id, answers, at) values (${userId}, ${JSON.stringify(answers)}::jsonb, ${now})
      on conflict (user_id) do nothing returning user_id`);
    if (ins.rows.length === 0) return { ok: false, code: "survey_done" } as const;
    await completeTester(tx, userId, "survey", "survey", now);
    return { ok: true } as const;
  });
}

// ---------------------------------------------------------------- admin

export interface BugReportRow {
  id: number;
  nickname: string;
  text: string;
  context: string | null;
  status: "open" | "accepted" | "rejected";
  createdAt: number;
}

export async function listBugReports(db: Pick<Db, "execute">, status: "open" | "all" = "open", limit = 100): Promise<BugReportRow[]> {
  const r = await db.execute<{ id: number; nickname: string; text: string; context: string | null; status: BugReportRow["status"]; created_at: Date | string }>(sql`
    select b.id, u.nickname, b.text, b.context, b.status, b.created_at
    from bug_reports b join users u on u.id = b.user_id
    where ${status === "open" ? sql`b.status = 'open'` : sql`true`}
    order by b.created_at desc limit ${Math.max(1, Math.min(500, limit))}`);
  return r.rows.map((x) => ({ id: Number(x.id), nickname: x.nickname, text: x.text, context: x.context, status: x.status, createdAt: new Date(x.created_at).getTime() }));
}

/**
 * An admin accepts or rejects an open report (audited). Accepting completes the reporter's "bug"
 * tester task (once per player, whatever the number of accepted reports).
 */
export async function reviewBugReport(
  db: Db,
  admin: { id: string; nickname: string },
  id: number,
  accept: boolean,
  now = new Date(),
): Promise<{ ok: true; apGranted: boolean } | { ok: false; code: "not_found" | "reviewed" }> {
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ user_id: string; status: string }>(sql`select user_id, status from bug_reports where id = ${id} for update`);
    const row = r.rows[0];
    if (!row) return { ok: false, code: "not_found" } as const;
    if (row.status !== "open") return { ok: false, code: "reviewed" } as const;
    const status = accept ? "accepted" : "rejected";
    await tx.execute(sql`update bug_reports set status = ${status}, reviewed_at = ${now}, reviewed_by = ${admin.id} where id = ${id}`);
    const apGranted = accept ? await completeTester(tx, row.user_id, "bug", `bug:${id}`, now) : false;
    await tx.execute(sql`
      insert into admin_audit (admin_id, admin_nickname, action, target, old_value, new_value, note, at)
      values (${admin.id}, ${admin.nickname}, 'bug_review', ${String(id)}, '"open"'::jsonb, ${JSON.stringify(status)}::jsonb, null, ${now})`);
    return { ok: true, apGranted } as const;
  });
}

/**
 * The alpha trophy (ALPHA_TROPHY): the players ranked ≤ top (ties included) on each all-time board
 * get the trophy title. Run by an admin at the end of the alpha; safe to run again (idempotent).
 */
export async function grantAlphaTrophies(db: Db, admin: { id: string; nickname: string }, now = new Date()): Promise<{ granted: string[]; ranked: string[] }> {
  const nicks = new Set<string>();
  for (const b of ALPHA_TROPHY.boards) {
    const lb = await leaderboard(db, b, "all", now.getTime());
    for (const row of lb.rows) if (row.rank <= ALPHA_TROPHY.top) nicks.add(row.nickname);
  }
  const ranked = [...nicks];
  if (ranked.length === 0) return { granted: [], ranked };
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ nickname: string }>(sql`
      with ins as (
        insert into pass_unlocks (user_id, reward_id, source, at)
        select id, ${ALPHA_TROPHY.reward}, 'trophy', ${now} from users
        where nickname in (${sql.join(ranked.map((n) => sql`${n}`), sql`, `)})
        on conflict (user_id, reward_id) do nothing
        returning user_id
      )
      select u.nickname from ins join users u on u.id = ins.user_id`);
    const granted = r.rows.map((x) => x.nickname).sort();
    await tx.execute(sql`
      insert into admin_audit (admin_id, admin_nickname, action, target, old_value, new_value, note, at)
      values (${admin.id}, ${admin.nickname}, 'alpha_trophy', ${ALPHA_TROPHY.reward}, null, ${JSON.stringify(granted)}::jsonb,
        ${`top ${ALPHA_TROPHY.top} of ${ALPHA_TROPHY.boards.join(", ")} (all time)`}, ${now})`);
    return { granted, ranked };
  });
}
