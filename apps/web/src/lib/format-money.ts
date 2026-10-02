const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const usdSubCent = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** @param cents — integer US dollar cents (can be from string/bigint) */
export function formatUsdCents(cents: bigint | string): string {
  const n = BigInt(cents);
  return usd.format(Number(n) / 100);
}

/**
 * In-game mass units → USD display (1e8 units = $1).
 * Uses extra fraction digits below one cent so orb pickups stay visible on low buy-ins.
 */
export function formatMassUnitsAsUsd(massUnits: string): string {
  const n = BigInt(massUnits);
  const dollars = Number(n) / 1e8;
  if (!Number.isFinite(dollars)) return usd.format(0);
  const a = Math.abs(dollars);
  if (a > 0 && a < 0.01) return usdSubCent.format(dollars);
  return usd.format(dollars);
}
