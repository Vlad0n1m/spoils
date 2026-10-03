/**
 * Colyseus room state v2, synced server → clients at 20 Hz through per-client StateViews.
 * Static map geometry and static containers are NOT here: clients rebuild them with generateMap(id)
 * (MapData.containers is indexed; state carries only containerState[i]). Bullets are not here either.
 *
 * VIEW RULES (critique "Conflicts", measured with @colyseus/schema 3.0.76):
 * - Private data lives ONLY in root-level `@view()` maps of BattleState: players, self, items,
 *   corpses, loot. `@view(tag)` and `@view()` on any other field are forbidden — @view on a field of
 *   a public schema that is later removed from a view and mutated crashes the client decoder
 *   ("refId not found"). schema.test.ts fails if any other class carries view metadata.
 * - `self` is keyed `p<rosterIndex>` (stable across reconnects); each client adds only its own entry,
 *   and never removes it from its own view.
 */

import { ArraySchema, MapSchema, Schema, type, view } from "@colyseus/schema";

/** Player.act bit flags: what other players see you doing (remote animation + sound viz). */
export const ACT = {
  IDLE: 0,
  RELOAD: 1,
  HEAL: 2,
  EXTRACT: 4,
  ROLL: 8,
  LOOT: 16,
  WALK: 32,
} as const;

/**
 * Player.role values. 0 = a human player; everything else is an NPC (v5: there are no player-bots).
 * Boss / guard kind is in the nickname (BOSSES[kind].name / guardName); marauders are named
 * NPC_TAG.marauder (npc.ts), never a human-like nickname.
 */
export const NPC_ROLE = { NONE: 0, BOSS: 1, GUARD: 2, MARAUDER: 3 } as const;
export type NpcRole = (typeof NPC_ROLE)[keyof typeof NPC_ROLE];

/** BattleState.containerState values per MapData.containers index. */
export const CONTAINER_STATE = { UNTOUCHED: 0, OPENED: 1, EMPTIED: 2 } as const;

/** Self map key of a roster index. */
export function selfKeyOf(rosterIndex: number): string {
  return `p${rosterIndex}`;
}
/** Loot map key of a static container (MapData.containers index). */
export function containerLootKey(containerIdx: number): string {
  return `c${containerIdx}`;
}
/** Loot map key of a corpse (Corpse.id). */
export function corpseLootKey(corpseId: string): string {
  return `k${corpseId}`;
}

/** One inventory item instance: the same shape as ItemLike (inventory.ts) and SettledItem. */
export class InvItem extends Schema {
  /** DB item id for unique items, "" for fungible stacks. */
  @type("string") uid = "";
  /** ITEM_DEFS id. */
  @type("string") def = "";
  @type("uint16") qty = 1;
  @type("uint8") rarity = 0;
  /** Weapons 0..100 %; armor = remaining absorb points. */
  @type("float32") dur = 0;
  /** Weapons: rounds in the magazine. */
  @type("uint8") mag = 0;
  /** ITEM_FLAG bits (FREE, BROKEN). */
  @type("uint8") flags = 0;
  /** Dog tag: victim nickname. */
  @type("string") label = "";
  /** Dog tag: victim level (dogTagCr). */
  @type("uint8") lvl = 0;
  /**
   * Dog tag: victim self key "p<rosterIndex>". The server resolves it to the victim userId in the
   * exit report (24 h pair-repeat rule) — no DB ids in synced state.
   */
  @type("string") ref = "";
}

/** Public part of a player. In the `players` view map: synced only to clients that see them (LOS). */
export class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Palette index for the player's ring / name color. */
  @type("uint8") color = 0;
  /**
   * float64, not "number": @colyseus/schema encodes a fractional "number" as float32 whenever the
   * loss is < 1e-4 (all positions below ~1600 px), so the client would reconcile prediction from a
   * slightly different position than the server simulated (measured in views.test.ts).
   */
  @type("float64") x = 0;
  @type("float64") y = 0;
  /** Remote rendering only (own aim is local), so float32 precision is fine. */
  @type("number") aim = 0;
  @type("number") hp = 100;
  /** Armor level 0..3 (0 = none). */
  @type("uint8") armor = 0;
  /** Remaining armor absorb points (armor bar). */
  @type("number") armorDur = 0;
  /** Active weapon def ("" = none) and its rarity, for drawing the gun. */
  @type("string") weapon = "";
  @type("uint8") weaponRarity = 0;
  /** Backpack level 0..3 (sprite on the back). */
  @type("uint8") bp = 0;
  /** ACT bit flags. */
  @type("uint8") act = 0;
  @type("boolean") alive = true;
  @type("number") diedAt = 0;
  /** NPC_ROLE: 0 human player, 1 boss, 2 boss guard, 3 marauder (render + name color + HP bar). */
  @type("uint8") role = 0;
  /** HP bar maximum (PLAYER.MAX_HP; NPCs: BOSSES[kind].hp / guards[i].hp / MARAUDER[class].hp). */
  @type("uint16") maxHp = 100;
}

/**
 * Owner-only state (root `self` view map). Movement-critical fields (lastSeq, roll*) are written in
 * the same loop iteration so prediction reconciles against a consistent snapshot.
 */
export class SelfState extends Schema {
  @type("string") userId = "";
  @type("boolean") isBot = false;
  /** Last input seq applied by the server (client reconciliation). */
  @type("uint32") lastSeq = 0;
  /** SlotKey → item: w1 w2 armor bp p0..p3 b0..b15. */
  @type({ map: InvItem }) slots = new MapSchema<InvItem>();
  /** "w1" | "w2" */
  @type("string") active = "w1";
  /** Match clock (ms) when the current reload finishes; 0 = not reloading. */
  @type("number") reloadUntil = 0;
  /** Match clock (ms) when the current heal finishes; 0 = not healing. */
  @type("number") healUntil = 0;
  /** "bandage" | "medkit" | "" */
  @type("string") healKind = "";
  /**
   * RollState (movement.ts readRoll/writeRoll). dx/dy are explicit float64: a "number" in [-1, 1]
   * is always sent as float32, and the client replays the roll from these values (exact replay).
   */
  @type("uint8") rollLeft = 0;
  @type("uint8") rollCd = 0;
  @type("float64") rollDx = 0;
  @type("float64") rollDy = 0;
  /** Quiet walk held on the last applied input. */
  @type("boolean") walking = false;
  /** Loot map key being searched ("c<idx>" | "k<corpseId>"), "" = none. */
  @type("string") searching = "";
  /** Match clock when the open delay of the current search ends. */
  @type("number") searchReadyAt = 0;
  /** Match clock when the player entered an open extraction circle; 0 = not extracting. */
  @type("number") extractStartedAt = 0;
  @type("string") extractId = "";
  @type("number") extractedAt = 0;
  @type("uint8") kills = 0;
  /** MapSide 0..3 (N E S W). */
  @type("uint8") side = 0;
  /** Bit i = MapData.extracts[i] allowed for this player. */
  @type("uint8") extractMask = 0;
}

/** Item lying on the ground. AOI-filtered. uid / mag / dur live in the server runtime only. */
export class GroundItem extends Schema {
  @type("string") id = "";
  /** ITEM_DEFS id. */
  @type("string") def = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("uint16") qty = 1;
  @type("uint8") rarity = 0;
}

/** A dead player's body (dynamic container). AOI-filtered; contents go through `loot` k<id>. */
export class Corpse extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  /** Victim nickname. */
  @type("string") label = "";
  @type("uint8") color = 0;
  /** Death aim (body orientation). */
  @type("float32") rot = 0;
  /** Someone opened it at least once (body turned over). */
  @type("boolean") opened = false;
  /** Fully looted (renders as empty). */
  @type("boolean") empty = false;
}

/**
 * Contents of one container or corpse, searchers only (root `loot` view map, keyed c<idx> / k<id>).
 * Holds REVEALED items only, keyed by slot index "0".."total-1". Removed from a view on close.
 */
export class ContainerLoot extends Schema {
  @type({ map: InvItem }) slots = new MapSchema<InvItem>();
  @type("uint8") total = 0;
  @type("uint8") revealed = 0;
  /** Match clock of the next reveal; 0 = paused (nobody searching). */
  @type("number") nextRevealAt = 0;
}

export class Extract extends Schema {
  /** MapData.extracts[i].id */
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
  /** MapId ("steppe"). */
  @type("string") mapId = "steppe";
  /** Match seed: loot, bosses (NOT geometry in v2; legacy map uses it as the layout seed). */
  @type("uint32") mapSeed = 0;
  /** "drop" (extracts closed) | "open" (extracts open) | "ended" */
  @type("string") phase = "drop";
  /** Server wall-clock ms when the match started. */
  @type("number") startedAt = 0;
  /** Match clock in ms since start. */
  @type("number") clockMs = 0;
  @type("number") durationMs = 0;
  /** Replaces counting state.players (which now only holds visible players). */
  @type("uint8") aliveCount = 0;
  @type("uint8") totalPlayers = 0;
  /** Environment (environment.ts envConfigOf): fully determines weather, light and lightning. */
  @type("uint32") envSeed = 0;
  /** In-game start time, minutes since midnight. */
  @type("uint16") todStartMin = 720;
  /** "" = scheduled weather; else a WeatherKind forced for the raid (dev / events only). */
  @type("string") weatherOverride = "";
  /** Per MapData.containers index: CONTAINER_STATE. ~0.4 KB once for ~400 containers. */
  @type(["uint8"]) containerState = new ArraySchema<number>();
  /** LOS-filtered (VisionSystem). Keyed by sessionId. */
  @view() @type({ map: Player }) players = new MapSchema<Player>();
  /** Owner only. Keyed p<rosterIndex>. */
  @view() @type({ map: SelfState }) self = new MapSchema<SelfState>();
  /** AOI-filtered. */
  @view() @type({ map: GroundItem }) items = new MapSchema<GroundItem>();
  /** AOI-filtered. Keyed by Corpse.id. */
  @view() @type({ map: Corpse }) corpses = new MapSchema<Corpse>();
  /** Current searchers only. Keyed c<idx> / k<corpseId>. */
  @view() @type({ map: ContainerLoot }) loot = new MapSchema<ContainerLoot>();
  /** Unfiltered (few, static). */
  @type({ map: Extract }) extracts = new MapSchema<Extract>();
}

/** Every schema class (the no-@view lint and the codegen iterate this). */
export const SCHEMA_CLASSES = [InvItem, Player, SelfState, GroundItem, Corpse, ContainerLoot, Extract, BattleState] as const;
/** The only fields allowed to carry view metadata. */
export const VIEW_ROOT_FIELDS = ["players", "self", "items", "corpses", "loot"] as const;
