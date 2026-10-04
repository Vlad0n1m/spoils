import { desc, sql, type SQL } from "drizzle-orm";
import { CR } from "@extract/shared";
import { invariantRuns, type InvariantCheckResult, type InvariantRunRow } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";

/**
 * B6 nightly invariant check (docs/ALPHA_PLAN.md): items, CR and market money must agree with
 * their journals (item_events, credit_ledger, money_ledger), and the house only ever receives.
 *
 * All checks run in ONE read-only REPEATABLE READ transaction, so they see a single snapshot and a
 * raid settling mid-run cannot produce a false mismatch between a table and its journal. Every
 * check is a set query (hash joins / group-bys over whole tables, no per-row round trips) that
 * returns the failure count and at most SAMPLE ids. A check that errors (e.g. hits the statement
 * timeout) is rolled back to its savepoint and reported as "error"; the others still run.
 * The only write is the invariant_runs row afterwards.
 */

export const SAMPLE = 10;
/** Per-statement cap: the cron route has 60 s; a slow check fails alone instead of the whole run. */
const STATEMENT_TIMEOUT_MS = 20_000;

/** Market money moves that are internal transfers: rows with these reasons net to zero per ref_id. */
export const PAIRED_MONEY_REASONS = ["buy", "sale", "fee", "treasury_sale", "kit_buy", "kit_sale"] as const;
/** Negative money rows that are a player paying the game or another player (not money leaving). */
const SPEND_MONEY_REASONS = ["buy", "kit_buy"] as const;
export const HOUSE_ACCOUNT = "house";

interface CheckOut {
  count: number;
  sample: string[];
  detail?: string;
}

interface CheckDef {
  key: string;
  title: string;
  run: (tx: Tx) => Promise<CheckOut>;
}

const inList = (xs: readonly string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/**
 * `bad` must select one text column `id` per offending row. Materialized once: the count and the
 * sample come from the same rows.
 */
async function countAndSample(tx: Tx, bad: SQL): Promise<CheckOut> {
  const r = await tx.execute<{ n: number; sample: string[] | null }>(sql`
    with bad as materialized (${bad})
    select (select count(*)::int from bad) as n,
           array(select id::text from bad order by id limit ${SAMPLE}) as sample`);
  const row = r.rows[0];
  return { count: Number(row?.n ?? 0), sample: row?.sample ?? [] };
}

export const CHECKS: readonly CheckDef[] = [
  {
    key: "item_placement",
    title: "Каждая вещь ровно в одном месте: колонки совпадают с состоянием",
    // in_stash: owner, no match / loadout. listed: no match / loadout. in_raid: own gear (owner +
    // loadout) or a pool allocation (no owner, no loadout, a match). lost_pool / treasury /
    // destroyed: nobody's; a bound item never enters the pool.
    run: (tx) =>
      countAndSample(
        tx,
        sql`select id from items where not (
          (state = 'in_stash' and owner_id is not null and match_id is null and loadout_id is null)
          or (state = 'listed' and match_id is null and loadout_id is null)
          or (state = 'in_raid' and (
                (loadout_id is not null and owner_id is not null)
                or (loadout_id is null and owner_id is null and match_id is not null)))
          or (state = 'lost_pool' and owner_id is null and match_id is null and loadout_id is null and not bound)
          or (state in ('treasury', 'destroyed') and owner_id is null and match_id is null and loadout_id is null))`,
      ),
  },
  {
    key: "stash_vs_raid",
    title: "Ни одна вещь не лежит одновременно на складе и в рейде",
    // An in_raid item must hang off a live raid or an active loadout of its owner; an active
    // loadout's unique entries must be exactly those items, and no item is in two active loadouts.
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select i.id::text as id from items i
          left join raids r on r.match_id = i.match_id
          left join loadouts l on l.id = i.loadout_id
        where i.state = 'in_raid' and (
          (i.match_id is not null and (r.match_id is null or r.status <> 'running'))
          or (i.loadout_id is not null and (l.id is null or l.status not in ('locked', 'in_raid') or l.user_id <> i.owner_id)))
        union
        select e->>'uid' from loadouts l
          cross join lateral jsonb_array_elements(l.entries) e
          left join items i on i.id::text = e->>'uid'
        where l.status in ('locked', 'in_raid') and coalesce(e->>'uid', '') <> ''
          and (i.id is null or i.state <> 'in_raid' or i.loadout_id is distinct from l.id)
        union
        select e->>'uid' from loadouts l
          cross join lateral jsonb_array_elements(l.entries) e
        where l.status in ('locked', 'in_raid') and coalesce(e->>'uid', '') <> ''
        group by e->>'uid' having count(*) > 1`,
      ),
  },
  {
    key: "item_journal",
    title: "Состояние и владелец вещи совпадают с последней записью item_events",
    // Last event by id: ids are taken at insert, after the item's row lock, so they follow the real
    // order of transitions (`at` is the transaction start and may not).
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        with last as (select max(id) as id from item_events group by item_id)
        select i.id from items i
          left join (select e.item_id, e.to_state, e.to_owner from item_events e join last using (id)) le
            on le.item_id = i.id
        where le.item_id is null or le.to_state <> i.state or le.to_owner is distinct from i.owner_id`,
      ),
  },
  {
    key: "state_counts",
    title: "Число вещей по состояниям сходится с журналом",
    // Per state: items now vs items whose last journal entry ends there (journal rows of items that
    // no longer exist count too). Sample = the states that differ.
    run: async (tx) => {
      const r = await tx.execute<{ state: string; items: number; journal: number }>(sql`
        with last as (select max(id) as id from item_events group by item_id),
        j as (select e.to_state::text as state, count(*)::int as n from item_events e join last using (id) group by 1),
        i as (select state::text as state, count(*)::int as n from items group by 1)
        select coalesce(i.state, j.state) as state, coalesce(i.n, 0) as items, coalesce(j.n, 0) as journal
        from i full join j on j.state = i.state order by 1`);
      const rows = r.rows.map((x) => ({ state: x.state, items: Number(x.items), journal: Number(x.journal) }));
      const off = rows.filter((x) => x.items !== x.journal);
      return {
        count: off.length,
        sample: off.map((x) => x.state).slice(0, SAMPLE),
        detail: rows.map((x) => `${x.state} ${x.items}/${x.journal}`).join(", ") || "вещей нет",
      };
    },
  },
  {
    key: "credits_ledger",
    title: `CR игрока = ${CR.START_BALANCE} + Σ credit_ledger`,
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select u.id from users u
          left join (select user_id, sum(delta)::bigint as s from credit_ledger group by user_id) c on c.user_id = u.id
        where u.credits <> ${CR.START_BALANCE} + coalesce(c.s, 0)`,
      ),
  },
  {
    key: "money_ledger",
    title: "Деньги игрока (balance_cents) = Σ money_ledger его счёта",
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select u.id from users u
          left join (select account, sum(delta_minor)::numeric as s from money_ledger group by account) m
            on m.account = u.id::text
        where u.balance_cents::numeric <> coalesce(m.s, 0)`,
      ),
  },
  {
    key: "money_accounts",
    title: "В money_ledger только счета игроков и house",
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select distinct m.account as id from money_ledger m
          left join users u on u.id::text = m.account
        where m.account <> ${HOUSE_ACCOUNT} and u.id is null`,
      ),
  },
  {
    key: "money_paired",
    title: "Покупки, продажи, комиссии и наборы сходятся в ноль по каждой операции",
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select ref_id as id from money_ledger
        where reason in (${inList(PAIRED_MONEY_REASONS)})
        group by ref_id having sum(delta_minor) <> 0`,
      ),
  },
  {
    key: "house_only_receives",
    title: "Казна только получает: игра никому не платит SOL",
    // Sample prefixes: ledger:<id> (house or money leaving the game), withdrawal:<id>, payout:<match>.
    run: async (tx) => {
      const out = await countAndSample(
        tx,
        sql`
        select 'ledger:' || id as id from money_ledger
        where delta_minor < 0 and (account = ${HOUSE_ACCOUNT} or reason not in (${inList(SPEND_MONEY_REASONS)}))
        union all
        select 'withdrawal:' || id from withdrawals where status in ('submitted', 'confirmed')
        union all
        select 'payout:' || match_id || ':' || user_id from match_instant_payouts`,
      );
      const h = await tx.execute<{ s: string }>(
        sql`select coalesce(sum(delta_minor), 0)::text as s from money_ledger where account = ${HOUSE_ACCOUNT}`,
      );
      return { ...out, detail: `house = ${h.rows[0]?.s ?? "0"}` };
    },
  },
  {
    key: "non_negative",
    title: "Нет отрицательных балансов (CR, деньги, стаки, house)",
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select 'user:' || id as id from users where credits < 0 or balance_cents < 0
        union all
        select 'stack:' || user_id || ':' || def_id from stash_stacks where qty < 0
        union all
        select 'house' from money_ledger where account = ${HOUSE_ACCOUNT} having sum(delta_minor) < 0`,
      ),
  },
  {
    key: "listings",
    title: "Выставленная вещь ровно в одном открытом лоте продавца",
    run: (tx) =>
      countAndSample(
        tx,
        sql`
        select i.id from items i
          left join listings l on l.item_id = i.id and l.status in ('pending', 'active')
        where i.state = 'listed' and (l.id is null or l.seller_id is distinct from i.owner_id)
        union
        select l.item_id from listings l join items i on i.id = l.item_id
        where l.status in ('pending', 'active') and i.state <> 'listed'`,
      ),
  },
  {
    key: "pool",
    title: "Пул потерь: выдачи сходятся с журналом",
    // World raids: raids.pool_released = Σ raid_entries.released, and each entry's released =
    // its 'alloc' journal rows (ref = entry id). Detail: pool size now.
    run: async (tx) => {
      const out = await countAndSample(
        tx,
        sql`
        select 'raid:' || r.match_id as id from raids r
          left join (select match_id, sum(released)::int as s from raid_entries group by match_id) e on e.match_id = r.match_id
        where r.kind = 'world' and r.pool_released <> coalesce(e.s, 0)
        union all
        select 'entry:' || e.entry_id from raid_entries e
          join raids r on r.match_id = e.match_id and r.kind = 'world'
          left join (select ref_id, count(*)::int as n from item_events where reason = 'alloc' group by ref_id) a
            on a.ref_id = e.entry_id::text
        where e.released <> coalesce(a.n, 0)`,
      );
      const p = await tx.execute<{ n: number }>(sql`select count(*)::int as n from items where state = 'lost_pool'`);
      return { ...out, detail: `в пуле ${Number(p.rows[0]?.n ?? 0)}` };
    },
  },
];

export interface InvariantRun {
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  ok: boolean;
  failed: number;
  checks: InvariantCheckResult[];
}

/** Runs every check (read-only, one snapshot). Does not store anything. */
export async function checkInvariants(db: Db, checks: readonly CheckDef[] = CHECKS): Promise<InvariantRun> {
  const startedAt = new Date();
  const results = await db.transaction(
    async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
      const out: InvariantCheckResult[] = [];
      for (const c of checks) {
        const t0 = performance.now();
        try {
          // A savepoint per check: an error (timeout) rolls back only this check.
          const r = await tx.transaction((sp) => c.run(sp));
          out.push({ key: c.key, title: c.title, status: r.count > 0 ? "fail" : "ok", count: r.count, sample: r.sample, detail: r.detail, ms: Math.round(performance.now() - t0) });
        } catch (e) {
          out.push({ key: c.key, title: c.title, status: "error", count: 0, sample: [], detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) });
        }
      }
      return out;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  const finishedAt = new Date();
  const failed = results.filter((r) => r.status !== "ok").length;
  return { startedAt, finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), ok: failed === 0, failed, checks: results };
}

/** Checks, stores the run in invariant_runs and alerts on failures. Returns the stored row id. */
export async function runInvariants(
  db: Db,
  trigger: "cron" | "admin" | "test",
  opts: { alert?: (run: InvariantRun) => Promise<void> } = {},
): Promise<InvariantRun & { id: number }> {
  const run = await checkInvariants(db);
  const [row] = await db
    .insert(invariantRuns)
    .values({
      trigger,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      ok: run.ok,
      failed: run.failed,
      checks: run.checks,
    })
    .returning({ id: invariantRuns.id });
  if (!run.ok) await (opts.alert ?? alertInvariantFailures)(run);
  return { ...run, id: row!.id };
}

/** The alert text: failed check keys with their counts and first sample ids. */
export function alertText(run: InvariantRun): string {
  const bad = run.checks.filter((c) => c.status !== "ok");
  const lines = bad.map(
    (c) => `- ${c.key}: ${c.status === "error" ? `error (${c.detail ?? ""})` : `${c.count} (e.g. ${c.sample.slice(0, 3).join(", ")})`}`,
  );
  return `[SPOILS] invariant check failed: ${bad.length} of ${run.checks.length} checks\n${lines.join("\n")}\nDetails: /admin/invariants`;
}

/**
 * Alert hook: one log line (always), then a POST to ALERT_WEBHOOK_URL if set. The body carries the
 * text as both `text` (Slack) and `content` (Discord). The URL itself is never logged.
 */
export async function alertInvariantFailures(run: InvariantRun, env: Record<string, string | undefined> = process.env): Promise<void> {
  const text = alertText(run);
  console.error(`[invariants] FAILED ${run.checks.filter((c) => c.status !== "ok").map((c) => `${c.key}=${c.status === "error" ? "error" : c.count}`).join(" ")}`);
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error(`[invariants] alert webhook answered ${res.status}`);
  } catch (e) {
    console.error(`[invariants] alert webhook failed: ${e instanceof Error ? e.name : "error"}`);
  }
}

/** Latest runs, newest first (admin page). */
export async function latestInvariantRuns(db: Db, limit = 10): Promise<InvariantRunRow[]> {
  return db.select().from(invariantRuns).orderBy(desc(invariantRuns.startedAt)).limit(limit);
}
