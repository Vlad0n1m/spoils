import { db } from "@/db/client";
import { quoteShop } from "@/lib/idos/shop";
import { reply, shopCaller } from "@/lib/idos/shop-route";
import { spoilsPrice } from "@/lib/idos/token-price";

export const dynamic = "force-dynamic";

/**
 * SPOILS shop quotes for the signed-in iDos player (lib/idos/shop.ts): every product with its price
 * in US cents and in SPOILS at the live token price, stock and daily limits, and whether it can be
 * bought now. `spoilsPerCent` / `priceAt` are null while no token price is known (then nothing is
 * available). Edition only (404 in the main build).
 */
export async function GET(req: Request) {
  const who = await shopCaller(req, { post: false });
  if (!who.ok) return who.res;
  const q = await quoteShop(db, who.userId, await spoilsPrice.get());
  return reply(200, { ...q });
}
