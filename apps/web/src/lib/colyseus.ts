"use client";

import { Client } from "colyseus.js";
import { resolveGameServerUrl } from "@/lib/game-server-url";

let client: Client | undefined;
let initPromise: Promise<Client> | undefined;

/**
 * Resolves the Colyseus client once per page load (URL from `/api/game-server`
 * with geo or `GAME_SERVER_URL_BY_COUNTRY`, see `resolveGameServerUrl`).
 */
export function getColyseusClient(): Promise<Client> {
  if (client) return Promise.resolve(client);
  if (!initPromise) {
    initPromise = (async () => {
      const url = await resolveGameServerUrl();
      if (!client) {
        client = new Client(url);
      }
      return client;
    })();
  }
  return initPromise;
}
