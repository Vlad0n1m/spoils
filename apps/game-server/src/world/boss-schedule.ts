/**
 * WORLD v6 boss events (spec D12): which boss (if any) spawns on the map of a cycle. The schedule is
 * the shared, pure bossEventOf(cycle, hash); only this process knows the hash, so players cannot
 * compute future boss maps beyond what the lobby announces.
 *
 *   worldSecret = env WORLD_SEED_SECRET, else HMAC-SHA256(GAME_SERVER_HMAC_SECRET, "spoils/world-seed/v1")
 *   bossHash(label) = first 4 bytes (big-endian uint32) of HMAC-SHA256(worldSecret, "spoils/boss/v1|" + label)
 *
 * Never derived from MASTER_SEED_HEX. Without either secret (local dev, tests) a fixed dev secret is
 * used and logged once.
 */

import { createHmac } from "node:crypto";
import { bossEventOf, type BossKind } from "@extract/shared";

const DEV_SECRET = "spoils/dev-world-seed";
let warnedDev = false;

/** The secret behind the boss schedule (Buffer of a hex WORLD_SEED_SECRET, else its utf8 bytes). */
export function worldSecret(env: Record<string, string | undefined> = process.env): Buffer {
  const own = env.WORLD_SEED_SECRET?.trim();
  if (own) return /^(?:[0-9a-f]{2}){16,}$/i.test(own) ? Buffer.from(own, "hex") : Buffer.from(own, "utf8");
  const hmac = env.GAME_SERVER_HMAC_SECRET;
  if (hmac) return createHmac("sha256", hmac).update("spoils/world-seed/v1").digest();
  if (!warnedDev) {
    warnedDev = true;
    console.warn("[world] neither WORLD_SEED_SECRET nor GAME_SERVER_HMAC_SECRET is set: the boss schedule uses a dev secret");
  }
  return Buffer.from(DEV_SECRET, "utf8");
}

/** A boss-schedule hash for `secret` (labels are memoized: the schedule asks for the same few labels). */
export function bossHasher(secret: Buffer): (label: string) => number {
  const memo = new Map<string, number>();
  return (label: string): number => {
    let v = memo.get(label);
    if (v === undefined) {
      v = createHmac("sha256", secret).update(`spoils/boss/v1|${label}`).digest().readUInt32BE(0);
      if (memo.size > 4096) memo.clear();
      memo.set(label, v);
    }
    return v;
  };
}

let cached: { key: string; hash: (label: string) => number } | null = null;

/** bossHash of this process' world secret (re-derived if the env changed, e.g. in tests). */
export function bossHash(label: string): number {
  const secret = worldSecret();
  const key = secret.toString("hex");
  if (!cached || cached.key !== key) cached = { key, hash: bossHasher(secret) };
  return cached.hash(label);
}

/** The event boss of `cycle`, or null (no boss map). */
export function bossOf(cycle: number): BossKind | null {
  return bossEventOf(cycle, bossHash);
}
