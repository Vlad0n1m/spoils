import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db/client";
import { matchResults } from "@/db/schema";
import type { RecentRaidRow } from "@/lib/recent-raids";

export const dynamic = "force-dynamic";

const MATCH_LIMIT = 10;
const ROW_LIMIT = 12;

/**
 * Lobby board: latest human results from settled raids. Bots are left out — they fill demo
 * lobbies and would drown the real players.
 */
export async function GET() {
  try {
    const rows = await db
      .select({ payload: matchResults.payload, endedAt: matchResults.endedAt })
      .from(matchResults)
      .orderBy(desc(matchResults.endedAt))
      .limit(MATCH_LIMIT);

    const out: RecentRaidRow[] = [];
    for (const r of rows) {
      // Payloads are stored as sent; newer ones also carry `leftOnMap` (not shown here). Skip a
      // malformed row instead of failing the whole board.
      const participants = Array.isArray(r.payload?.participants) ? r.payload.participants : [];
      const humans = participants.filter((p) => !p.isBot);
      const humansExtracted = humans.filter((p) => p.exitType === "extract").length;
      for (const p of humans) {
        out.push({
          matchId: r.payload.matchId,
          endedAt: r.endedAt.getTime(),
          nickname: p.nickname,
          exitType: p.exitType,
          kills: p.kills,
          extracted: Array.isArray(p.extracted) ? p.extracted : [],
          humans: humans.length,
          humansExtracted,
        });
      }
    }
    return NextResponse.json(
      { rows: out.slice(0, ROW_LIMIT) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    // The lobby must render without a database (fresh checkout, guest-only demo).
    console.error("[recent] failed", e);
    return NextResponse.json({ rows: [] satisfies RecentRaidRow[], unavailable: true });
  }
}
