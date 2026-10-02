import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { verifyPassword } from "@/lib/password";

const bodySchema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { email, password } = parsed.data;

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }
  const u = rows[0]!;
  const ok = await verifyPassword(password, u.passwordHash);
  if (!ok) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const session = await getSession();
  session.guest = false;
  session.userId = u.id;
  session.nickname = u.nickname;
  await session.save();

  return NextResponse.json({
    status: "ok",
    user: {
      id: u.id,
      email: u.email,
      nickname: u.nickname,
      balanceCents: u.balanceCents.toString(),
      depositAddress: u.depositAddress,
      isGuest: false,
    },
  });
}
