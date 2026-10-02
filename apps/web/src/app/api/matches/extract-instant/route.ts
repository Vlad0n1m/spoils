import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import { matchInstantPayouts, users } from "@/db/schema";
import { coreEnv } from "@/lib/env";
import { HEADERS } from "@extract/shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  matchId: z.string().uuid(),
  userId: z.string().uuid(),
  payoutCents: z.string().regex(/^\d+$/),
});

const MAX_TIMESTAMP_SKEW_MS = 60_000;

export async function POST(req: Request) {
  const ts = req.headers.get(HEADERS.GAME_SERVER_TS);
  const sig = req.headers.get(HEADERS.GAME_SERVER_SIG);
  if (!ts || !sig) {
    return NextResponse.json({ error: "missing_signature" }, { status: 401 });
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > MAX_TIMESTAMP_SKEW_MS) {
    return NextResponse.json({ error: "stale_timestamp" }, { status: 401 });
  }

  const text = await req.text();
  const expected = createHmac("sha256", coreEnv().GAME_SERVER_HMAC_SECRET)
    .update(`${ts}.${text}`)
    .digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const payload = parsed.data;
  const add = BigInt(payload.payoutCents);
  if (add === 0n) {
    return NextResponse.json({ ok: true, credited: false });
  }

  await db.transaction(async (trx) => {
    const row = await trx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);
    if (!row[0]) {
      return;
    }

    const inserted = await trx
      .insert(matchInstantPayouts)
      .values({
        matchId: payload.matchId,
        userId: payload.userId,
        payoutCents: add,
      })
      .onConflictDoNothing()
      .returning({ matchId: matchInstantPayouts.matchId });

    if (inserted.length > 0) {
      await trx.execute(
        sql`UPDATE users
            SET balance_cents = GREATEST(0::bigint, balance_cents + ${payload.payoutCents}::bigint)
            WHERE id = ${payload.userId}::uuid`,
      );
    }
  });

  return NextResponse.json({ ok: true });
}
