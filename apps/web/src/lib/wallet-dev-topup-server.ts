import { isProductionRuntime } from "./env";

type EnvSource = Record<string, string | undefined>;

const on = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const off = (v: string | undefined) => v === "0" || v?.toLowerCase() === "false";

/**
 * Server gate of POST /api/wallet/dev-topup (security audit: production could mint unlimited real
 * buying power with one public flag). The public flag NEXT_PUBLIC_WALLET_DEV_TOPUP decides as in
 * wallet-dev-topup.ts (on in dev unless 0|false); a production runtime additionally needs the
 * server-only WALLET_DEV_TOPUP_PRODUCTION=1 (a demo stack, on purpose) and a cluster that is not
 * mainnet-beta. deploy/web-preflight.mjs refuses to start a production web that breaks this.
 */
export function devTopupAllowedOnServer(env: EnvSource = process.env): boolean {
  const flag = env.NEXT_PUBLIC_WALLET_DEV_TOPUP;
  const enabled = on(flag) || (!off(flag) && env.NODE_ENV === "development");
  if (!enabled) return false;
  if (!isProductionRuntime(env)) return true;
  const mainnet = env.SOLANA_CLUSTER?.trim() === "mainnet-beta" || env.NEXT_PUBLIC_SOLANA_CLUSTER?.trim() === "mainnet-beta";
  return on(env.WALLET_DEV_TOPUP_PRODUCTION) && !mainnet;
}
