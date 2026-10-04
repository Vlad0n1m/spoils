import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { coreEnv, isCronAuthorized } from "@/lib/env";
import { runChainEventsCron } from "@/lib/chain/run";
import { cleanError } from "@/lib/chain/worker";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Sends queued game results (chain_events) to the spoils_events program on Solana, signed and paid
 * by the server authority: up to ?limit= (1–50, default 10) due events per call, with backoff on
 * failures. Without CHAIN_AUTHORITY_SECRET (or CHAIN_HASH_SALT in production) it answers
 * configured:false; while the program is not deployed or initialized for this signer, or the signer
 * cannot pay a batch of fees, ready:false. Either way every event stays queued. Called every minute
 * by the cron service.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), coreEnv().CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const n = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(n) && n >= 1 ? Math.min(50, n) : undefined;
  try {
    const r = await runChainEventsCron(db, { limit });
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[cron/chain-events] failed", cleanError(err));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
