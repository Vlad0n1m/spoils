/**
 * Colyseus room state, synced server → clients at 20 Hz.
 * Static map geometry is NOT here: clients rebuild it from `mapSeed` with generateMap().
 * Bullets are NOT here either: they are simulated on the server and announced with "shot" messages.
 */

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

export class WeaponSlot extends Schema {
  /** Item instance id ("" = empty slot). In the full economy this is the item's DB id. */
  @type("string") uid = "";
  /** WeaponId or "" when empty. */
  @type("string") weapon = "";
  /** Rarity 0..3. */
  @type("uint8") rarity = 0;
  /** Rounds in the magazine. */
  @type("uint8") mag = 0;
  /** Free-kit weapon: never breaks, never drops, worth nothing. */
  @type("boolean") free = false;
}

export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") userId = "";
  @type("string") nickname = "";
  @type("boolean") isBot = false;
  /** Palette index for the player's ring / name color. */
  @type("uint8") color = 0;

  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") aim = 0;
  /** Last input seq applied by the server (client reconciliation). */
  @type("uint32") lastSeq = 0;

  @type("number") hp = 100;
  /** Armor level 0..3 (0 = none). */
  @type("uint8") armor = 0;
  /** Remaining armor durability (damage points it can still absorb). */
  @type("number") armorDur = 0;
  @type("string") armorUid = "";

  /** Exactly two weapon slots. */
  @type([WeaponSlot]) slots = new ArraySchema<WeaponSlot>();
  @type("uint8") active = 0;
  @type("uint16") ammoLight = 0;
  @type("uint16") ammoShell = 0;
  @type("uint16") ammoHeavy = 0;
  @type("uint8") bandages = 0;
  @type("uint8") medkits = 0;

  /** Match clock (ms) when the current reload finishes; 0 = not reloading. */
  @type("number") reloadUntil = 0;
  /** Match clock (ms) when the current heal finishes; 0 = not healing. */
  @type("number") healUntil = 0;
  /** "bandage" | "medkit" | "" */
  @type("string") healKind = "";

  @type("boolean") alive = true;
  @type("number") diedAt = 0;
  /** Match clock when the player entered an open extraction circle; 0 = not extracting. */
  @type("number") extractStartedAt = 0;
  @type("string") extractId = "";
  @type("number") extractedAt = 0;
  @type("uint8") kills = 0;
}

export class GroundItem extends Schema {
  @type("string") id = "";
  /** GroundItemKind */
  @type("string") kind = "";
  @type("number") x = 0;
  @type("number") y = 0;
  /** kind = weapon */
  @type("string") weapon = "";
  @type("uint8") rarity = 0;
  @type("uint8") mag = 0;
  /** kind = armor: level 1..3 and remaining durability */
  @type("uint8") armor = 0;
  @type("number") armorDur = 0;
  /** kind = ammo: AmmoType */
  @type("string") ammoType = "";
  /** ammo rounds / bandage / medkit count */
  @type("uint16") qty = 0;
  /** Item instance id for weapons and armor (economy). */
  @type("string") uid = "";
}

export class Chest extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("uint8") rarity = 0;
  @type("boolean") opened = false;
}

export class Extract extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") r = 0;
  /** Match clock when it opens. */
  @type("number") openAt = 0;
  /** Match clock when it closes; 0 = stays open until the end. */
  @type("number") closeAt = 0;
}

export class BattleState extends Schema {
  @type("string") matchId = "";
  @type("uint32") mapSeed = 0;
  /** "drop" (extracts closed) | "open" (extracts open) | "ended" */
  @type("string") phase = "drop";
  /** Server wall-clock ms when the match started. */
  @type("number") startedAt = 0;
  /** Match clock in ms since start. */
  @type("number") clockMs = 0;
  @type("number") durationMs = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: GroundItem }) items = new MapSchema<GroundItem>();
  @type({ map: Chest }) chests = new MapSchema<Chest>();
  @type({ map: Extract }) extracts = new MapSchema<Extract>();
}
