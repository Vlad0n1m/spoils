import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { db } from "@/db/client";
import { matchResults } from "@/db/schema";
import { coreEnv } from "@/lib/env";
import { HEADERS, type MatchSettlementPayload } from "@extract/shared";

export const dynamic = "force-dynamic";

const itemRefSchema = z.object({
  uid: z.string().min(1).max(128),
  kind: z.enum(["weapon", "armor"]),
  type: z.string().min(1).max(32),
  rarity: z.number().int().min(0).max(3),
  level: z.number().int().min(0).max(3).optional(),
  /** Remaining armor durability (armor only); fractional after partial absorbs. */
  dur: z.number().finite().min(0).max(10_000).optional(),
});

const participantSchema = z.object({
  /** Registered and guest users are uuids today, but the economy may bring other ids — keep it loose. */
  userId: z.string().min(1).max(128).nullable(),
  nickname: z.string().max(64),
  isBot: z.boolean(),
  exitType: z.enum(["extract", "dead", "timeout"]),
  kills: z.number().int().min(0),
  extracted: z.array(itemRefSchema).max(32),
  lost: z.array(itemRefSchema).max(32),
});

const bodySchema = z.object({
  matchId: z.string().uuid(),
  mapSeed: z.number().int().min(0).max(0xffffffff),
  startedAt: z.number().finite(),
  endedAt: z.number().finite(),
  participants: z.array(participantSchema).max(64),
  /**
   * Valuables still on the map at the end (ground + unopened chests) — they go to the lost pool.
   * Required: a payload without it comes from an outdated game server and must not be stored.
   * Generous bound: every chest roll on a big map plus everything dropped by the dead.
   */
  leftOnMap: z.array(itemRefSchema).max(4096),
}) satisfies z.ZodType<MatchSettlementPayload>;

const MAX_TIMESTAMP_SKEW_MS = 60_000;

/**
 * Game server → web: final report of a raid. The server retries on failure, so this must be
 * idempotent: the first stored report for a matchId wins and repeats are acknowledged as ok.
 */
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

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "bad_body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const payload = parsed.data;

  const inserted = await db
    .insert(matchResults)
    .values({
      matchId: payload.matchId,
      mapSeed: payload.mapSeed,
      startedAt: new Date(payload.startedAt),
      endedAt: new Date(payload.endedAt),
      payload,
    })
    .onConflictDoNothing()
    .returning({ matchId: matchResults.matchId });

  return NextResponse.json({ ok: true, stored: inserted.length > 0 });
}
