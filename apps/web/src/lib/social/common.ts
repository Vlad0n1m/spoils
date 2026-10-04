/**
 * DB plumbing shared by friends.ts and party.ts: per-user advisory locks, nickname lookup, menu
 * presence and the "on the map now" test.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db, Tx } from "../inventory/db";
import type { SocialErrCode } from "./types";

export type Q = Db | Tx;

/** Service result: `ok` with extra fields, or a SocialErrCode (rules.ts SOCIAL_ERR has text + status). */
export type SocialResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: SocialErrCode };

export const fail = (code: SocialErrCode) => ({ ok: false, code }) as const;

/**
 * Serialises the social changes of these users (friend counts, party membership) for the rest of
 * the transaction. Ordered, so two transactions over the same pair never deadlock.
 */
export async function lockUsers(tx: Tx, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids.map((s) => s.toLowerCase()))].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`spoils/social/${id}`}, 0))`);
  }
}

export interface UserRef {
  id: string;
  nickname: string;
  level: number;
}

/** A registered user by nickname, case-insensitive (an exact-case match wins). */
export async function findUserByNickname(q: Q, nickname: string): Promise<UserRef | null> {
  const r = await q.execute<{ id: string; nickname: string; level: number }>(sql`
    select id, nickname, level from users
    where lower(nickname) = lower(${nickname})
    order by (nickname = ${nickname}) desc
    limit 1`);
  const u = r.rows[0];
  return u ? { id: String(u.id), nickname: u.nickname, level: Number(u.level) } : null;
}

/** Menu presence heartbeat: at most one write per user every 20 s. */
export async function touchPresence(q: Q, userId: string, now: number): Promise<void> {
  await q.execute(sql`
    insert into user_presence (user_id, seen_at)
    select ${userId}::uuid, ${new Date(now)} where exists (select 1 from users where id = ${userId}::uuid)
    on conflict (user_id) do update set seen_at = excluded.seen_at
    where user_presence.seen_at < excluded.seen_at - interval '20 seconds'`);
}

/** SQL boolean: `userCol` has an active entry on a running shard (on the map now). */
export function inRaidSql(userCol: SQL, now: number): SQL {
  return sql`exists (
    select 1 from raid_entries e join raids r on r.match_id = e.match_id
    where e.user_id = ${userCol} and e.status = 'active' and r.status = 'running' and r.ends_at > ${new Date(now)})`;
}

/** Timestamp column → wall ms (pg returns Date; tolerate strings). */
export function ms(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}
