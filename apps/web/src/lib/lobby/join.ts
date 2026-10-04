import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  PARTY,
  WORLD,
  isSlotKey,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
  type JoinTicket,
  type LoadoutEntry,
  type SlotKey,
  type WorldJoinParty,
  type WorldJoinResponse,
} from "@extract/shared";
import type { Db } from "../inventory/db";
import { MAX_LOADOUT_ENTRIES, getDraft, lockLoadout, saveDraft, unlockLoadout } from "../inventory/loadout";
import { RAID_USER_VOID_GRACE_MS, voidStaleForUser } from "../inventory/raids";
import { getStash } from "../inventory/stash";
import { isGuestPlayEnabled } from "../guest-play";
import { signJoinTicket } from "../join-ticket";
import { partyJoinPlan, savePartyDrop, type PartyJoinPlan } from "../social/party";
import { worldNow } from "../world/clock";
import type { WorldJoinErrorBody } from "./api-types";
import { LOADOUT_ERR_TEXT, draftFromLocked, pruneDraft, sameLoadout } from "./loadout-model";
import type { Caller } from "./route-helpers";

/** PUT /api/loadout/draft and POST /api/world/join bodies. Contents are checked at lock time. */
export const loadoutEntrySchema = z.object({
  key: z.string().refine(isSlotKey, "bad slot key") as unknown as z.ZodType<SlotKey>,
  itemId: z.string().uuid().optional(),
  def: z.string().min(1).max(32),
  qty: z.number().int().min(1).max(1000),
});
export const entriesSchema = z.array(loadoutEntrySchema).max(MAX_LOADOUT_ENTRIES);

export type JoinResult =
  | { ok: true; ticket: JoinTicket; loadoutId: string; entries: LoadoutEntry[]; pruned: boolean }
  | { ok: false; status: number; error: string; message: string; key?: string; matchId?: string };

/**
 * Locks the caller's loadout for the next raid and signs the join ticket (critique "Settlement
 * and loadout flow": the ticket carries only loadoutId). Guests drop with the free kit
 * (loadoutId ""). Registered users lock `entries` if given (also saved as the draft), else their
 * saved draft. The draft is first pruned against today's stash so gear that was sold, listed or
 * lost since the page saved it cannot block the Play button. An already-locked loadout that no
 * longer matches the draft (the player edited it after a cancelled search) is unlocked and
 * re-locked, so the raid always carries what the Loadout tab shows.
 * `world` (WORLD v6, worldJoin) puts the shard's matchId and the freshly minted entryId into the
 * signed ticket, plus the party's partyId / dropId / dropSize for a party member (party.ts).
 */
export async function lockAndIssueTicket(
  db: Db,
  c: Caller,
  entries: LoadoutEntry[] | undefined,
  world: { matchId: string; entryId: string; partyId?: string; dropId?: string; dropSize?: number },
): Promise<JoinResult> {
  if (c.kind === "anon") return { ok: false, status: 401, error: "unauthenticated", message: "Sign in first." };
  if (c.kind === "guest") {
    // A guest cookie sealed while guest play was on stays valid for its TTL: re-check the switch
    // here, or turning guest play off would not stop those sessions from joining (security audit).
    if (!isGuestPlayEnabled()) {
      return { ok: false, status: 403, error: "guest_play_disabled", message: "Guest play is off. Create an account to play." };
    }
    return {
      ok: true,
      ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId: "", ...world }),
      loadoutId: "",
      entries: [],
      pruned: false,
    };
  }
  const stash = await getStash(db, c.userId);
  if (!stash) return { ok: false, status: 401, error: "no_user", message: LOADOUT_ERR_TEXT.no_user };
  if (stash.active?.status === "in_raid") {
    return {
      ok: false,
      status: 409,
      error: "in_raid",
      message: "Your gear is still in a running raid. It comes back when that raid settles.",
      matchId: stash.active.matchId ?? undefined,
    };
  }
  // A locked loadout's gear is out of the stash right now; prune against stash + that gear.
  const lockedEntries = stash.active?.status === "locked" ? stash.active.entries : [];
  const view = {
    uniques: stash.uniques.map((u) => ({
      ...u,
      state: u.state === "in_raid" && u.loadoutId !== null && u.loadoutId === stash.active?.loadoutId ? "in_stash" : u.state,
    })),
    stacks: { ...stash.stacks },
  };
  for (const e of lockedEntries) if (!e.uid) view.stacks[e.def] = (view.stacks[e.def] ?? 0) + e.qty;

  const wanted = entries ?? (await getDraft(db, c.userId)) ?? [];
  const draft = pruneDraft(wanted, view);
  const pruned = draft.length !== wanted.length || !sameLoadout(draft, draftFromLockedLike(wanted));
  if (entries || pruned) await saveDraft(db, c.userId, draft);

  let lock = await lockLoadout(db, c.userId, draft);
  if (lock.ok && lock.reused && !sameLoadout(draft, lock.entries)) {
    const un = await unlockLoadout(db, c.userId);
    if (un.ok) lock = await lockLoadout(db, c.userId, draft);
  }
  if (!lock.ok) {
    const status = lock.code === "in_raid" || lock.code === "conflict" ? 409 : lock.code === "no_user" ? 401 : 400;
    return { ok: false, status, error: lock.code, message: LOADOUT_ERR_TEXT[lock.code], key: lock.key, matchId: lock.matchId };
  }
  return {
    ok: true,
    ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId: lock.loadoutId, ...world }),
    loadoutId: lock.loadoutId,
    entries: lock.loadoutId ? draftFromLocked(lock.entries) : [],
    pruned,
  };
}

/** Draft entries in the {key, uid, def, qty} shape sameLoadout compares against. */
function draftFromLockedLike(entries: readonly LoadoutEntry[]) {
  return entries.map((e) => ({ key: e.key, uid: e.itemId ?? "", def: e.def, qty: e.qty }));
}

// ============================================================================ WORLD v6 join

export type WorldJoinResult =
  | { ok: true; body: WorldJoinResponse }
  | { ok: false; status: number; body: WorldJoinErrorBody };

type ActiveEntryRow = {
  entry_id: string;
  match_id: string;
  loadout_id: string | null;
  raid_status: string | null;
  raid_cycle: number | null;
  room_id: string | null;
  ends_at: Date | string | null;
};

/**
 * POST /api/world/join (spec §4.7, D4/D5/D6): the lobby's PLAY. In order:
 * 1. anon → 401 `unauthenticated`.
 * 2. Lazy void of this user's stale shard (voidStaleForUser), so a crashed process never strands gear.
 * 3. An active entry on a running world row of the current cycle → a rejoin ticket for that same
 *    entry (`rejoin: true`; a lost raids/enter reply heals here, D6). Any other active entry → 409
 *    `in_raid` with `settlesAt` = its ends_at + RAID_USER_VOID_GRACE_MS (when the lazy void frees it).
 * 4. Not in the entry window → 409 `entry_closed` with `openAt` (this cycle's while resetting, else
 *    the next cycle's).
 * 5. No running world row for this cycle (raids/open has not landed yet) → 503 `world_starting`.
 * 6. WORLD.MAX_ENTRIES_PER_CYCLE entries of this user this cycle → 409 `entry_limit`.
 * 7. Party (lib/social/party.ts partyJoinPlan, registered users in a party of ≥ 2): the leader starts
 *    (or reuses) the party's drop for this map; a member follows the live drop (`opts.dropId`, else the
 *    party's newest) and is pinned to its shard while that runs. Loadout, risk and limits stay per player.
 * 8. lockAndIssueTicket with the shard's matchId, a fresh entryId and the party fields (the web's
 *    raids/enter makes it an entry only when the game server admits it); a new leader drop is saved.
 * Every body carries `serverTime` (= `now`, the world clock).
 */
export async function worldJoin(
  db: Db,
  c: Caller,
  entries?: LoadoutEntry[],
  now = worldNow(),
  opts: { dropId?: string } = {},
): Promise<WorldJoinResult> {
  const fail = (status: number, error: WorldJoinErrorBody["error"], message: string, extra: Partial<WorldJoinErrorBody> = {}) =>
    ({ ok: false, status, body: { error, message, serverTime: now, ...extra } }) as const;
  if (c.kind === "anon") return fail(401, "unauthenticated", "Sign in first.");
  const wc = worldCycleAt(now);

  await voidStaleForUser(db, c.userId, new Date(now));
  const act = await db.execute<ActiveEntryRow>(sql`
    select e.entry_id, e.match_id, e.loadout_id, r.status as raid_status, r.cycle_id as raid_cycle, r.room_id, r.ends_at
    from raid_entries e left join raids r on r.match_id = e.match_id
    where e.user_id = ${c.userId} and e.status = 'active'
    order by e.created_at desc limit 1`);
  const a = act.rows[0];
  if (a) {
    if (a.raid_status === "running" && Number(a.raid_cycle) === wc.cycle && a.room_id) {
      const loadoutId = a.loadout_id ?? "";
      return {
        ok: true,
        body: {
          ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId, matchId: a.match_id, entryId: a.entry_id }),
          roomId: a.room_id,
          matchId: a.match_id,
          cycle: wc.cycle,
          wipeAt: wc.wipeAt,
          entryClosesAt: wc.entryClosesAt,
          rejoin: true,
          serverTime: now,
          loadoutId,
          entries: loadoutId ? await lockedEntries(db, loadoutId) : [],
          pruned: false,
        },
      };
    }
    return fail(409, "in_raid", "Your last raid is still settling. Your gear comes back when it does.", {
      ...(a.ends_at ? { settlesAt: new Date(a.ends_at).getTime() + RAID_USER_VOID_GRACE_MS } : {}),
    });
  }

  const phase = worldPhase(wc, now);
  if (phase !== "open") {
    return fail(
      409,
      "entry_closed",
      phase === "resetting" ? "A new map is starting. Entry opens in a few seconds." : "Entry to this map is closed. The next map opens soon.",
      { openAt: phase === "resetting" ? wc.openAt : worldCycleOf(wc.cycle + 1).openAt },
    );
  }

  const cur = await db.execute<{ match_id: string; room_id: string }>(sql`
    select match_id, room_id from raids
    where kind = 'world' and cycle_id = ${wc.cycle} and status = 'running' and room_id is not null
    order by started_at desc limit 1`);
  let shard = cur.rows[0];
  if (!shard) return fail(503, "world_starting", "The map is starting up. Try again in a few seconds.", { retryInMs: 3000 });

  const cnt = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from raid_entries where cycle_id = ${wc.cycle} and user_id = ${c.userId}`);
  if (Number(cnt.rows[0]?.n ?? 0) >= WORLD.MAX_ENTRIES_PER_CYCLE) {
    return fail(
      409,
      "entry_limit",
      `You've dropped into this map ${WORLD.MAX_ENTRIES_PER_CYCLE} times. The next map opens soon.`,
      { openAt: worldCycleOf(wc.cycle + 1).openAt },
    );
  }

  let plan: PartyJoinPlan | null = c.kind === "user" ? await partyJoinPlan(db, c.userId, { cycle: wc.cycle, matchId: shard.match_id, now, dropId: opts.dropId }) : null;
  if (plan?.drop && !plan.leader && plan.drop.matchId !== shard.match_id) {
    // Follow the leader into their shard while it runs; otherwise drop on your own.
    const pin = await db.execute<{ match_id: string; room_id: string }>(sql`
      select match_id, room_id from raids
      where match_id = ${plan.drop.matchId} and kind = 'world' and cycle_id = ${wc.cycle} and status = 'running' and room_id is not null`);
    if (pin.rows[0]) shard = pin.rows[0];
    else plan = { ...plan, drop: null };
  }

  const r = await lockAndIssueTicket(db, c, entries, {
    matchId: shard.match_id,
    entryId: randomUUID(),
    // dropSize: the game server holds this many seats for the drop (not PARTY.MAX_SIZE).
    ...(plan ? { partyId: plan.partyId, ...(plan.drop ? { dropId: plan.drop.dropId, dropSize: dropSizeOf(plan.drop.members.length) } : {}) } : {}),
  });
  if (!r.ok) {
    const extra: Partial<WorldJoinErrorBody> = {};
    if (r.key) extra.key = r.key;
    if (r.error === "in_raid" && r.matchId) {
      const e = await db.execute<{ ends_at: Date | string }>(sql`select ends_at from raids where match_id = ${r.matchId}`);
      const endsAt = e.rows[0]?.ends_at;
      if (endsAt) extra.settlesAt = new Date(endsAt).getTime() + RAID_USER_VOID_GRACE_MS;
    }
    return fail(r.status, r.error as WorldJoinErrorBody["error"], r.message, extra);
  }
  if (plan?.drop && plan.isNew) await savePartyDrop(db, plan.drop);
  const party: WorldJoinParty | undefined = plan
    ? { partyId: plan.partyId, dropId: plan.drop?.dropId ?? null, dropExpiresAt: plan.drop?.expiresAt ?? null, leader: plan.leader }
    : undefined;
  return {
    ok: true,
    body: {
      ticket: r.ticket,
      roomId: shard.room_id,
      matchId: shard.match_id,
      cycle: wc.cycle,
      wipeAt: wc.wipeAt,
      entryClosesAt: wc.entryClosesAt,
      rejoin: false,
      serverTime: now,
      loadoutId: r.loadoutId,
      entries: r.entries,
      pruned: r.pruned,
      ...(party ? { party } : {}),
    },
  };
}

/** The entries of a loadout row in the lobby's LoadoutEntry shape ([] when missing). */
async function lockedEntries(db: Db, loadoutId: string): Promise<LoadoutEntry[]> {
  const r = await db.execute<{ entries: Array<{ key: string; uid: string; def: string; qty: number }> }>(
    sql`select entries from loadouts where id = ${loadoutId}`,
  );
  const e = r.rows[0]?.entries;
  return Array.isArray(e) ? draftFromLocked(e) : [];
}

/** Seats a party drop holds on its shard: its member count, within PARTY.MIN_SIZE..PARTY.MAX_SIZE. */
export function dropSizeOf(members: number): number {
  return Math.max(PARTY.MIN_SIZE, Math.min(PARTY.MAX_SIZE, Math.floor(members) || PARTY.MAX_SIZE));
}
