import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { GUEST_DEMO_BALANCE_CENTS } from "@/lib/guest-play";

export async function GET() {
  const session = await getSession();
  if (session.guest && session.userId && session.nickname) {
    return NextResponse.json({
      user: {
        id: session.userId,
        email: "",
        nickname: session.nickname,
        balanceCents: GUEST_DEMO_BALANCE_CENTS.toString(),
        depositAddress: "",
        isGuest: true,
      },
    });
  }
  if (!session.userId) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (rows.length === 0) {
    session.destroy();
    return NextResponse.json({ user: null }, { status: 200 });
  }
  const u = rows[0]!;
  return NextResponse.json({
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
