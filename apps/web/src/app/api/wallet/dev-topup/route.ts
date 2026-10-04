import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { moneyLedger, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { devTopupAllowedOnServer } from "@/lib/wallet-dev-topup-server";

export const dynamic = "force-dynamic";

/** $100.00 in cents for dev / explicitly enabled environments */
const ADD_CENTS = 10_000;

export async function POST() {
  // Production needs an explicit server-only demo switch off mainnet (lib/wallet-dev-topup-server.ts).
  if (!devTopupAllowedOnServer()) {
    return NextResponse.json({ error: "disabled" }, { status: 403 });
  }

  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.guest) {
    return NextResponse.json({ error: "guest_not_supported" }, { status: 400 });
  }

  const userId = session.userId;
  // Every top-up is journaled (money_ledger, reason dev_topup), so the admin reconciliation sees
  // minted balance instead of unexplained money.
  const row = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(users)
      .set({
        balanceCents: sql`${users.balanceCents} + ${ADD_CENTS}`,
      })
      .where(eq(users.id, userId))
      .returning({ balanceCents: users.balanceCents });
    if (!u) return null;
    await tx.insert(moneyLedger).values({ account: userId, deltaMinor: BigInt(ADD_CENTS), reason: "dev_topup", refId: randomUUID() });
    return u;
  });

  if (!row) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    status: "ok" as const,
    balanceCents: row.balanceCents.toString(),
    addedCents: String(ADD_CENTS),
  });
}
