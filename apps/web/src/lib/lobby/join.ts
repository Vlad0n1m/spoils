import { z } from "zod";
import { ROOMS, isSlotKey, type JoinTicket, type LoadoutEntry, type SlotKey } from "@extract/shared";
import type { Db } from "../inventory/db";
import { MAX_LOADOUT_ENTRIES, getDraft, lockLoadout, saveDraft, unlockLoadout } from "../inventory/loadout";
import { getStash } from "../inventory/stash";
import { signJoinTicket } from "../join-ticket";
import { LOADOUT_ERR_TEXT, draftFromLocked, pruneDraft, sameLoadout } from "./loadout-model";
import type { Caller } from "./route-helpers";

/** PUT /api/loadout/draft and POST /api/loadout/lock bodies. Contents are checked at lock time. */
export const loadoutEntrySchema = z.object({
  key: z.string().refine(isSlotKey, "bad slot key") as unknown as z.ZodType<SlotKey>,
  itemId: z.string().uuid().optional(),
  def: z.string().min(1).max(32),
  qty: z.number().int().min(1).max(1000),
});
export const entriesSchema = z.array(loadoutEntrySchema).max(MAX_LOADOUT_ENTRIES);

export type JoinResult =
  | { ok: true; ticket: JoinTicket; roomName: string; loadoutId: string; entries: LoadoutEntry[]; pruned: boolean }
  | { ok: false; status: number; error: string; message: string; key?: string; matchId?: string };

/**
 * Locks the caller's loadout for the next raid and signs the join ticket (critique "Settlement
 * and loadout flow": the ticket carries only loadoutId). Guests drop with the free kit
 * (loadoutId ""). Registered users lock `entries` if given (also saved as the draft), else their
 * saved draft. The draft is first pruned against today's stash so gear that was sold, listed or
 * lost since the page saved it cannot block the Play button. An already-locked loadout that no
 * longer matches the draft (the player edited it after a cancelled search) is unlocked and
 * re-locked, so the raid always carries what the Loadout tab shows.
 */
export async function lockAndIssueTicket(db: Db, c: Caller, entries?: LoadoutEntry[]): Promise<JoinResult> {
  if (c.kind === "anon") return { ok: false, status: 401, error: "unauthenticated", message: "Sign in first." };
  if (c.kind === "guest") {
    return {
      ok: true,
      ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId: "" }),
      roomName: ROOMS.MATCHMAKING,
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
    ticket: signJoinTicket({ userId: c.userId, nickname: c.nickname, loadoutId: lock.loadoutId }),
    roomName: ROOMS.MATCHMAKING,
    loadoutId: lock.loadoutId,
    entries: lock.loadoutId ? draftFromLocked(lock.entries) : [],
    pruned,
  };
}

/** Draft entries in the {key, uid, def, qty} shape sameLoadout compares against. */
function draftFromLockedLike(entries: readonly LoadoutEntry[]) {
  return entries.map((e) => ({ key: e.key, uid: e.itemId ?? "", def: e.def, qty: e.qty }));
}
