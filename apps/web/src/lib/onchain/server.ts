import { chainConnection } from "../chain/sender";
import { loadChainAuthority } from "../chain/config";
import { SITE_URL } from "../site-url";
import { apiError } from "../lobby/route-helpers";
import { onchainConfig } from "./config";
import { OpError, type ChainDeps, type OpErr } from "./ops";

/** Route wiring: config + RPC + authority, or null when the feature is off. */
export function chainDeps(req: Request): ChainDeps | null {
  const cfg = onchainConfig();
  const auth = loadChainAuthority();
  if (!cfg || !auth) return null;
  const origin = SITE_URL?.origin ?? new URL(req.url).origin;
  return { cfg, authority: auth.keypair, connection: chainConnection(cfg.rpcUrl, 10_000), origin };
}

export const OFF = () => apiError(503, "onchain_off", "On-chain items are not enabled on this server.");

const STATUS: Record<OpErr, number> = {
  no_wallet: 409,
  not_found: 404,
  not_eligible: 409,
  not_owner: 409,
  not_spoils: 409,
  not_listed: 404,
  own_listing: 409,
  bad_price: 400,
  daily_limit: 429,
  sale_paused: 503,
  bad_signature: 400,
  gone: 409,
  chain_error: 502,
};

/** OpError → its HTTP answer; anything else is a chain/RPC failure reported without internals. */
export function opErrorResponse(e: unknown) {
  if (e instanceof OpError) return apiError(STATUS[e.code], e.code, e.message);
  console.error("[onchain]", e);
  return apiError(502, "chain_error", "Solana did not answer in time. Try again in a moment.");
}
