/**
 * Server-side check of an iDos Games session (docs/IDOS_EDITION.md §3.3, variant B). The iDos shell
 * (deploy/idos-shell) signs the player in with @idosgames/core and hands this edition the player's
 * iDos `UserID` and session ticket. We never trust that pair as is: we call an authenticated iDos
 * Client API endpoint with it, the way the SDK itself does, and accept the player only when iDos
 * answers Success.
 *
 * Endpoint (verified in @idosgames/core 0.21.1 and docs.idosgames.com API v2 · User):
 *   POST {base}/api/v2/{TitleID}/Client/User/GetUsageTime/{UserID}
 *   Authorization: Bearer {ClientSessionTicket}
 *   body { UserID, ClientSessionTicket }
 * → { Success, Error, Data }. 401 when the ticket is missing, invalid or expired.
 * GetUsageTime is the lightest read on that controller and changes nothing.
 * Not verified on a live Title yet: that iDos refuses a valid ticket of player A on the route of
 * player B (the deploy checklist in docs/IDOS_EDITION.md tests it on the DEV Title before launch).
 */

export const IDOS_API_BASE_DEFAULT = "https://api.idosgames.com";

/** 8 characters of [A-Z0-9], optionally `-DEV` (the Title's DEV sandbox). */
export const IDOS_TITLE_ID_RE = /^[A-Z0-9]{8}(-DEV)?$/;
/**
 * iDos UserIDs are hashes (SHA-256 of email + title, of device id…); their exact alphabet is not
 * documented, so accept the URL-safe set the SDK can put in a route segment, nothing else.
 */
export const IDOS_USER_ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
/** Session tickets are opaque; bound the size and forbid whitespace and control characters. */
export const IDOS_TICKET_RE = /^[\x21-\x7e]{16,4096}$/;

export interface IdosSessionClaim {
  titleId: string;
  userId: string;
  ticket: string;
}

export type IdosVerifyResult =
  | { ok: true }
  /** iDos says no (bad, expired or foreign ticket) or the claim is malformed. */
  | { ok: false; reason: "invalid" }
  /** Network error, timeout, 5xx or an unreadable answer: try again later, never sign in. */
  | { ok: false; reason: "unavailable" };

export interface IdosVerifyOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function isWellFormedClaim(c: IdosSessionClaim): boolean {
  return IDOS_TITLE_ID_RE.test(c.titleId) && IDOS_USER_ID_RE.test(c.userId) && IDOS_TICKET_RE.test(c.ticket);
}

/** The request we send (exported for tests). */
export function verifyRequest(c: IdosSessionClaim, baseUrl: string = IDOS_API_BASE_DEFAULT): { url: string; init: RequestInit } {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/api/v2/${c.titleId}/Client/User/GetUsageTime/${encodeURIComponent(c.userId)}`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${c.ticket}`,
        "X-IG-Platform": "Web",
      },
      body: JSON.stringify({ UserID: c.userId, ClientSessionTicket: c.ticket }),
      redirect: "error",
      cache: "no-store",
    },
  };
}

export async function verifyIdosSession(c: IdosSessionClaim, opts: IdosVerifyOptions = {}): Promise<IdosVerifyResult> {
  if (!isWellFormedClaim(c)) return { ok: false, reason: "invalid" };
  const { url, init } = verifyRequest(c, opts.baseUrl);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { ...init, signal: ctrl.signal });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid" };
    if (!res.ok) return { ok: false, reason: "unavailable" };
    const body = (await res.json().catch(() => null)) as { Success?: unknown } | null;
    if (!body || typeof body !== "object") return { ok: false, reason: "unavailable" };
    return body.Success === true ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The key stored in users.idos_user_id: one account per (Title, iDos player). */
export function idosAccountKey(titleId: string, userId: string): string {
  return `${titleId}/${userId}`;
}
