import { sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { db } from "@/db/client";
import { caller, json } from "@/lib/lobby/route-helpers";
import { marketListings } from "@/lib/onchain/reads";
import { chainDeps, opErrorResponse } from "@/lib/onchain/server";

export const dynamic = "force-dynamic";

/** Open lots of the on-chain SOL market (read from the spoils_market program, joined to game data). */
export async function GET(req: Request) {
  const deps = chainDeps(req);
  if (!deps) return json({ enabled: false, listings: [] });
  const c = await caller();
  let viewer: PublicKey | null = null;
  if (c.kind === "user") {
    const u = await db.execute<{ wallet_pubkey: string | null }>(sql`select wallet_pubkey from users where id = ${c.userId}`);
    const w = u.rows[0]?.wallet_pubkey;
    if (w) viewer = new PublicKey(w);
  }
  try {
    return json({ enabled: true, listings: await marketListings(db, deps.connection, deps.cfg, viewer) });
  } catch (e) {
    return opErrorResponse(e);
  }
}
