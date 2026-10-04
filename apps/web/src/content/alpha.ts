/**
 * Alpha rules (docs/ALPHA_PLAN.md B12, §5 "what we tell players"): the public /alpha page, the short
 * block on the register page and the Info panel link. Plain English, no promises of income: never
 * "play-to-earn", never "items are an investment".
 *
 * Fill in when decided: WIPE_DATE (UTC day, announced at least 7 days ahead) and BUG_CHANNEL_URL
 * (Telegram / Discord, B13). Until then the page says "to be announced".
 */

/** The alpha item wipe, "2026-11-15" (UTC day), or null while not announced. */
export const ALPHA_WIPE_DATE: string | null = null;

/** Public bug channel (B13), https only, or null while there is none. */
export const ALPHA_BUG_CHANNEL_URL: string | null = null;

/** "15 November 2026" or "to be announced". */
export function alphaWipeText(date: string | null = ALPHA_WIPE_DATE): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "to be announced";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The three lines every entry point repeats (register block, Info panel). */
export const ALPHA_SHORT = [
  "This is an alpha on a test balance. No real money goes in or out.",
  "Nothing here can be cashed out — only exclusive rewards.",
  "One item wipe at the end of the alpha. Your level, cosmetics and Alpha Pass rewards stay.",
] as const;
