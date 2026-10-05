import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  PARTY,
  WORLD,
  cosmeticDef,
  isSlotKey,
  pickWorldShard,
  worldCycleAt,
  worldCycleOf,
  worldPhase,
  type JoinTicket,
  type LoadoutEntry,
  type PartyDropInfo,
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
import { claimPartyDrop, partyJoinPlan, type PartyJoinPlan } from "../social/party";
import { canFollowDrop } from "../social/rules";
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
  world: { matchId: string; entryId: string; partyId?: string; dropId?: string; dropSize?: number; tutorial?: boolean; skin?: string },
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

/** A running shard of the open cycle for the join's pick (humans = its active entries). */
type ShardChoice = { match_id: string; room_id: string; shard: number; humans: number };

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
 * 3. An active entry on a running world row whose map has not wiped yet (ends_at > now: the open
 *    cycle, or the closing previous one during the overlap) → a rejoin ticket for that same entry on
 *    its own shard (`rejoin: true`, with that shard's cycle, wipeAt and entryClosesAt; a lost
 *    raids/enter reply heals here, D6). Any other active entry → 409 `in_raid` with `settlesAt` = its
 *    ends_at + RAID_USER_VOID_GRACE_MS (when the lazy void frees it).
 *    `opts.rejoinOnly` (the battle screen's reconnect) stops here: no active entry → 409 `not_on_map`.
 * 4. The cycle is the open one (worldCycleAt: overlapping maps, so there is always one — no
 *    "entry closed, wait for the next map"); `entry_closed` only guards a clock at its very edge.
 * 5. Party (lib/social/party.ts partyJoinPlan, registered users in a party of ≥ 2): the first member
 *    to press PLAY, leader or not, starts the party's drop; every other member's PLAY in the window
 *    (`opts.dropId`, else the party's newest live drop) follows it to its own shard and cycle — also
 *    when that map has stopped taking entries meanwhile (the closing previous map; the game server
 *    admits a drop's later members there while the window runs). A drop whose map is gone, or an
 *    expired one, gives way to a fresh drop. Loadout, risk and limits stay per player.
 * 6. WORLD.MAX_ENTRIES_PER_CYCLE entries of this user on the join's cycle → 409 `entry_limit`.
 * 7. No followed drop: no running world row for the open cycle (raids/open has not landed yet) → 503
 *    `world_starting`; else pickWorldShard over the cycle's running shards by active entries — the
 *    fullest one with room for the join (1 seat, or the whole party for a new drop), so players are
 *    packed together; no room anywhere → the emptiest one, and the game server decides (it answers
 *    world_full and opens another shard when allowed). A new drop is claimed (claimPartyDrop, one live
 *    drop per party under the party row lock): when another member's drop won the race, follow it.
 * 8. lockAndIssueTicket with the shard's matchId, a fresh entryId and the party fields (the web's
 *    raids/enter makes it an entry only when the game server admits it).
 * Every body carries `serverTime` (= `now`, the world clock).
 */
export async function worldJoin(
  db: Db,
  c: Caller,
  entries?: LoadoutEntry[],
  now = worldNow(),
  opts: { dropId?: string; rejoinOnly?: boolean } = {},
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
    // Overlapping maps: the entry's own map may be the closing previous cycle; it runs until its wipe.
    const own = a.raid_cycle !== null ? worldCycleOf(Number(a.raid_cycle)) : null;
    if (a.raid_status === "running" && own && now < own.wipeAt && a.room_id) {
      const loadoutId = a.loadout_id ?? "";
      return {
        ok: true,
        body: {
          ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId, matchId: a.match_id, entryId: a.entry_id }),
          roomId: a.room_id,
          matchId: a.match_id,
          cycle: own.cycle,
          wipeAt: own.wipeAt,
          entryClosesAt: own.entryClosesAt,
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
  // The battle screen's automatic reconnect: only ever a rejoin, never a fresh entry (no loadout lock).
  if (opts.rejoinOnly) return fail(409, "not_on_map", "Your raider is no longer on the map.");

  // worldCycleAt is the cycle accepting entries, so this only trips on a clock at its very edge.
  if (worldPhase(wc, now) !== "open") {
    return fail(409, "entry_closed", "A new map is opening. Try again in a moment.", { openAt: worldCycleOf(wc.cycle + 1).openAt });
  }

  // The party plan first: a live drop pins the join to its own shard and cycle (even a closing map);
  // a new drop's shard is picked below, with room for the whole party.
  let plan: PartyJoinPlan | null =
    c.kind === "user"
      ? await partyJoinPlan(db, c.userId, { cycle: wc.cycle, now, dropId: opts.dropId, runs: async (d) => (await dropShard(db, d, now)) !== null })
      : null;
  let shard: ShardChoice | null = null;
  let cycle = wc;
  if (plan?.drop && !plan.isNew) {
    shard = await dropShard(db, plan.drop, now);
    if (shard) cycle = worldCycleOf(plan.drop.cycle);
    else plan = { ...plan, drop: null };
  }

  const limited = await entryLimited(db, c.userId, cycle.cycle);
  if (limited) return fail(409, "entry_limit", `You've dropped into this map ${WORLD.MAX_ENTRIES_PER_CYCLE} times. The next map opens soon.`, { openAt: worldCycleOf(wc.cycle + 1).openAt });

  if (!shard) {
    // The open cycle's running shards with their raiders (the newest row per shard index: a restart's
    // newer row supersedes the older one).
    const cur = await db.execute<{ match_id: string; room_id: string; shard: number | null; humans: number }>(sql`
      select distinct on (r.shard) r.match_id, r.room_id, r.shard,
        (select count(*)::int from raid_entries e where e.match_id = r.match_id and e.status = 'active') as humans
      from raids r
      where r.kind = 'world' and r.cycle_id = ${wc.cycle} and r.status = 'running' and r.room_id is not null
      order by r.shard, r.started_at desc`);
    const shards: ShardChoice[] = cur.rows.map((r) => ({ match_id: r.match_id, room_id: r.room_id, shard: Number(r.shard ?? 0), humans: Number(r.humans ?? 0) }));
    if (shards.length === 0) return fail(503, "world_starting", "The map is starting up. Try again in a few seconds.", { retryInMs: 3000 });
    const need = plan?.drop && plan.isNew ? dropSizeOf(plan.drop.members.length) : 1;
    shard = pickWorldShard(shards, need)!;
    if (plan?.drop && plan.isNew) {
      // One drop per party: under the party lock, a drop another member started meanwhile wins and
      // this join follows it instead.
      const claim = await claimPartyDrop(db, { ...plan.drop, matchId: shard.match_id }, plan.replaces);
      if (!claim) plan = { ...plan, drop: null, isNew: false };
      else if (claim.isNew) plan = { ...plan, drop: claim.drop };
      else {
        const other = canFollowDrop(claim.drop, c.userId.toLowerCase(), wc.cycle, now) ? await dropShard(db, claim.drop, now) : null;
        plan = { ...plan, drop: other ? claim.drop : null, isNew: false };
        if (other) {
          shard = other;
          cycle = worldCycleOf(claim.drop.cycle);
        }
      }
    }
  }

  const alpha = c.kind === "user" ? await alphaJoinExtras(db, c.userId, Boolean(plan?.drop)) : {};
  const r = await lockAndIssueTicket(db, c, entries, {
    matchId: shard.match_id,
    entryId: randomUUID(),
    ...alpha,
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
  // A drop this PLAY started stays when the ticket fails (a loadout error): the others still land
  // together, and the starter's next PLAY in the window follows it.
  const party: WorldJoinParty | undefined = plan
    ? { partyId: plan.partyId, dropId: plan.drop?.dropId ?? null, dropExpiresAt: plan.drop?.expiresAt ?? null, leader: plan.leader }
    : undefined;
  return {
    ok: true,
    body: {
      ticket: r.ticket,
      roomId: shard.room_id,
      matchId: shard.match_id,
      cycle: cycle.cycle,
      wipeAt: cycle.wipeAt,
      entryClosesAt: cycle.entryClosesAt,
      rejoin: false,
      serverTime: now,
      loadoutId: r.loadoutId,
      entries: r.entries,
      pruned: r.pruned,
      ...(party ? { party } : {}),
    },
  };
}

/**
 * Alpha extras of a registered join (signed into the ticket): `tutorial` for a player with no settled
 * exit yet who drops solo (a party drop lands next to the party instead), and the equipped skin when
 * the player owns it (pass_unlocks).
 */
async function alphaJoinExtras(db: Db, userId: string, inPartyDrop: boolean): Promise<{ tutorial?: boolean; skin?: string }> {
  const r = await db.execute<{ skin: string | null; owned: boolean; first: boolean }>(sql`
    select u.skin,
      exists (select 1 from pass_unlocks p where p.user_id = u.id and p.reward_id = u.skin) as owned,
      not exists (select 1 from raid_exits x where x.user_id = u.id) as first
    from users u where u.id = ${userId}`);
  const row = r.rows[0];
  if (!row) return {};
  const out: { tutorial?: boolean; skin?: string } = {};
  if (row.first && !inPartyDrop) out.tutorial = true;
  if (row.skin && row.owned && cosmeticDef(row.skin)?.kind === "skin") out.skin = row.skin;
  return out;
}

/** The entries of a loadout row in the lobby's LoadoutEntry shape ([] when missing). */
async function lockedEntries(db: Db, loadoutId: string): Promise<LoadoutEntry[]> {
  const r = await db.execute<{ entries: Array<{ key: string; uid: string; def: string; qty: number }> }>(
    sql`select entries from loadouts where id = ${loadoutId}`,
  );
  const e = r.rows[0]?.entries;
  return Array.isArray(e) ? draftFromLocked(e) : [];
}

/**
 * The running shard of a party drop (its own cycle: the open one, or the closing previous one before
 * its wipe), or null when that map is gone.
 */
async function dropShard(db: Db, d: PartyDropInfo, now: number): Promise<ShardChoice | null> {
  if (!d.matchId || now >= worldCycleOf(d.cycle).wipeAt) return null;
  const r = await db.execute<{ match_id: string; room_id: string; shard: number | null; humans: number }>(sql`
    select r.match_id, r.room_id, r.shard,
      (select count(*)::int from raid_entries e where e.match_id = r.match_id and e.status = 'active') as humans
    from raids r
    where r.match_id = ${d.matchId} and r.kind = 'world' and r.cycle_id = ${d.cycle} and r.status = 'running' and r.room_id is not null`);
  const x = r.rows[0];
  return x ? { match_id: x.match_id, room_id: x.room_id, shard: Number(x.shard ?? 0), humans: Number(x.humans ?? 0) } : null;
}

/** The user has used up WORLD.MAX_ENTRIES_PER_CYCLE entries on `cycle`. */
async function entryLimited(db: Db, userId: string, cycle: number): Promise<boolean> {
  const cnt = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from raid_entries where cycle_id = ${cycle} and user_id = ${userId}`);
  return Number(cnt.rows[0]?.n ?? 0) >= WORLD.MAX_ENTRIES_PER_CYCLE;
}

/** Seats a party drop holds on its shard: its member count, within PARTY.MIN_SIZE..PARTY.MAX_SIZE. */
export function dropSizeOf(members: number): number {
  return Math.max(PARTY.MIN_SIZE, Math.min(PARTY.MAX_SIZE, Math.floor(members) || PARTY.MAX_SIZE));
}
