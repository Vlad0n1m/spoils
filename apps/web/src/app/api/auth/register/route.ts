import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { deriveDepositPubkey } from "@/lib/keypair";
import { BcryptBusyError, hashPassword } from "@/lib/password";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { clientIp, registerLimiter } from "@/lib/auth-rate-limit";

const bodySchema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  nickname: z
    .string()
    .min(2)
    .max(16)
    .regex(/^[a-zA-Z0-9_]+$/, "letters, numbers, underscores only"),
  password: z.string().min(8).max(128),
});

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  // Per-IP budget before any DB work or hash (security audit: account farming for world seats,
  // bcrypt floods, email probing). lib/auth-rate-limit.ts REGISTER_LIMITS.
  const gate = registerLimiter.take(clientIp(req));
  if (!gate.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
    );
  }
  const session = await getSession();
  if (session.userId && !session.guest) {
    return NextResponse.json({ error: "already_logged_in" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { email, nickname, password } = parsed.data;

  const emailDup = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (emailDup.length > 0) {
    return NextResponse.json({ error: "email_taken" }, { status: 409 });
  }

  // Case-insensitive (security audit): friend and party lookups match nicknames case-insensitively,
  // so "vLAD" next to "Vlad" would let an impostor receive requests meant for the original.
  const nickDup = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.nickname}) = lower(${nickname})`)
    .limit(1);
  if (nickDup.length > 0) {
    return NextResponse.json({ error: "nickname_taken" }, { status: 409 });
  }

  let passwordHash: string;
  try {
    passwordHash = await hashPassword(password);
  } catch (e) {
    if (e instanceof BcryptBusyError) {
      return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "2" } });
    }
    throw e;
  }

  const userId = randomUUID();
  let depositAddress: string;
  try {
    depositAddress = deriveDepositPubkey(userId);
  } catch {
    return NextResponse.json(
      {
        error: "server_misconfigured",
        detail:
          "Deposit key derivation failed. Set MASTER_SEED_HEX (64+ hex chars = 32+ bytes) on the server.",
      },
      { status: 503 },
    );
  }

  const [created] = await db
    .insert(users)
    .values({
      id: userId,
      email,
      passwordHash,
      nickname,
      depositAddress,
    })
    .returning();
  if (!created) {
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }

  session.guest = false;
  session.userId = created.id;
  session.nickname = nickname;
  await session.save();

  return NextResponse.json({
    status: "ok",
    user: {
      id: created.id,
      email: created.email,
      nickname,
      balanceCents: "0",
      depositAddress,
      isGuest: false,
    },
  });
}
