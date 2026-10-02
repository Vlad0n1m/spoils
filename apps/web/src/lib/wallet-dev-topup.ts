/**
 * Test / dev credit: add $100 from the wallet UI. Off in production unless
 * NEXT_PUBLIC_WALLET_DEV_TOPUP is 1|true. Opt out in dev with 0|false.
 */
export function isWalletDevTopupEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_WALLET_DEV_TOPUP?.toLowerCase();
  if (v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  return process.env.NODE_ENV === "development";
}
