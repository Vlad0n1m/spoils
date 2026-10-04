/**
 * On-chain payloads: canonical match hash, event builders and the payload → instruction step.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/events.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { MatchEndReport, SettledItem, WorldEventReport } from "@extract/shared";
import {
  NO_KILLER,
  RARE_EXTRACT_MIN_RARITY,
  bossKillEvent,
  canonicalJson,
  itemDefHash,
  matchEvent,
  matchHashHex,
  rareExtractEvent,
  rareJunk,
  saltedHash,
  toRecordArgs,
  type BossKillPayload,
  type MatchPayload,
} from "./events";
import { worldEventReportSchema } from "../inventory/report-schemas";

const UID = "7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f";
const SALT = "test-salt";
const sha = (s: string) => createHash("sha256").update(s).digest();

function report(over: Partial<MatchEndReport> = {}): MatchEndReport {
  return {
    matchId: "11111111-2222-4333-8444-555555555555",
    mapId: "steppe",
    matchSeed: 42,
    startedAt: 1_000,
    endedAt: 2_000,
    participants: [
      { userId: UID, nickname: "ann", isBot: false, exitType: "extract", kills: 1 },
      { userId: "guest:bob", nickname: "bob", isBot: false, exitType: "mia", kills: 0 },
      { userId: "u3", nickname: "cy", isBot: false, exitType: "dead", kills: 0 },
      { userId: null, nickname: "bot", isBot: true, exitType: "mia", kills: 0 },
    ],
    leftOnMap: [],
    minted: [],
    cycleId: 640_001,
    shard: 1,
    entries: ["e1", "e2"],
    ...over,
  };
}

const junk = (def: string, qty = 1): SettledItem => ({ uid: "", def, qty, rarity: 0, dur: 100 });

describe("canonical JSON and hashes", () => {
  test("keys are sorted at every depth, undefined dropped, arrays keep their order", () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } }), '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
    assert.equal(canonicalJson([undefined, null, "s"]), '[null,null,"s"]');
  });

  test("the match hash ignores key order but not content", () => {
    const r = report();
    const shuffled = Object.fromEntries(Object.entries(r).reverse()) as unknown as MatchEndReport;
    assert.equal(matchHashHex(shuffled), matchHashHex(r));
    assert.equal(matchHashHex(r), sha(canonicalJson(r)).toString("hex"));
    assert.notEqual(matchHashHex(report({ endedAt: 2_001 })), matchHashHex(r));
  });

  test("user hashes are salted; item defs are plain sha256", () => {
    assert.deepEqual(saltedHash(SALT, `user:${UID}`), sha(`${SALT}:user:${UID}`));
    assert.notDeepEqual(saltedHash("other", `user:${UID}`), saltedHash(SALT, `user:${UID}`));
    assert.deepEqual(itemDefHash("rifle"), sha("rifle"));
  });
});

describe("event builders", () => {
  test("match: live world shards only; humans and MIA without bots", () => {
    const e = matchEvent(report(), "live")!;
    assert.equal(e.kind, "match");
    assert.equal(e.dedupeKey, "match:11111111-2222-4333-8444-555555555555");
    assert.deepEqual(e.payload, {
      matchId: "11111111-2222-4333-8444-555555555555",
      cycleId: 640_001,
      shard: 1,
      matchHash: matchHashHex(report()),
      humans: 3,
      mia: 1,
    });
    assert.equal(matchEvent(report(), "demo"), null);
    assert.equal(matchEvent(report({ cycleId: undefined }), "live"), null, "pre-v6 report");
  });

  test("boss kill: registered killer by user id, a guest by nickname", () => {
    const ev: WorldEventReport = { matchId: "m1", cycleId: 9, kind: "boss_killed", boss: "warden", by: "ann", atMs: 5 };
    assert.deepEqual(bossKillEvent(ev, UID), {
      kind: "boss_kill",
      dedupeKey: "boss:m1",
      payload: { matchId: "m1", cycleId: 9, boss: "warden", killer: `user:${UID}` },
    });
    assert.equal((bossKillEvent(ev, null)!.payload as BossKillPayload).killer, "guest:ann");
    assert.equal((bossKillEvent({ ...ev, by: "" }, null)!.payload as BossKillPayload).killer, NO_KILLER, "no raider killed it");
    assert.equal(bossKillEvent({ ...ev, boss: "dragon" as never }, null), null);
  });

  test("the world/event report carries the registered killer's user id (uuid only, optional)", () => {
    const base = { matchId: UID, cycleId: 9, kind: "boss_killed", boss: "warden", by: "ann", atMs: 5 };
    assert.equal(worldEventReportSchema.safeParse(base).success, true, "older game server");
    assert.equal(worldEventReportSchema.safeParse({ ...base, byUserId: UID }).success, true);
    assert.equal(worldEventReportSchema.safeParse({ ...base, byUserId: "ann" }).success, false);
  });

  test("rare junk: epic and legendary defs, one line per def, dog tags never", () => {
    assert.equal(RARE_EXTRACT_MIN_RARITY, 2);
    const got = rareJunk([junk("junk_gpu"), junk("junk_apple", 5), junk("junk_hdd", 2), junk("junk_gpu"), junk("junk_dogtag"), junk("junk_fuel")]);
    assert.deepEqual(got, [
      { def: "junk_gpu", rarity: 3, qty: 2 },
      { def: "junk_hdd", rarity: 2, qty: 2 },
    ]);
    const e = rareExtractEvent({ entryId: "e1", matchId: "m1", cycleId: 9, ownerId: UID }, { itemId: null, ...got[0]! });
    assert.equal(e.dedupeKey, "rare:e1:junk_gpu");
    assert.equal(rareExtractEvent({ entryId: "e1", matchId: "m1", cycleId: 9, ownerId: UID }, { itemId: "i9", def: "rifle", rarity: 2, qty: 1 }).dedupeKey, "rare:e1:i9");
  });
});

describe("payload → instruction arguments", () => {
  test("match", () => {
    const e = matchEvent(report(), "live")!;
    const a = toRecordArgs(e.kind, e.payload, SALT);
    assert.equal(a.kind, "match");
    if (a.kind !== "match") return;
    assert.equal(a.cycleId, 640_001n);
    assert.equal(a.shard, 1);
    assert.equal(Buffer.from(a.matchHash).toString("hex"), (e.payload as MatchPayload).matchHash);
    assert.deepEqual([a.humans, a.mia], [3, 1]);
  });

  test("boss kill and rare extract carry only salted hashes, never the raw ids", () => {
    const b = toRecordArgs("boss_kill", { matchId: "m1", cycleId: 9, boss: "commander", killer: `user:${UID}` }, SALT);
    assert.equal(b.kind, "boss_kill");
    if (b.kind === "boss_kill") {
      assert.equal(b.bossKind, 1, "BOSS_KINDS index");
      assert.deepEqual(Buffer.from(b.killerHash), sha(`${SALT}:boss_kill:user:${UID}`));
    }
    const r = toRecordArgs("rare_extract", { entryId: "e", matchId: "m", cycleId: 9, ownerId: UID, def: "rifle", rarity: 3, itemId: "i", qty: 1 }, SALT);
    assert.equal(r.kind, "rare_extract");
    if (r.kind === "rare_extract") {
      assert.deepEqual(Buffer.from(r.ownerHash), sha(`${SALT}:user:${UID}`));
      assert.deepEqual(Buffer.from(r.itemDefHash), sha("rifle"));
      assert.equal(r.rarity, 3);
    }
    for (const a of [b, r]) {
      const bytes = Buffer.concat(Object.values(a).filter((v): v is Uint8Array => v instanceof Uint8Array));
      assert.equal(bytes.includes(Buffer.from(UID)), false);
    }
    // The lobby names every boss killer publicly: the same user's killer_hash must not equal their
    // owner_hash, or anyone could attach that player's rare-extract history to the nickname.
    if (b.kind === "boss_kill" && r.kind === "rare_extract") assert.notDeepEqual(Buffer.from(b.killerHash), Buffer.from(r.ownerHash));
    assert.deepEqual(Buffer.from(saltedHash(SALT, `user:${UID}`)), sha(`${SALT}:user:${UID}`));
  });

  test("a boss no raider killed is recorded with a zero killer hash", () => {
    const n = toRecordArgs("boss_kill", { matchId: "m1", cycleId: 9, boss: "warden", killer: NO_KILLER }, SALT);
    assert.ok(n.kind === "boss_kill" && Buffer.from(n.killerHash).equals(Buffer.alloc(32)));
    const g = toRecordArgs("boss_kill", { matchId: "m1", cycleId: 9, boss: "warden", killer: "guest:none" }, SALT);
    assert.ok(g.kind === "boss_kill" && !Buffer.from(g.killerHash).equals(Buffer.alloc(32)), "a guest named none is still hashed");
  });

  test("payloads that do not fit throw (the worker fails them permanently)", () => {
    assert.throws(() => toRecordArgs("match", { cycleId: 1, shard: 0, matchHash: "zz", humans: 1, mia: 0 }, SALT));
    assert.throws(() => toRecordArgs("boss_kill", { cycleId: 1, boss: "dragon", killer: "x" }, SALT));
    assert.throws(() => toRecordArgs("rare_extract", { cycleId: 1, ownerId: UID, def: "rifle", rarity: 4 }, SALT));
    assert.throws(() => toRecordArgs("other", {}, SALT));
  });
});
