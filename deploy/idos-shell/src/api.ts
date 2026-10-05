/**
 * The client's way to our backend (vite.config.ts: __SPOILS_API_URL__). The web app calls its API as
 * fetch("/api/…"); here every such call goes to the API origin with the session as a bearer token
 * (apps/web lib/session.ts) and never with cookies, which are third-party on this origin.
 */

declare const __SPOILS_API_URL__: string;

export const API_URL: string = __SPOILS_API_URL__.replace(/\/+$/, "");

const storageKey = (titleId: string) => `spoils:idos:token:${titleId}`;
let tokenKey = "";
let token = "";

export function loadToken(titleId: string): string {
  tokenKey = storageKey(titleId);
  try {
    token = localStorage.getItem(tokenKey) ?? "";
  } catch {
    token = "";
  }
  return token;
}

export function saveToken(next: string): void {
  token = next;
  try {
    if (next) localStorage.setItem(tokenKey, next);
    else localStorage.removeItem(tokenKey);
  } catch {
    /* private mode: the token lives for this page only */
  }
}

/** Header value for the API: the token, or "none" so the server answers with a new one. */
export function authorization(): string {
  return `Bearer ${token || "none"}`;
}

/** A page of our own site ("/news") as an absolute URL on the API origin. */
export function externalHref(path: string): string {
  return `${API_URL}${path}`;
}

export function installApiFetch(): void {
  const native = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input instanceof URL ? null : null;
    if (path === null || !path.startsWith("/api/")) return native(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", authorization());
    const res = native(`${API_URL}${path}`, { ...init, headers, credentials: "omit" });
    // Sign-out: a token session cannot be revoked server-side; forgetting it is the sign-out.
    if (path.startsWith("/api/auth/logout")) void res.finally(() => saveToken(""));
    return res;
  };
}
