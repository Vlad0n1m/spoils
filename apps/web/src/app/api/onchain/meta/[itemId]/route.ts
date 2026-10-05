import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { isUuid } from "@/lib/inventory/transition";
import { describeItem } from "@/lib/items-ui";
import { SITE_URL } from "@/lib/site-url";

export const dynamic = "force-dynamic";

/**
 * Metaplex JSON metadata of a SPOILS item (the asset's uri): name, art and live game attributes.
 * Durability is read from the game, so wallets show the item's current state.
 */
export async function GET(req: Request, ctx: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await ctx.params;
  if (!isUuid(itemId)) return new Response("not found", { status: 404 });
  const r = await db.execute<{ def_id: string; rarity: number; durability: number; max_durability: number; chain_asset: string | null }>(
    sql`select def_id, rarity, durability, max_durability, chain_asset from items where id = ${itemId}`,
  );
  const it = r.rows[0];
  if (!it || !it.chain_asset) return new Response("not found", { status: 404 });
  const origin = SITE_URL?.origin ?? new URL(req.url).origin;
  const d = describeItem({ def: it.def_id, rarity: Number(it.rarity) });
  return Response.json(
    {
      name: `${d.rarityName} ${d.name}`.slice(0, 32),
      symbol: "SPOILS",
      description: `${d.rarityName} ${d.name} found and extracted in SPOILS. Bring it back into the game from your wallet at any time.`,
      image: `${origin}${d.icon}`,
      external_url: `${origin}/onchain`,
      attributes: [
        { trait_type: "Rarity", value: d.rarityName },
        { trait_type: "Item", value: d.name },
        { trait_type: "Durability", value: `${Math.round(Number(it.durability))}/${Math.round(Number(it.max_durability))}` },
      ],
      properties: { category: "image", files: [{ uri: `${origin}${d.icon}`, type: "image/png" }] },
    },
    { headers: { "cache-control": "public, max-age=60" } },
  );
}
