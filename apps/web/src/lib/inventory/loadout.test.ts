/**
 * Loadout lock guards (security audit) against the isolated `extract_test` database.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/inventory/loadout.test.ts
 */
import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { items, stashStacks } from "../../db/schema";
import { lockLoadout, unlockLoadout } from "./loadout";
import { GS_EXIT_RETRY_WINDOW_MS, RAID_USER_VOID_GRACE_MS, RAID_VOID_GRACE_MS } from "./raids";
import { addStack } from "./transition";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "./test-db";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const stateOf = async (id: string) => (await db.select().from(items).where(eq(items.id, id)))[0]!;

describe("lockLoadout moves only the rows of unique entries", () => {
  test("an itemId on a bandage entry never moves that item (a listed rifle stays listed)", async () => {
    const u = await makeUser(db);
    const rifle = await makeItem(db, { def: "rifle", ownerId: u, state: "listed" });
    await db.transaction((tx) => addStack(tx, u, "bandage", 3));
    const r = await lockLoadout(db, u, [{ key: "p0", def: "bandage", qty: 1, itemId: rifle }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    const it = await stateOf(rifle);
    assert.deepEqual([it.state, it.loadoutId], ["listed", null], "the listed item was not touched");
    const st = await db.select().from(stashStacks).where(eq(stashStacks.userId, u));
    assert.equal(st.find((s) => s.defId === "bandage")?.qty, 2, "only the bandage left the stash");
    assert.deepEqual(await unlockLoadout(db, u), { ok: true, unlocked: true });
    assert.equal((await stateOf(rifle)).state, "listed");
  });

  test("a unique entry still locks its own in_stash row", async () => {
    const u = await makeUser(db);
    const rifle = await makeItem(db, { def: "rifle", ownerId: u });
    const r = await lockLoadout(db, u, [{ key: "w1", def: "rifle", qty: 1, itemId: rifle }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal((await stateOf(rifle)).state, "in_raid");
  });
});

test("the void graces outlast the game server's exit retry window (security audit: void vs late exits)", () => {
  assert.ok(RAID_USER_VOID_GRACE_MS > GS_EXIT_RETRY_WINDOW_MS);
  assert.ok(RAID_VOID_GRACE_MS > RAID_USER_VOID_GRACE_MS);
});
