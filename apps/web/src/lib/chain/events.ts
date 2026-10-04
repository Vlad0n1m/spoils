import { createHash } from "node:crypto";
import { z } from "zod";
import {
  BOSS_KINDS,
  RARITY_NAMES,
  itemDef,
  type BossKind,
  type MatchEndReport,
  type SettledItem,
  type WorldEventReport,
} from "@extract/shared";
import type { RecordArgs } from "./program";

/**
 * The three game results recorded on chain, as stored in chain_events (payload = internal ids, for
 * our own audit) and as sent (RecordArgs = only hashes and small numbers). Pure functions: the DB
 * side is queue.ts, the Solana side sender.ts.
 *
 * Hashes (hex in payloads, 32 raw bytes on chain):
 *   match_hash     sha256(canonicalJson(MatchEndReport)): keys sorted, undefined dropped
 *   killer_hash    sha256(salt + ":" + "user:<userId>")  or  ("guest:<nickname>") for a guest killer
 *   owner_hash     sha256(salt + ":" + "user:<userId>")
 *   item_def_hash  sha256(def id), e.g. sha256("rifle"): public, anyone can map it back
 * The salt (CHAIN_HASH_SALT) stays on the server, so nobody can test a user id against a hash.
 */

/** Rare extract threshold: epic and above (RARITY_NAMES: common, rare, epic, legendary). */
export const RARE_EXTRACT_MIN_RARITY = RARITY_NAMES.indexOf("epic");

export type ChainEventKind = "match" | "boss_kill" | "rare_extract";

export interface MatchPayload {
  matchId: string;
  cycleId: number;
  shard: number;
  matchHash: string;
  humans: number;
  mia: number;
}
export interface BossKillPayload {
  matchId: string;
  cycleId: number;
  boss: BossKind;
  /** "user:<userId>" (registered) or "guest:<nickname>". */
  killer: string;
}
export interface RareExtractPayload {
  entryId: string;
  matchId: string;
  cycleId: number;
  ownerId: string;
  def: string;
  rarity: number;
  /** Unique item id; null for a stack of rare junk (one event per def per exit). */
  itemId: string | null;
  qty: number;
}

export type ChainEvent =
  | { kind: "match"; dedupeKey: string; payload: MatchPayload }
  | { kind: "boss_kill"; dedupeKey: string; payload: BossKillPayload }
  | { kind: "rare_extract"; dedupeKey: string; payload: RareExtractPayload };

// ---------------------------------------------------------------------------- hashing

export function sha256(data: string | Uint8Array): Buffer {
  return createHash("sha256").update(data).digest();
}

/** JSON with object keys sorted at every depth and undefined members dropped (stable across runs). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    const s = JSON.stringify(v);
    return s === undefined ? "null" : s;
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined && typeof o[k] !== "function")
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function matchHashHex(report: MatchEndReport): string {
  return sha256(canonicalJson(report)).toString("hex");
}

/** sha256(salt + ":" + ref) for a user reference such as "user:<id>": never a raw id on chain. */
export function saltedHash(salt: string, ref: string): Buffer {
  return sha256(`${salt}:${ref}`);
}

export function itemDefHash(def: string): Buffer {
  return sha256(def);
}

export function userRef(userId: string): string {
  return `user:${userId}`;
}

// ---------------------------------------------------------------------------- builders

const clampInt = (n: unknown, max: number) => Math.max(0, Math.min(max, Math.floor(Number(n)) || 0));

/**
 * raids/end of a live world shard (cycleId set). humans = human participants (one per entry), mia =
 * those still on the map at the wipe. Pre-v6 reports and demo shards record nothing.
 */
export function matchEvent(report: MatchEndReport, mode: string): ChainEvent | null {
  if (mode !== "live" || !Number.isInteger(report.cycleId) || (report.cycleId as number) < 0) return null;
  const humans = report.participants.filter((p) => !p.isBot && !!p.userId);
  return {
    kind: "match",
    dedupeKey: `match:${report.matchId}`,
    payload: {
      matchId: report.matchId,
      cycleId: report.cycleId as number,
      shard: clampInt(report.shard ?? 0, 0xff),
      matchHash: matchHashHex(report),
      humans: clampInt(humans.length, 0xffff),
      mia: clampInt(humans.filter((p) => p.exitType === "mia").length, 0xffff),
    },
  };
}

/** world/event boss_killed; killerUserId = the registered user with that nickname, else a guest. */
export function bossKillEvent(ev: WorldEventReport, killerUserId: string | null): ChainEvent | null {
  if (!(BOSS_KINDS as readonly string[]).includes(ev.boss) || !Number.isInteger(ev.cycleId) || ev.cycleId < 0) return null;
  return {
    kind: "boss_kill",
    dedupeKey: `boss:${ev.matchId}`,
    payload: {
      matchId: ev.matchId,
      cycleId: ev.cycleId,
      boss: ev.boss,
      killer: killerUserId ? userRef(killerUserId) : `guest:${ev.by}`,
    },
  };
}

/** Rare junk (def rarity ≥ the threshold) of one exit report: one event per def, dog tags excluded. */
export function rareJunk(extracted: readonly SettledItem[]): Array<{ def: string; rarity: number; qty: number }> {
  const byDef = new Map<string, { def: string; rarity: number; qty: number }>();
  for (const s of extracted) {
    const d = itemDef(s.def);
    if (!d || d.cat !== "junk" || d.id === "junk_dogtag" || d.rarity < RARE_EXTRACT_MIN_RARITY) continue;
    const qty = clampInt(s.qty, 1_000_000);
    if (qty <= 0) continue;
    const cur = byDef.get(d.id);
    if (cur) cur.qty += qty;
    else byDef.set(d.id, { def: d.id, rarity: d.rarity, qty });
  }
  return [...byDef.values()];
}

export function rareExtractEvent(
  e: { entryId: string; matchId: string; cycleId: number; ownerId: string },
  item: { itemId: string | null; def: string; rarity: number; qty: number },
): ChainEvent {
  return {
    kind: "rare_extract",
    dedupeKey: `rare:${e.entryId}:${item.itemId ?? item.def}`,
    payload: { ...e, ...item },
  };
}

// ---------------------------------------------------------------------------- payload → instruction

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const cycle = z.number().int().nonnegative();
const matchSchema = z.object({
  cycleId: cycle,
  shard: z.number().int().min(0).max(0xff),
  matchHash: hex32,
  humans: z.number().int().min(0).max(0xffff),
  mia: z.number().int().min(0).max(0xffff),
});
const bossSchema = z.object({
  cycleId: cycle,
  boss: z.string().refine((b) => (BOSS_KINDS as readonly string[]).includes(b)),
  killer: z.string().min(1),
});
const rareSchema = z.object({
  cycleId: cycle,
  ownerId: z.string().min(1),
  def: z.string().min(1),
  rarity: z.number().int().min(0).max(RARITY_NAMES.length - 1),
});

/** The instruction arguments of a stored event; throws on a payload that does not fit (a permanent error). */
export function toRecordArgs(kind: string, payload: unknown, salt: string): RecordArgs {
  switch (kind) {
    case "match": {
      const p = matchSchema.parse(payload);
      return {
        kind: "match",
        cycleId: BigInt(p.cycleId),
        shard: p.shard,
        matchHash: Buffer.from(p.matchHash, "hex"),
        humans: p.humans,
        mia: Math.min(p.mia, p.humans),
      };
    }
    case "boss_kill": {
      const p = bossSchema.parse(payload);
      return {
        kind: "boss_kill",
        cycleId: BigInt(p.cycleId),
        bossKind: BOSS_KINDS.indexOf(p.boss as BossKind),
        killerHash: saltedHash(salt, p.killer),
      };
    }
    case "rare_extract": {
      const p = rareSchema.parse(payload);
      return {
        kind: "rare_extract",
        cycleId: BigInt(p.cycleId),
        itemDefHash: itemDefHash(p.def),
        rarity: p.rarity,
        ownerHash: saltedHash(salt, userRef(p.ownerId)),
      };
    }
    default:
      throw new Error(`unknown chain event kind ${kind}`);
  }
}
