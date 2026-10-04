import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { BcryptBusyError, burnPasswordCompare, verifyPassword } from "@/lib/password";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { clientIp, loginLimiter } from "@/lib/auth-rate-limit";

const bodySchema = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  password: z.string().min(1).max(128),
});

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { email, password } = parsed.data;

  const ip = clientIp(req);
  const gate = loginLimiter.begin(ip, email);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
    );
  }

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  const u = rows[0];
  let ok: boolean;
  try {
    ok = u ? await verifyPassword(password, u.passwordHash) : await burnPasswordCompare(password);
  } catch (e) {
    if (e instanceof BcryptBusyError) return busy();
    throw e;
  }
  if (!u || !ok) {
    loginLimiter.fail(email, ip);
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }
  loginLimiter.succeed(email, ip);

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

/** Too many password checks in flight (lib/password.ts BcryptGate). */
function busy() {
  return NextResponse.json({ error: "busy" }, { status: 503, headers: { "Retry-After": "2" } });
}
