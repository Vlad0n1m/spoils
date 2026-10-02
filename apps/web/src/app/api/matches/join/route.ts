import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { getSession } from "@/lib/session";
import { ENTRY_TIERS_CENTS } from "@extract/shared";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  entryTierCents: z
    .string()
    .regex(/^\d+$/)
    .refine((s) => ENTRY_TIERS_CENTS.includes(BigInt(s)), "invalid_tier"),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session.userId || !session.nickname) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const tier = BigInt(parsed.data.entryTierCents);

  if (session.guest) {
    return NextResponse.json({
      ok: true,
      userId: session.userId,
      nickname: session.nickname,
      entryTierCents: tier.toString(),
      matchmakingRoomName: `mm_${tier.toString()}`,
    });
  }

  const debited = await db.transaction(async (trx) => {
    const result = await trx.execute(
      sql`UPDATE users
          SET balance_cents = balance_cents - ${tier.toString()}::bigint
          WHERE id = ${session.userId}::uuid AND balance_cents >= ${tier.toString()}::bigint
          RETURNING id`,
    );
    return ((result as any).rows ?? []).length > 0 || (result as any).rowCount > 0;
  });
  if (!debited) {
    return NextResponse.json({ error: "insufficient_funds" }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    userId: session.userId,
    nickname: session.nickname,
    entryTierCents: tier.toString(),
    matchmakingRoomName: `mm_${tier.toString()}`,
  });
}
