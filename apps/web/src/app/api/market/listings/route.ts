import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { browseListings, expireListings, myListings, type ListingSort } from "@/lib/market/market";
import { MARKET_CATS, type MarketCat } from "@/lib/market/templates";
import { caller, json, marketConfig } from "@/lib/lobby/route-helpers";
import type { ListingsResponse } from "@/lib/lobby/api-types";

export const dynamic = "force-dynamic";

const SORTS: readonly ListingSort[] = ["price_asc", "price_desc", "newest", "rarity"];

/**
 * Open lots (`?cat=weapon|armor|backpack`, `?template=weapon:rifle:2`, `?sort=`), or the
 * caller's own lots with `?mine=1`. Anyone may browse; buying needs a registered account.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const c = await caller();
  const viewerId = c.kind === "user" ? c.userId : null;
  // Lazy expiry instead of a cron: cheap (index on status) and keeps the board honest.
  await expireListings(db);
  const mine = url.searchParams.get("mine") === "1";
  const catParam = url.searchParams.get("cat") ?? "all";
  const cat: MarketCat = (MARKET_CATS as readonly string[]).includes(catParam) ? (catParam as MarketCat) : "all";
  const sortParam = url.searchParams.get("sort") as ListingSort | null;
  const template = url.searchParams.get("template")?.slice(0, 40) || undefined;
  const rows =
    mine && viewerId
      ? await myListings(db, viewerId)
      : mine
        ? []
        : await browseListings(db, {
            viewerId,
            cat,
            template,
            sort: sortParam && SORTS.includes(sortParam) ? sortParam : "price_asc",
          });
  let balance: string | null = null;
  if (viewerId) {
    const b = await db.execute<{ balance_cents: string }>(sql`select balance_cents from users where id = ${viewerId}`);
    balance = String(b.rows[0]?.balance_cents ?? "0");
  }
  return json<ListingsResponse>({ listings: rows, market: marketConfig(), balance });
}
