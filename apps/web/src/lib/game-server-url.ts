import { publicEnv } from "@/lib/env";

/** Set to an ISO2 code (e.g. `KZ`) to request that shard from `/api/game-server` if listed in `GAME_SERVER_URL_BY_COUNTRY`. */
export const GAME_SERVER_PREFER_COUNTRY_STORAGE_KEY =
  "extract:game-server-prefer-country";

let cached: string | undefined;
let inFlight: Promise<string> | undefined;

function preferCountryQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    const cc = localStorage
      .getItem(GAME_SERVER_PREFER_COUNTRY_STORAGE_KEY)
      ?.trim()
      .toUpperCase();
    if (cc && /^[A-Z]{2}$/.test(cc)) {
      return `?cc=${encodeURIComponent(cc)}`;
    }
  } catch {
    /* private mode */
  }
  return "";
}

/**
 * Resolves the Colyseus WebSocket URL (geo + `GAME_SERVER_URL_BY_COUNTRY` on the server),
 * with optional per-browser override via {@link GAME_SERVER_PREFER_COUNTRY_STORAGE_KEY} (ISO2).
 * Result is cached for the page lifetime.
 */
export async function resolveGameServerUrl(): Promise<string> {
  if (cached) return cached;
  if (!inFlight) {
    inFlight = (async () => {
      if (typeof window === "undefined") {
        return publicEnv.gameServerUrl;
      }
      try {
        const res = await fetch(
          `/api/game-server${preferCountryQuery()}`,
          { cache: "no-store" },
        );
        if (!res.ok) throw new Error(`game_server_http_${res.status}`);
        const j = (await res.json()) as { url?: unknown };
        if (typeof j?.url === "string" && j.url.length > 0) {
          cached = j.url;
          return j.url;
        }
      } catch {
        /* fall through */
      }
      cached = publicEnv.gameServerUrl;
      return cached;
    })().finally(() => {
      inFlight = undefined;
    });
  }
  return inFlight;
}
