import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { BOSS_EVENT, bossEventOf } from "@extract/shared";
import { bossHash, bossHasher, bossOf, worldSecret } from "./boss-schedule.js";
import { worldClockOffsetMs, worldNow } from "./clock.js";

test("worldSecret: WORLD_SEED_SECRET (hex or text) first, else derived from the HMAC secret, never the master seed", () => {
  const hex = "ab".repeat(32);
  assert.deepEqual(worldSecret({ WORLD_SEED_SECRET: hex, GAME_SERVER_HMAC_SECRET: "h" }), Buffer.from(hex, "hex"));
  assert.deepEqual(worldSecret({ WORLD_SEED_SECRET: "plain words" }), Buffer.from("plain words", "utf8"));
  assert.deepEqual(worldSecret({ GAME_SERVER_HMAC_SECRET: "h", MASTER_SEED_HEX: "cd".repeat(32) }), createHmac("sha256", "h").update("spoils/world-seed/v1").digest());
});

test("bossHash = first 4 bytes of HMAC(secret, 'spoils/boss/v1|' + label); bossOf follows the shared schedule", () => {
  const secret = Buffer.from("s3cret");
  const h = bossHasher(secret);
  assert.equal(h("pos|7"), createHmac("sha256", secret).update("spoils/boss/v1|pos|7").digest().readUInt32BE(0));
  assert.equal(h("pos|7"), h("pos|7"));
  const other = bossHasher(Buffer.from("other"));
  const a = Array.from({ length: 300 }, (_, c) => bossEventOf(c, h));
  const b = Array.from({ length: 300 }, (_, c) => bossEventOf(c, other));
  assert.notDeepEqual(a, b, "another secret, another schedule");
  for (let blk = 0; blk < 100; blk++) {
    const boss = a.slice(blk * BOSS_EVENT.BLOCK_CYCLES, (blk + 1) * BOSS_EVENT.BLOCK_CYCLES).filter((x) => x !== null);
    assert.equal(boss.length, 1, "one boss map per block");
  }
  const prev = process.env.WORLD_SEED_SECRET;
  process.env.WORLD_SEED_SECRET = "73336372657473336372657473336372";
  try {
    const s = bossHasher(worldSecret());
    assert.equal(bossHash("perm|3"), s("perm|3"));
    for (let c = 1000; c < 1030; c++) assert.equal(bossOf(c), bossEventOf(c, s));
  } finally {
    if (prev === undefined) delete process.env.WORLD_SEED_SECRET;
    else process.env.WORLD_SEED_SECRET = prev;
  }
});

test("worldNow adds WORLD_DEV_CLOCK_OFFSET_MS outside production only (addendum A1)", () => {
  assert.equal(worldClockOffsetMs({}), 0);
  assert.equal(worldClockOffsetMs({ WORLD_DEV_CLOCK_OFFSET_MS: "-60000", NODE_ENV: "development" }), -60_000);
  assert.equal(worldClockOffsetMs({ WORLD_DEV_CLOCK_OFFSET_MS: "abc" }), 0);
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(worldClockOffsetMs({ WORLD_DEV_CLOCK_OFFSET_MS: "60000", NODE_ENV: "production" }), 0);
  } finally {
    console.warn = prevWarn;
  }
  const prev = process.env.WORLD_DEV_CLOCK_OFFSET_MS;
  process.env.WORLD_DEV_CLOCK_OFFSET_MS = "3600000";
  try {
    assert.ok(Math.abs(worldNow() - Date.now() - 3_600_000) < 1_000);
  } finally {
    if (prev === undefined) delete process.env.WORLD_DEV_CLOCK_OFFSET_MS;
    else process.env.WORLD_DEV_CLOCK_OFFSET_MS = prev;
  }
});
