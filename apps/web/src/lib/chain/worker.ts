import type { ChainEventRow } from "../../db/schema";
import type { Db } from "../inventory/db";
import { toRecordArgs } from "./events";
import type { RecordArgs } from "./program";
import { claimDue, markRetry, markSent, releaseClaim, rememberTx } from "./queue";

/**
 * The chain_events worker (cron /api/cron/chain-events). Per due row:
 *   1. a row that still carries tx_sig was signed by an earlier attempt: ask the cluster first, so a
 *      transaction that landed late is marked sent instead of being recorded twice;
 *   2. otherwise sign a fresh record transaction, store its signature, send it and wait (bounded)
 *      for confirmation.
 * Transport trouble (dead RPC, timeouts) only reschedules the row with backoff; program rejections
 * fail it after MAX_REJECTED_ATTEMPTS. Nothing here throws to the caller per row.
 */

/** Outcome of sending a prepared transaction. */
export type SendOutcome =
  | { status: "confirmed" }
  /** Preflight or the program refused it: nothing was recorded. */
  | { status: "rejected"; error: string }
  /** Its blockhash expired before it landed: safe to sign a new one. */
  | { status: "expired" }
  /** Sent, but confirmation is unknown (timeout, RPC error): check the signature next time. */
  | { status: "unknown"; error: string };

/** Where an earlier signature stands. */
export type SigStatus =
  | { status: "confirmed" }
  /** Landed with a program error (fee paid, nothing recorded). */
  | { status: "failed"; error: string }
  /** Not final yet and its blockhash is still valid. */
  | { status: "pending" }
  /** Not on chain and can no longer land. */
  | { status: "expired" };

export interface PreparedTx {
  sig: string;
  /** Last block height its blockhash is valid for. */
  validUntil: number;
  send(): Promise<SendOutcome>;
}

export interface ChainSender {
  prepare(args: RecordArgs): Promise<PreparedTx>;
  status(sig: string, validUntil: number | null): Promise<SigStatus>;
}

export interface WorkerOptions {
  salt: string;
  /** Rows per call (default 10). */
  limit?: number;
  /** Stop starting new rows after this much time (default 20 s; the cron route allows 30 s). */
  budgetMs?: number;
  /** Re-check delay of a pending signature (default 15 s). */
  pendingRecheckMs?: number;
  clock?: () => Date;
}

export interface WorkerResult {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  released: number;
  signatures: string[];
}

export const DEFAULT_BATCH = 10;

export async function runChainWorker(db: Db, sender: ChainSender, o: WorkerOptions): Promise<WorkerResult> {
  const clock = o.clock ?? (() => new Date());
  const started = clock().getTime();
  const budget = o.budgetMs ?? 20_000;
  const rows = await claimDue(db, o.limit ?? DEFAULT_BATCH, clock());
  const res: WorkerResult = { claimed: rows.length, sent: 0, retried: 0, failed: 0, released: 0, signatures: [] };
  for (const row of rows) {
    if (clock().getTime() - started > budget) {
      await releaseClaim(db, row.id, clock()).catch(() => undefined);
      res.released++;
      continue;
    }
    let out: "sent" | "queued" | "failed";
    try {
      out = await processRow(db, sender, row, o, clock, res.signatures);
    } catch (e) {
      // Only the DB writes above can land here; the lease frees the row if even this fails.
      out = await markRetry(db, row, { error: cleanError(e), now: clock(), keepTx: true }).catch(() => "queued" as const);
    }
    if (out === "sent") res.sent++;
    else if (out === "failed") res.failed++;
    else res.retried++;
  }
  return res;
}

async function processRow(
  db: Db,
  sender: ChainSender,
  row: ChainEventRow,
  o: WorkerOptions,
  clock: () => Date,
  sigs: string[],
): Promise<"sent" | "queued" | "failed"> {
  let args: RecordArgs;
  try {
    args = toRecordArgs(row.kind, row.payload, o.salt);
  } catch (e) {
    return markRetry(db, row, { error: `bad payload: ${cleanError(e)}`, now: clock(), permanent: true });
  }

  if (row.txSig) {
    let st: SigStatus;
    try {
      st = await sender.status(row.txSig, row.txValidUntil ?? null);
    } catch (e) {
      return markRetry(db, row, { error: cleanError(e), now: clock(), keepTx: true });
    }
    if (st.status === "confirmed") {
      await markSent(db, row.id, row.txSig, clock());
      sigs.push(row.txSig);
      return "sent";
    }
    if (st.status === "pending") {
      return markRetry(db, row, { error: "waiting for confirmation", now: clock(), keepTx: true, delayMs: o.pendingRecheckMs ?? 15_000 });
    }
    if (st.status === "failed") return markRetry(db, row, { error: st.error, now: clock(), rejected: true });
    // expired: the earlier transaction can no longer land; sign a new one below
  }

  let prep: PreparedTx;
  try {
    prep = await sender.prepare(args);
  } catch (e) {
    return markRetry(db, row, { error: cleanError(e), now: clock() });
  }
  await rememberTx(db, row.id, prep.sig, prep.validUntil);
  let sent: SendOutcome;
  try {
    sent = await prep.send();
  } catch (e) {
    sent = { status: "unknown", error: cleanError(e) };
  }
  switch (sent.status) {
    case "confirmed":
      await markSent(db, row.id, prep.sig, clock());
      sigs.push(prep.sig);
      return "sent";
    case "rejected":
      return markRetry(db, row, { error: sent.error, now: clock(), rejected: true });
    case "expired":
      return markRetry(db, row, { error: "blockhash expired before confirmation", now: clock() });
    case "unknown":
      return markRetry(db, row, { error: sent.error, now: clock(), keepTx: true });
  }
}

/**
 * Error text safe to store and log: URLs reduced to their origin (RPC URLs can carry API keys in
 * the path or query), whitespace collapsed, at most 300 characters.
 */
export function cleanError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return raw
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, (m) => {
      const [, u, tail] = /^(.*?)([.,:;!?]*)$/.exec(m)!;
      try {
        return new URL(u!).origin + tail;
      } catch {
        return "<url>" + tail;
      }
    })
    .replace(/(api[-_]?key|token|secret)=([^&\s]+)/gi, "$1=<redacted>")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}
