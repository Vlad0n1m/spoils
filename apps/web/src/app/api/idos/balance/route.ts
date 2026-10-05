import { z } from "zod";
import { balanceLimiter, rateLimited, reply, shopCaller } from "@/lib/idos/shop-route";
import { readSpoilsBalance } from "@/lib/idos/store-pay";
import { IDOS_TICKET_RE } from "@/lib/idos/verify";
import { readJson } from "@/lib/lobby/route-helpers";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ ticket: z.string().regex(IDOS_TICKET_RE) });

/**
 * The signed-in iDos player's SPOILS game balance (iDos Blockchain/GetUserState →
 * CryptoBalances.Main.Amount), read with the player's own ticket. A POST because the ticket is a
 * credential: it travels in the body, never in a URL. → { spoils }; 401 invalid_session when iDos
 * refuses the ticket, 503 idos_unavailable when iDos does not answer. Edition only.
 */
export async function POST(req: Request) {
  const who = await shopCaller(req, { post: true });
  if (!who.ok) return who.res;
  const gate = balanceLimiter.take(who.userId);
  if (!gate.ok) return rateLimited(gate.retryAfterSec);
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return reply(400, { error: "bad_body" });
  const r = await readSpoilsBalance({ titleId: who.titleId, userId: who.idosUserId, ticket: parsed.data.ticket });
  if (r.ok) return reply(200, { spoils: r.spoils });
  if (r.reason === "invalid_session") return reply(401, { error: "invalid_session", message: "Your iDos session has expired. Reload the game." });
  return reply(503, { error: "idos_unavailable", message: "Could not read your SPOILS balance. Try again." });
}
