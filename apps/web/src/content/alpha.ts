/**
 * Alpha rules (docs/ALPHA_PLAN.md B12, §5 "what we tell players"): the public /alpha page, the short
 * block on the register page and the Info panel link. Plain English, no promises of income: never
 * "play-to-earn", never "items are an investment".
 *
 * Fill in when decided: WIPE_DATE (UTC day, announced at least 7 days ahead) and BUG_CHANNEL_URL
 * (Telegram / Discord, B13). Until then the page says "to be announced".
 *
 * Two versions of the money copy: the main build has a test market balance (market, starter kit,
 * /economy); the iDos edition has none of that (lib/edition.ts SOL_ECONOMY, docs/IDOS_EDITION.md
 * §3.5), so its copy never mentions a balance, the market, a wallet or the Economy page.
 */
import { solEconomyEnabled } from "../lib/edition";

/** The alpha item wipe, "2026-11-15" (UTC day), or null while not announced. */
export const ALPHA_WIPE_DATE: string | null = null;

/** Public bug channel (B13), https only, or null while there is none. */
export const ALPHA_BUG_CHANNEL_URL: string | null = null;

/** "15 November 2026" or "to be announced". */
export function alphaWipeText(date: string | null = ALPHA_WIPE_DATE): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "to be announced";
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The three lines every entry point repeats (register block, landing). */
export function alphaShort(sol: boolean = solEconomyEnabled()): readonly string[] {
  return [
    sol ? "This is an alpha on a test balance. No real money goes in or out." : "This is an alpha test. No real money goes in or out.",
    "Nothing here can be cashed out — only exclusive rewards.",
    "One item wipe at the end of the alpha. Your level, cosmetics and Alpha Pass rewards stay.",
  ];
}

/** alphaShort() of this build. */
export const ALPHA_SHORT: readonly string[] = alphaShort();

/** The alpha in one line (menu Info panel, link to /alpha). */
export function alphaOneLine(sol: boolean = solEconomyEnabled()): string {
  return `Alpha test: ${sol ? "a test balance" : "no real money"}, nothing to earn, one item wipe at the end. Level, cosmetics and pass rewards stay.`;
}

/** Badge above the landing title. */
export function alphaBadge(sol: boolean = solEconomyEnabled()): string {
  return sol ? "ALPHA TEST · free · test balance →" : "ALPHA TEST · free to play →";
}

/** Copy of the /alpha page that depends on the build (the rest of the page is shared). */
export interface AlphaRulesCopy {
  description: string;
  shortFirst: string;
  /** The money section: anchor id, nav label, title, lines. */
  money: { id: string; nav: string; title: string; items: string[] };
  /** "No cash-out" lines before the "do not trade accounts" line. */
  earn: string[];
  /** Whether the page links the Economy page (main build only). */
  economyLink: boolean;
  wipeRemoves: string;
  dataAccount: string;
}

export function alphaRulesCopy(sol: boolean = solEconomyEnabled()): AlphaRulesCopy {
  if (sol) {
    return {
      description: "alpha rules: a test balance with no real money, nothing to earn, one item wipe at the end, and what you keep after it.",
      shortFirst: "It runs on a test balance. No real money goes in or out.",
      money: {
        id: "balance",
        nav: "Test balance",
        title: "A test balance, not real money",
        items: [
          "Your market balance in the alpha is test money. You cannot deposit real money and you cannot withdraw any.",
          "The starter kit and market trades are paid from that test balance, so the economy can be tested the way it will work later.",
          "CR (credits) is the in-game currency for traders and fees. It never turns into money.",
        ],
      },
      earn: [
        "The alpha has no payouts of any kind. Items, CR and the test balance have no cash value — what you earn are exclusive rewards: Alpha Pass titles, frames, name colours and the Alpha Veteran skin that stay with you forever.",
        "The game never pays anyone from its own wallet. Everything it takes in is shown on the Economy page.",
      ],
      economyLink: true,
      wipeRemoves: "The wipe removes items (stash, gear, listings), stacks of ammo and meds, CR and the test balance.",
      dataAccount:
        "Your email, nickname and a password hash (never the password itself), a wallet address if you link one, and your raids, kills, extracts and leaderboard stats.",
    };
  }
  return {
    description: "alpha rules: no real money, nothing to earn, one item wipe at the end, and what you keep after it.",
    shortFirst: "No real money goes in or out of the game.",
    money: {
      id: "money",
      nav: "No real money",
      title: "No real money in the game",
      items: [
        "Nothing in the game is bought or sold for real money: gear comes from raids and from the traders.",
        "CR (credits) is the in-game currency for traders. It never turns into money.",
      ],
    },
    earn: [
      "The alpha has no payouts of any kind. Items and CR have no cash value — what you earn are exclusive rewards: Alpha Pass titles, frames, name colours and the Alpha Veteran skin that stay with you forever.",
    ],
    economyLink: false,
    wipeRemoves: "The wipe removes items (stash and gear), stacks of ammo and meds, and CR.",
    dataAccount:
      "Your nickname and your iDos Games account id (or, if you sign up here directly, your email and a password hash — never the password itself), and your raids, kills, extracts and leaderboard stats.",
  };
}
