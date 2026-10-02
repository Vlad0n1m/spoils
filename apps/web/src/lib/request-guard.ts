/**
 * CSRF guard for routes that create or destroy a session (login, register, guest, logout).
 * SameSite=Lax keeps the cookie off cross-site POSTs, but these routes *set* the cookie, so a
 * cross-site `<form enctype="text/plain">` whose body happens to parse as JSON could sign the
 * victim into the attacker's account (or sign them out). The app's own fetch() calls are
 * same-origin and send `content-type: application/json`, which a form cannot do.
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
