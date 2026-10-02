import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { isWalletDevTopupEnabled } from "@/lib/wallet-dev-topup";

export const dynamic = "force-dynamic";

/** $100.00 in cents for dev / explicitly enabled environments */
const ADD_CENTS = 10_000;

export async function POST() {
  if (!isWalletDevTopupEnabled()) {
    return NextResponse.json({ error: "disabled" }, { status: 403 });
  }

  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (session.guest) {
    return NextResponse.json({ error: "guest_not_supported" }, { status: 400 });
  }

  const [row] = await db
    .update(users)
    .set({
      balanceCents: sql`${users.balanceCents} + ${ADD_CENTS}`,
    })
    .where(eq(users.id, session.userId))
    .returning({ balanceCents: users.balanceCents });

  if (!row) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }

  return NextResponse.json({
    status: "ok" as const,
    balanceCents: row.balanceCents.toString(),
    addedCents: String(ADD_CENTS),
  });
}
