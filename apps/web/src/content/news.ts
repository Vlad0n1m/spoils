/**
 * Patch notes for the News panel (WORLD v6 D27) and the public /news page: a static list, newest
 * first. No CMS and no news table; add a post by adding an object at the top. `id` must be unique
 * (the News dot compares it, and /news uses it as the entry's anchor: /news#<id>).
 *
 * The menu panel shows `tag`, `date`, `title` and `body` as plain text. The optional fields are for
 * /news only: `tags` (extra labels), `intro` (a lead paragraph) and `sections` (headed bullet
 * lists). Those page-only strings may use `**bold**` and `[label](/path)` links; keep `body` plain.
 *
 * The iDos edition (lib/edition.ts SOL_ECONOMY off, docs/IDOS_EDITION.md §3.5) gets the same posts
 * without the wallet linking and treasury lines: it has no wallet, market or treasury.
 */
import { WORLD } from "@extract/shared";
import { solEconomyEnabled } from "../lib/edition";

export interface NewsSection {
  heading: string;
  items: string[];
}

export interface NewsPost {
  id: string;
  /** "2026-10-06" (UTC day). */
  date: string;
  title: string;
  tag: "update" | "event" | "fix";
  /** Short plain-text bullets: the whole post in the menu panel, the summary on /news. */
  body: string[];
  /** /news only: extra labels shown after `tag`, e.g. "alpha". */
  tags?: string[];
  /** /news only: a lead paragraph above the bullets. */
  intro?: string;
  /** /news only: headed detail lists under the bullets. */
  sections?: NewsSection[];
}

const CYCLE_MIN = Math.round(WORLD.CYCLE_MS / 60_000);
const CLOSE_MIN = Math.round(WORLD.ENTRY_CLOSE_MS / 60_000);
const GROUND_MIN = Math.round(WORLD.GROUND_EXPIRE_MS / 60_000);
const CORPSE_MIN = Math.round(WORLD.CORPSE_EXPIRE_MS / 60_000);
const ENTRIES = WORLD.MAX_ENTRIES_PER_CYCLE;

/** Every post for a build (`sol` = the main build's SOL economy). */
export function newsPosts(sol: boolean = solEconomyEnabled()): readonly NewsPost[] {
  const valuables = sol ? "Valuables go to the treasury" : "Valuables go back into the loot pool";
  return [
  {
    id: "2026-10-06-alpha",
    date: "2026-10-06",
    title: "Alpha is open: The Outskirts is always on",
    tag: "update",
    tags: ["alpha", "world"],
    intro: `The ${CYCLE_MIN}-minute world is here. **The Outskirts** is now one live map that never waits for a lobby to fill: drop in, loot what you can carry and get out before the wipe. This is an alpha, so expect rough edges, and tell us what breaks.`,
    body: [
      `No more queues. The Outskirts is one live map that wipes every ${CYCLE_MIN} minutes. Drop in whenever you like; entry closes ${CLOSE_MIN} minutes before the wipe.`,
      `Extract or die and you can drop in again on the same map with a fresh loadout, up to ${ENTRIES} times per map.`,
      "Bosses are now events, announced in the lobby before the map starts. A boss holds its spot until someone takes it down.",
      "Raids earn XP. Level up and climb the Level, Raider kills and NPC kills leaderboards.",
      sol
        ? "New main menu, touch controls for phones, a crosshair, and wallet linking with Sign-In with Solana."
        : "New main menu, touch controls for phones and a crosshair.",
      `Loose items vanish after ${GROUND_MIN} minutes on the ground and bodies after ${CORPSE_MIN} minutes. ${valuables}.`,
    ],
    sections: [
      {
        heading: "The world",
        items: [
          `**Always live.** One map runs all the time and wipes every ${CYCLE_MIN} minutes, on the clock. The lobby shows how long the current map has left.`,
          `**Drop-in raids.** Join a map that is already running. Entry closes ${CLOSE_MIN} minutes before the wipe, so nobody spawns into the last seconds.`,
          `**Come back in.** Extracted or died? Drop in again on the same map with a fresh loadout, up to ${ENTRIES} times per map.`,
          "**Caught in the wipe.** Anyone still on the map when it wipes loses what they carried in. Watch the countdown and the warnings.",
        ],
      },
      {
        heading: "Bosses",
        items: [
          "**Boss events.** Some maps get a boss. The lobby announces it before that map starts, along with the zone it will hold.",
          "**It stays put.** A boss holds its zone until someone takes it down, and the feed says who did.",
        ],
      },
      {
        heading: "Progress",
        items: [
          "**XP and levels.** Extracting, hauling loot out, opening containers and taking down marauders, guards, bosses and raiders all earn XP.",
          "**Leaderboards.** Climb the Level, Raider kills and NPC kills boards.",
        ],
      },
      {
        heading: "Menu and controls",
        items: [
          "**New main menu.** Play, your stash, the shop, News and the leaderboards live in one full-screen menu, with your level and XP up top.",
          "**Phone controls.** Move and aim sticks plus buttons for roll, use, reload, swap, bandage, medkit, inventory and the map. Play in landscape.",
          "**Crosshair.** On desktop the cursor over the game is a crosshair. On phones a reticle shows where your shots will land while you aim.",
        ],
      },
      ...(sol
        ? [
            {
              heading: "Wallet",
              items: [
                "**Sign-In with Solana.** Link a Solana wallet such as Phantom to your account from the account menu or the Wallet page. Your wallet signs a one-time message to prove it is yours.",
                "**Identity only.** Linking does not move funds and never asks you to sign a transaction. You can unlink at any time.",
              ],
            },
          ]
        : []),
      {
        heading: "Cleanup",
        items: [
          `**Ground loot.** Items left on the ground vanish after ${GROUND_MIN} minutes.`,
          `**Bodies.** Bodies vanish with their contents after ${CORPSE_MIN} minutes. ${valuables} instead of disappearing.`,
        ],
      },
    ],
  },
  ];
}

/** newsPosts() of this build. */
export const NEWS_POSTS: readonly NewsPost[] = newsPosts();

/** Id of the newest post, or null. */
export const LATEST_POST_ID: string | null = NEWS_POSTS[0]?.id ?? null;
