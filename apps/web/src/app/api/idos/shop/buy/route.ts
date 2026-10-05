import { z } from "zod";
import { db } from "@/db/client";
import { buyProduct, type BuyResult } from "@/lib/idos/shop";
import { buyLimiter, rateLimited, reply, shopCaller } from "@/lib/idos/shop-route";
import { spoilsPrice } from "@/lib/idos/token-price";
import { IDOS_TICKET_RE } from "@/lib/idos/verify";
import { readJson } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  product: z.string().max(32),
  /** The client's idempotency key (uuid): a retried click finds its order instead of paying again. */
  requestId: z.string().uuid(),
  /** The player's current iDos session ticket (never stored); iDos checks it on every payment call. */
  ticket: z.string().regex(IDOS_TICKET_RE),
});

/** HTTP status of a refused or unfinished buy. */
function statusOf(r: Extract<BuyResult, { ok: false }>): number {
  switch (r.code) {
    case "bad_product":
    case "bad_request":
      return 400;
    case "invalid_session":
      return 401;
    case "insufficient_spoils":
      return 402;
    case "no_price":
    case "idos_unavailable":
      return 503;
    default:
      return r.status === "refund_owed" ? 502 : 409;
  }
}

/**
 * Buys one SPOILS shop product (lib/idos/shop.ts): the order is created (or found, for a replayed
 * requestId), paid from the player's iDos SPOILS balance through the Title store and verified
 * (lib/idos/store-pay.ts), then delivered in one transaction. → 200 { status: "delivered", order,
 * item?, message }; otherwise { error, status, message, order? }: 400 bad body / product, 401
 * invalid_session (iDos refused the ticket), 402 insufficient_spoils, 409 sold_out / daily_limit /
 * in_progress / store_missing, 429 rate_limited, 502 refund_owed (part was paid; nothing delivered,
 * the amount is on record for a refund), 503 no_price / idos_unavailable (retry with the same requestId).
 */
export async function POST(req: Request) {
  const who = await shopCaller(req, { post: true });
  if (!who.ok) return who.res;
  const gate = buyLimiter.take(who.userId);
  if (!gate.ok) return rateLimited(gate.retryAfterSec);
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return reply(400, { error: "bad_body", message: "Refresh the shop and try again." });
  const { product, requestId, ticket } = parsed.data;
  const r = await buyProduct(db, who.userId, { titleId: who.titleId, userId: who.idosUserId, ticket }, product, requestId, {
    price: () => spoilsPrice.get(),
  });
  if (r.ok) return reply(200, { status: r.status, order: r.order, ...(r.item ? { item: r.item } : {}), message: r.message, replay: r.replay });
  return reply(statusOf(r), { error: r.code, status: r.status, message: r.message, ...(r.order ? { order: r.order } : {}) });
}
