import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { getSession } from "@/lib/session";
import {
  GUEST_DEMO_BALANCE_CENTS,
  isGuestPlayEnabled,
} from "@/lib/guest-play";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { clientIp, guestLimiter } from "@/lib/auth-rate-limit";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

const bodySchema = z.object({
  nickname: z
    .string()
    .min(2)
    .max(16)
    .regex(/^[a-zA-Z0-9_]+$/, "letters, numbers, underscores only"),
});

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  if (!isGuestPlayEnabled()) {
    return NextResponse.json({ error: "guest_play_disabled" }, { status: 403 });
  }
  const gate = guestLimiter.take(clientIp(req));
  if (!gate.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { nickname } = parsed.data;
  // A guest never wears a registered player's name (any case): it reaches the map, the kill feed
  // and dog tags through the signed ticket (security audit).
  const taken = await db.execute(sql`select 1 from users where lower(nickname) = lower(${nickname}) limit 1`);
  if (taken.rows.length > 0) {
    return NextResponse.json({ error: "nickname_taken" }, { status: 409 });
  }

  const id = randomUUID();
  const session = await getSession();
  session.guest = true;
  session.userId = id;
  session.nickname = nickname;
  await session.save();

  return NextResponse.json({
    status: "ok",
    user: {
      id,
      email: "",
      nickname,
      balanceCents: GUEST_DEMO_BALANCE_CENTS.toString(),
      depositAddress: "",
      isGuest: true,
    },
  });
}
