import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { deriveDepositPubkey } from "@/lib/keypair";
import { hashPassword } from "@/lib/password";

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
  const session = await getSession();
  if (session.userId && !session.guest) {
    return NextResponse.json({ error: "already_logged_in" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(await req.json());
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

  const nickDup = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.nickname, nickname))
    .limit(1);
  if (nickDup.length > 0) {
    return NextResponse.json({ error: "nickname_taken" }, { status: 409 });
  }

  const passwordHash = await hashPassword(password);

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
