import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { deriveDepositPubkey } from "@/lib/keypair";
import { checkSameOriginRequest } from "@/lib/request-guard";
import { clientIp, registerLimiter } from "@/lib/auth-rate-limit";
import { IDOS_ACCOUNT_EMAIL_DOMAIN, IDOS_BUILD, parseIdosTitleIds } from "@/lib/edition";
import { idosAccountKey, verifyIdosSession } from "@/lib/idos/verify";
import { nicknameBase } from "@/lib/idos/bridge-protocol";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const bodySchema = z.object({
  titleId: z.string().max(16),
  userId: z.string().max(128),
  ticket: z.string().max(4096),
  nickname: z.string().max(64).optional(),
});

function reply(status: number, body: Record<string, unknown>) {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * iDos sign-in bridge (docs/IDOS_EDITION.md §3.3): the edition page in the iDos shell's iframe posts
 * the iDos player's { titleId, userId, ticket } (components/idos/idos-bridge.tsx). The Title must be
 * one of IDOS_TITLE_IDS; iDos must accept the ticket (lib/idos/verify.ts). Then the player gets the
 * edition account made for that iDos account (users.idos_user_id), created on first visit with a
 * placeholder email at idos.invalid and no usable password, and a normal session cookie.
 *
 * Answers: { status: "same" } (the session already is that account, nothing changed),
 * "signed_in", "created"; 404 outside the edition (also middleware.ts), 503 not_configured /
 * idos_unavailable, 403 wrong_title, 401 invalid_session, 429 rate_limited.
 */
export async function POST(req: Request) {
  if (!IDOS_BUILD) return reply(404, { error: "not_found" });
  const blocked = checkSameOriginRequest(req, { json: true });
  if (blocked) return reply(blocked.status, { error: blocked.error });

  const titles = parseIdosTitleIds(process.env.IDOS_TITLE_IDS);
  if (titles.length === 0) return reply(503, { error: "not_configured" });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply(400, { error: "bad_body" });
  const { titleId, userId, ticket, nickname } = parsed.data;
  if (!titles.includes(titleId)) return reply(403, { error: "wrong_title" });
  const key = idosAccountKey(titleId, userId);

  // Already signed in as this iDos account: nothing to check, nothing to change (every page load of
  // the framed edition posts once; this keeps those calls off the iDos API).
  const session = await getSession();
  if (session.userId && !session.guest) {
    const [cur] = await db.select({ idos: users.idosUserId }).from(users).where(eq(users.id, session.userId)).limit(1);
    if (cur?.idos === key) return reply(200, { status: "same" });
  }

  const gate = registerLimiter.take(`idos:${clientIp(req)}`);
  if (!gate.ok) return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(gate.retryAfterSec) } });

  const verdict = await verifyIdosSession(
    { titleId, userId, ticket },
    { baseUrl: process.env.IDOS_API_BASE_URL?.trim() || undefined },
  );
  if (!verdict.ok) return verdict.reason === "invalid" ? reply(401, { error: "invalid_session" }) : reply(503, { error: "idos_unavailable" });

  const [existing] = await db.select({ id: users.id, nickname: users.nickname }).from(users).where(eq(users.idosUserId, key)).limit(1);
  if (existing) {
    session.guest = false;
    session.userId = existing.id;
    session.nickname = existing.nickname;
    await session.save();
    return reply(200, { status: "signed_in" });
  }

  const id = randomUUID();
  let depositAddress: string;
  try {
    // Required by the users table (unique); the edition never shows or uses it.
    depositAddress = deriveDepositPubkey(id);
  } catch {
    return reply(503, { error: "server_misconfigured" });
  }
  // No email of its own: a stable placeholder at the reserved .invalid domain (never deliverable).
  const email = `${createHash("sha256").update(key).digest("hex").slice(0, 32)}@${IDOS_ACCOUNT_EMAIL_DOMAIN}`;
  // Not a bcrypt hash, so no password ever matches it: the email/password login can't open this account.
  const passwordHash = `!idos:${randomBytes(16).toString("hex")}`;

  const base = nicknameBase(nickname);
  for (let attempt = 0; attempt < 6; attempt++) {
    const nick = attempt === 0 ? base : `${base}_${randomBytes(2).readUInt16BE(0) % 1000}`;
    const taken = await db.select({ id: users.id }).from(users).where(sql`lower(${users.nickname}) = lower(${nick})`).limit(1);
    if (taken.length > 0) continue;
    const created = await db
      .insert(users)
      .values({ id, email, passwordHash, nickname: nick, depositAddress, idosUserId: key })
      .onConflictDoNothing()
      .returning({ id: users.id });
    if (created.length === 0) {
      // A parallel request made the account (same idos key) or took the nickname: use theirs if any.
      const [raced] = await db.select({ id: users.id, nickname: users.nickname }).from(users).where(eq(users.idosUserId, key)).limit(1);
      if (!raced) continue;
      session.guest = false;
      session.userId = raced.id;
      session.nickname = raced.nickname;
      await session.save();
      return reply(200, { status: "signed_in" });
    }
    session.guest = false;
    session.userId = id;
    session.nickname = nick;
    await session.save();
    return reply(200, { status: "created" });
  }
  return reply(409, { error: "nickname_unavailable" });
}
