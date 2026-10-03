import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { coreEnv } from "@/lib/env";
import { expireStaleLocks } from "@/lib/inventory/loadout";
import { voidStale } from "@/lib/inventory/raids";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Housekeeping for raids the game server never closed (crash, lost end report): voids raids
 * RAID_VOID_GRACE_MS past their ends_at (the wipe) (gear back to owners, pool items back to the pool) and expires loadout
 * locks nobody deployed. Both also run lazily on stash reads; this catches users who never return.
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const cronSecret = coreEnv().CRON_SECRET;
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const voided = await voidStale(db);
    const expired = await db.transaction((tx) => expireStaleLocks(tx));
    return NextResponse.json({ ok: true, voided, expiredLocks: expired });
  } catch (err) {
    console.error("[cron/void-raids] failed", err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
