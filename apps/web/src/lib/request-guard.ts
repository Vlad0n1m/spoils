/**
 * CSRF guards. checkSameOriginRequest: routes that create or destroy a session (login, register,
 * guest, logout) and wallet linking call it themselves. These routes *set* the cookie, so even with
 * SameSite=Lax a cross-site `<form enctype="text/plain">` whose body happens to parse as JSON could
 * sign the victim into the attacker's account (or sign them out). The app's own fetch() calls are
 * same-origin and send `content-type: application/json`, which a form cannot do. checkApiMutation
 * (below, run by middleware.ts on every /api request) covers all other state-changing routes, which
 * matters in the iDos edition, whose session cookie is SameSite=None.
 */

export type GuardFailure = { status: 403 | 415; error: "cross_site" | "unsupported_media_type" };

function hostOf(origin: string): string | null {
  if (origin === "null") return null;
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Null when the request may proceed. `json: true` additionally requires an application/json body. */
export function checkSameOriginRequest(req: Request, opts: { json: boolean }): GuardFailure | null {
  const h = req.headers;
  // Fetch metadata (all current browsers): only the page itself ("same-origin") or a direct
  // user action ("none") may call these routes.
  const site = h.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return { status: 403, error: "cross_site" };

  const origin = h.get("origin");
  if (origin) {
    const from = hostOf(origin);
    const hosts = [h.get("host"), ...(h.get("x-forwarded-host") ?? "").split(",")]
      .map((s) => s?.trim().toLowerCase())
      .filter((s): s is string => !!s);
    if (!from || !hosts.includes(from)) return { status: 403, error: "cross_site" };
  }

  if (opts.json) {
    const type = (h.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return { status: 415, error: "unsupported_media_type" };
  }
  return null;
}

/**
 * Routes called server to server, authenticated by their own secret instead of the session cookie:
 * the game server (HMAC: raids/*, world/event, admin/replays/ingest) and the cron service (Bearer
 * CRON_SECRET). Only the ingest path itself: every other /api/admin route is a browser route. A Node
 * fetch may send no fetch metadata or an opaque Origin, so the browser CSRF check skips them.
 */
const SERVER_TO_SERVER_API = ["/api/raids/", "/api/world/event", "/api/cron/", "/api/admin/replays/ingest"] as const;
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** The body types an HTML form (or no-cors fetch) can send cross-site; the app's own API never uses them. */
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

export function isServerToServerApi(pathname: string): boolean {
  return SERVER_TO_SERVER_API.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`)));
}

/**
 * CSRF guard of every state-changing /api route (middleware.ts), in both builds. The main build's
 * SameSite=Lax cookie already stays off cross-site POSTs, but the iDos edition's cookie is
 * SameSite=None (it must work inside the idosgames.com iframe), so any site could otherwise make a
 * signed-in victim buy, list or withdraw with a `<form enctype="text/plain">` whose body parses as
 * JSON. Null when the request may proceed:
 * - GET/HEAD/OPTIONS and the server-to-server routes pass;
 * - a cross-site or foreign-Origin request is 403 (checkSameOriginRequest); the app's own fetch()
 *   calls, including those of the page inside the iDos iframe, are `sec-fetch-site: same-origin`;
 * - a form body type (urlencoded, multipart, text/plain) is 415, which also covers old browsers that
 *   send neither fetch metadata nor Origin. Bodiless POSTs (no content-type) stay allowed.
 */
export function checkApiMutation(req: Request, pathname = new URL(req.url).pathname): GuardFailure | null {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return null;
  if (isServerToServerApi(pathname)) return null;
  const cross = checkSameOriginRequest(req, { json: false });
  if (cross) return cross;
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (FORM_TYPES.has(type)) return { status: 415, error: "unsupported_media_type" };
  return null;
}
