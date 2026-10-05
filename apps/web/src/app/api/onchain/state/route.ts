import { sql } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { STARTER_KIT } from "@extract/shared";
import { db } from "@/db/client";
import { caller, json } from "@/lib/lobby/route-helpers";
import { kitsBoughtToday } from "@/lib/inventory/starter";
import { explorerUrl } from "@/lib/chain/config";
import { settlePendingOps } from "@/lib/onchain/ops";
import { marketStats, recentOps, walletItems } from "@/lib/onchain/reads";
import { chainDeps, opErrorResponse } from "@/lib/onchain/server";

export const dynamic = "force-dynamic";

/**
 * Everything /onchain shows for the caller: whether the feature is on, the linked wallet, game
 * items that can leave the game, SPOILS items in the wallet, the kit price, market totals and the
 * caller's recent on-chain operations (with explorer links). Settles the caller's unconfirmed ops first.
 */
export async function GET(req: Request) {
  const deps = chainDeps(req);
  if (!deps) return json({ enabled: false });
  const { cfg, connection } = deps;
  const c = await caller();
  const userId = c.kind === "user" ? c.userId : null;
  const base = {
    enabled: true,
    cluster: cfg.cluster,
    collection: cfg.collection.toBase58(),
    collectionExplorer: explorerUrl("address", cfg.collection.toBase58(), cfg.cluster),
    marketProgram: cfg.marketProgram.toBase58(),
    marketExplorer: explorerUrl("address", cfg.marketProgram.toBase58(), cfg.cluster),
    minRarity: cfg.minRarity,
    kit: { lamports: cfg.kitLamports.toString(), dailyMax: STARTER_KIT.DAILY_MAX },
  };
  try {
    const market = await marketStats(connection, cfg).catch(() => null);
    if (!userId) return json({ ...base, market, signedIn: false });
    await settlePendingOps(db, connection, userId).catch((e) => console.warn("[onchain] settle", e));
    const u = await db.execute<{ wallet_pubkey: string | null }>(sql`select wallet_pubkey from users where id = ${userId}`);
    const wallet = u.rows[0]?.wallet_pubkey ?? null;
    const eligible = await db.execute<{ id: string; def_id: string; rarity: number; durability: number; max_durability: number; chain_asset: string | null }>(sql`
      select id, def_id, rarity, durability, max_durability, chain_asset from items
      where owner_id = ${userId} and state = 'in_stash' and not bound and lock_raids = 0
        and durability > 0 and rarity >= ${cfg.minRarity}
      order by rarity desc, updated_at desc limit 60`);
    const [inWallet, ops, boughtToday, balance] = await Promise.all([
      wallet ? walletItems(db, connection, cfg, new PublicKey(wallet)) : Promise.resolve([]),
      recentOps(db, userId, cfg.cluster),
      kitsBoughtToday(db, userId),
      wallet ? connection.getBalance(new PublicKey(wallet), "confirmed").catch(() => null) : Promise.resolve(null),
    ]);
    return json({
      ...base,
      market,
      signedIn: true,
      wallet,
      walletLamports: balance === null ? null : String(balance),
      walletExplorer: wallet ? explorerUrl("address", wallet, cfg.cluster) : null,
      eligible: eligible.rows.map((r) => ({
        itemId: r.id,
        def: r.def_id,
        rarity: Number(r.rarity),
        dur: Number(r.durability),
        maxDur: Number(r.max_durability),
        minted: r.chain_asset !== null,
      })),
      inWallet,
      ops,
      kitBoughtToday: boughtToday,
    });
  } catch (e) {
    return opErrorResponse(e);
  }
}
