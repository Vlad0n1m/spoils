const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** @param cents — integer US dollar cents (can be from string/bigint) */
export function formatUsdCents(cents: bigint | string): string {
  const n = BigInt(cents);
  return usd.format(Number(n) / 100);
}
