/**
 * Patch notes for the News panel (WORLD v6 D27): a static list, newest first. No CMS and no news
 * table; add a post by adding an object at the top. `id` must be unique (the News dot compares it).
 */
import { WORLD } from "@extract/shared";

export interface NewsPost {
  id: string;
  /** "2026-10-06" (UTC day). */
  date: string;
  title: string;
  tag: "update" | "event" | "fix";
  body: string[];
}

const CYCLE_MIN = Math.round(WORLD.CYCLE_MS / 60_000);
const CLOSE_MIN = Math.round(WORLD.ENTRY_CLOSE_MS / 60_000);
const GROUND_MIN = Math.round(WORLD.GROUND_EXPIRE_MS / 60_000);
const CORPSE_MIN = Math.round(WORLD.CORPSE_EXPIRE_MS / 60_000);

export const NEWS_POSTS: readonly NewsPost[] = [
  {
    id: "2026-10-06-world",
    date: "2026-10-06",
    title: "The Outskirts is always on: 45-minute maps, boss events, XP and leaderboards",
    tag: "update",
    body: [
      `No more queues. The Outskirts is one live map that wipes every ${CYCLE_MIN} minutes. Drop in whenever you like; entry closes ${CLOSE_MIN} minutes before the wipe.`,
      "Extract or die and you can drop in again on the same map, with a fresh loadout, up to 4 times per map.",
      "Bosses are now events: about one map in three, announced right here in the lobby. The boss holds its spot until someone takes it down.",
      "Raids earn XP: extracts, hauls, containers, marauders, guards, bosses and raiders. Level up and climb the Level, Raider kills and NPC kills boards.",
      `Loose items vanish after ${GROUND_MIN} minutes on the ground and bodies after ${CORPSE_MIN} minutes. Valuables go to the treasury.`,
    ],
  },
];

/** Id of the newest post, or null. */
export const LATEST_POST_ID: string | null = NEWS_POSTS[0]?.id ?? null;
