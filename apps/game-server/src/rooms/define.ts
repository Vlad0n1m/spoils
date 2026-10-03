/**
 * Room registration of the game server (index.ts and the real-server tests share it). WORLD v6 has
 * no matchmaking: the only room type is the battle (world shard), created by the WorldDirectory,
 * and the only client matchmaking method is joinById (D4). create / join / joinOrCreate would let
 * anyone spawn rooms; reconnect is not used (rejoin goes through /api/world/join + joinById, B6).
 */

import { matchMaker } from "@colyseus/core";
import { ROOMS } from "@extract/shared";
import { BattleRoom } from "./battle-room.js";

export const EXPOSED_METHODS = ["joinById"] as const;

export function defineRooms(server: { define(name: string, klass: typeof BattleRoom): unknown }): void {
  matchMaker.controller.exposedMethods = [...EXPOSED_METHODS];
  server.define(ROOMS.BATTLE, BattleRoom);
}
