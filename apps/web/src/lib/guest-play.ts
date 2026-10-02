/** Fake balance for demo (no chain). $1,000.00 in US dollar cents. */
export const GUEST_DEMO_BALANCE_CENTS = 100_000n;

/** Local / dev sandbox — no wallet, no DB user. Toggle in .env. */
export function isGuestPlayEnabled(): boolean {
  return (
    process.env.GUEST_PLAY_ENABLED === "true" ||
    process.env.NEXT_PUBLIC_GUEST_PLAY === "1"
  );
}
