import { sql } from "drizzle-orm";
import { type Connection, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { discriminator } from "../chain/program";
import { explorerUrl } from "../chain/config";
import type { Db } from "../inventory/db";
import type { OnchainConfig } from "./config";
import { LISTING_SIZE, decodeCoreAsset, decodeListing, decodeMarket, marketPda } from "./instructions";

/** One SPOILS item as the on-chain screens show it (game data joined to the asset). */
export interface ChainItemDto {
  asset: string;
  itemId: string;
  def: string;
  rarity: number;
  dur: number;
  maxDur: number;
  explorer: string;
}

export interface ChainListingDto extends ChainItemDto {
  seller: string;
  priceLamports: string;
  createdAt: number;
  mine: boolean;
}

export interface ChainOpDto {
  id: string;
  action: string;
  status: string;
  signature: string | null;
  explorer: string | null;
  lamports: string | null;
  def: string | null;
  rarity: number | null;
  error: string | null;
  at: number;
}

type ItemRow = { id: string; def_id: string; rarity: number; durability: number; max_durability: number; chain_asset: string };

async function itemsByAsset(db: Db, assets: string[]): Promise<Map<string, ItemRow>> {
  const out = new Map<string, ItemRow>();
  if (assets.length === 0) return out;
  const r = await db.execute<ItemRow>(sql`
    select id, def_id, rarity, durability, max_durability, chain_asset from items
    where chain_asset in (${sql.join(assets.map((a) => sql`${a}`), sql`, `)})`);
  for (const row of r.rows) out.set(row.chain_asset, row);
  return out;
}

function dto(asset: string, it: ItemRow, cluster: string): ChainItemDto {
  return {
    asset,
    itemId: it.id,
    def: it.def_id,
    rarity: Number(it.rarity),
    dur: Number(it.durability),
    maxDur: Number(it.max_durability),
    explorer: explorerUrl("address", asset, cluster),
  };
}

/**
 * SPOILS items in a wallet. The game knows every asset it ever minted (items.chain_asset), so it
 * reads those accounts directly (getMultipleAccounts, 100 per call) instead of scanning the Core
 * program, which public RPCs refuse.
 */
export async function walletItems(db: Db, conn: Connection, cfg: OnchainConfig, wallet: PublicKey): Promise<ChainItemDto[]> {
  const r = await db.execute<ItemRow>(sql`
    select id, def_id, rarity, durability, max_durability, chain_asset from items
    where state = 'onchain' and chain_asset is not null order by updated_at desc limit 1000`);
  const out: ChainItemDto[] = [];
  for (let i = 0; i < r.rows.length; i += 100) {
    const part = r.rows.slice(i, i + 100);
    const accs = await conn.getMultipleAccountsInfo(part.map((x) => new PublicKey(x.chain_asset)), "confirmed");
    accs.forEach((acc, j) => {
      const info = acc ? decodeCoreAsset(Buffer.from(acc.data)) : null;
      const row = part[j]!;
      if (info && info.owner.equals(wallet) && info.collection?.equals(cfg.collection)) out.push(dto(row.chain_asset, row, cfg.cluster));
    });
  }
  return out;
}

/** Open lots of the spoils_market program (its own small account set: a filtered scan is fine). */
export async function marketListings(db: Db, conn: Connection, cfg: OnchainConfig, viewer: PublicKey | null): Promise<ChainListingDto[]> {
  const accs = await conn.getProgramAccounts(cfg.marketProgram, {
    commitment: "confirmed",
    filters: [{ dataSize: LISTING_SIZE }, { memcmp: { offset: 0, bytes: bs58.encode(discriminator("account", "Listing")) } }],
  });
  const lots = accs.map((a) => decodeListing(Buffer.from(a.account.data))).filter((l) => l !== null);
  const items = await itemsByAsset(db, lots.map((l) => l.asset.toBase58()));
  const out: ChainListingDto[] = [];
  for (const l of lots) {
    const it = items.get(l.asset.toBase58());
    if (!it) continue;
    out.push({
      ...dto(l.asset.toBase58(), it, cfg.cluster),
      seller: l.seller.toBase58(),
      priceLamports: l.priceLamports.toString(),
      createdAt: l.createdAt * 1000,
      mine: viewer !== null && l.seller.equals(viewer),
    });
  }
  return out.sort((a, b) => (BigInt(a.priceLamports) < BigInt(b.priceLamports) ? -1 : 1));
}

export async function marketStats(conn: Connection, cfg: OnchainConfig) {
  const acc = await conn.getAccountInfo(marketPda(cfg.marketProgram), "confirmed");
  const m = acc ? decodeMarket(Buffer.from(acc.data)) : null;
  return m
    ? { feeBps: m.feeBps, listed: m.listed.toString(), sold: m.sold.toString(), volumeLamports: m.volumeLamports.toString() }
    : null;
}

export async function recentOps(db: Db, userId: string, cluster: string, limit = 12): Promise<ChainOpDto[]> {
  const r = await db.execute<{
    id: string;
    action: string;
    status: string;
    signature: string | null;
    lamports: string | null;
    def_id: string | null;
    rarity: number | null;
    error: string | null;
    created_at: Date;
  }>(sql`
    select o.id, o.action, o.status, o.signature, o.lamports, i.def_id, i.rarity, o.error, o.created_at
    from onchain_ops o left join items i on i.id = o.item_id
    where o.user_id = ${userId} and o.status <> 'prepared'
    order by o.created_at desc limit ${limit}`);
  return r.rows.map((o) => ({
    id: o.id,
    action: o.action,
    status: o.status,
    signature: o.signature,
    explorer: o.signature ? explorerUrl("tx", o.signature, cluster) : null,
    lamports: o.lamports,
    def: o.def_id,
    rarity: o.rarity === null ? null : Number(o.rarity),
    error: o.error && !o.error.startsWith("fresh_mint") ? o.error : o.error?.startsWith("fresh_mint: ") ? o.error.slice(12) : null,
    at: new Date(o.created_at).getTime(),
  }));
}
