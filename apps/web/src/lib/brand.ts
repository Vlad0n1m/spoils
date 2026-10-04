import { brandFullName, editionLabel } from "./edition";

const NAME = "SPOILS";

/**
 * Product naming in one place (WORLD v6 D28). Neutral global brand: the game is SPOILS, its one
 * always-live map is The Outskirts. Change the name here, not in components.
 * `edition` is null in the main build and "iDos Games edition" in the IDOS_BUILD=1 build
 * (lib/edition.ts); `fullName` is the name with the edition ("SPOILS" in the main build).
 * `name` stays "SPOILS" in every build (logos, SIWS statement, page titles).
 */
export const BRAND = {
  name: NAME,
  mapName: "The Outskirts",
  edition: editionLabel(),
  fullName: brandFullName(NAME),
} as const;
