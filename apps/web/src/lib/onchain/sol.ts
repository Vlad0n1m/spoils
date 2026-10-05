/** SOL amounts for the on-chain UI and routes (client-safe: no keys, no RPC). */

export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "0.05 SOL" from lamports (trailing zeros trimmed, at most 4 decimals). */
export function formatSol(lamports: bigint | string | number): string {
  const v = BigInt(lamports);
  const whole = v / LAMPORTS_PER_SOL;
  const frac = (v % LAMPORTS_PER_SOL).toString().padStart(9, "0").slice(0, 4).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} SOL`;
}

/** "0.25" / "1" / "0,5" → lamports; null for anything that is not a positive amount (≤ 9 decimals, ≤ 1000 SOL). */
export function parseSol(text: string): bigint | null {
  const m = /^(\d{1,4})(?:[.,](\d{1,9}))?$/.exec(text.trim());
  if (!m) return null;
  const v = BigInt(m[1]!) * LAMPORTS_PER_SOL + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  return v > 0n && v <= 1000n * LAMPORTS_PER_SOL ? v : null;
}
