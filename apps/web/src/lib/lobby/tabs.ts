/** Lobby tabs of /play (`?tab=`). Plain module: the server page parses, the client shell renders. */
export const LOBBY_TABS = ["raid", "loadout", "stash", "market"] as const;
export type LobbyTab = (typeof LOBBY_TABS)[number];

export function parseLobbyTab(v: unknown): LobbyTab {
  return typeof v === "string" && (LOBBY_TABS as readonly string[]).includes(v) ? (v as LobbyTab) : "raid";
}
