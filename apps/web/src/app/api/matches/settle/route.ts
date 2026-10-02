import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db/client";
import {
  matchInstantPayouts,
  matches,
  matchParticipants,
  users,
} from "@/db/schema";
import { coreEnv } from "@/lib/env";
import { HEADERS } from "@extract/shared";

export const dynamic = "force-dynamic";

const partSchema = z.object({
  userId: z.string().uuid().nullable(),
  isBot: z.boolean(),
  entryCents: z.string().regex(/^\d+$/),
  payoutCents: z.string().regex(/^\d+$/),
  deltaCents: z.string().regex(/^-?\d+$/),
  exitType: z.enum(["extract", "dead", "timeout"]),
  exitOrder: z.number().int().nullable(),
});

const bodySchema = z.object({
  matchId: z.string().uuid(),
  entryTierCents: z.string().regex(/^\d+$/),
  startedAt: z.number(),
  endedAt: z.number(),
  participants: z.array(partSchema),
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

  await db.transaction(async (trx) => {
    // Idempotency: if match already exists in 'settled' state, skip.
    const existing = await trx
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(sql`${matches.id} = ${payload.matchId}::uuid`)
      .limit(1);
    if (existing[0]?.status === "settled") return;

    if (existing.length === 0) {
      await trx.insert(matches).values({
        id: payload.matchId,
        entryTierCents: BigInt(payload.entryTierCents),
        status: "settled",
        startedAt: new Date(payload.startedAt),
        endedAt: new Date(payload.endedAt),
      });
    } else {
      await trx
        .update(matches)
        .set({
          status: "settled",
          startedAt: new Date(payload.startedAt),
          endedAt: new Date(payload.endedAt),
        })
        .where(sql`${matches.id} = ${payload.matchId}::uuid`);
    }

    for (const p of payload.participants) {
      let nickname = p.isBot ? "bot" : "player";
      /** Row FK must reference `users` only for real DB accounts (guest Colyseus uuids are not inserted). */
      let creditUserId: string | null = p.userId;
      if (p.userId) {
        const u = await trx
          .select({ nickname: users.nickname })
          .from(users)
          .where(eq(users.id, p.userId))
          .limit(1);
        if (u[0]) {
          nickname = u[0].nickname;
        } else {
          creditUserId = null;
        }
      }
      await trx.insert(matchParticipants).values({
        matchId: payload.matchId,
        userId: creditUserId,
        isBot: p.isBot,
        nickname,
        entryCents: BigInt(p.entryCents),
        payoutCents: BigInt(p.payoutCents),
        deltaCents: BigInt(p.deltaCents),
        exitType: p.exitType,
        exitOrder: p.exitOrder,
      });
      if (creditUserId) {
        // Join /match already debited `entryCents`. Instant extract may have credited gross; true up
        // with (finalGrossPayout - alreadyCredited) so the ledger matches final `payoutCents`.
        const finalGross = BigInt(p.payoutCents);
        const paidRows = await trx
          .select({ c: matchInstantPayouts.payoutCents })
          .from(matchInstantPayouts)
          .where(
            and(
              eq(matchInstantPayouts.matchId, payload.matchId),
              eq(matchInstantPayouts.userId, creditUserId),
            ),
          )
          .limit(1);
        const alreadyCredited = paidRows[0]?.c ?? 0n;
        const delta = finalGross - alreadyCredited;
        if (delta !== 0n) {
          const d = delta.toString();
          await trx.execute(
            sql`UPDATE users
                SET balance_cents = GREATEST(0::bigint, balance_cents + ${d}::bigint)
                WHERE id = ${creditUserId}::uuid`,
          );
        }
      }
    }
  });

  return NextResponse.json({ ok: true });
}
