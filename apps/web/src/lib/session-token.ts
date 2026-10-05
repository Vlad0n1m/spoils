/**
 * Session carried in a header instead of a cookie (iDos edition, lib/session.ts): an iron-session
 * CookieStore over one value. iron-session reads the seal with get() and writes the new seal with
 * set() on save() / destroy(); the route hands `value` back to the client (sessionToken).
 */

/** The client has no session yet but wants one as a token (its first sign-in). */
export const NO_TOKEN = "none";

/**
 * `Authorization: Bearer <seal>` → the seal; `Bearer none` → "" (an empty token session); null when
 * absent or not a plausible seal (then the cookie is used, as in the main build).
 */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!m) return null;
  const token = m[1]!;
  if (token === NO_TOKEN) return "";
  // iron seals are "Fe26.2*…"; anything else (or something huge) is not ours.
  return token.length <= 4096 && token.startsWith("Fe26.2") ? token : null;
}

export class TokenCookieStore {
  constructor(
    private readonly name: string,
    public value: string,
  ) {}

  get(name: string): { name: string; value: string } | undefined {
    return name === this.name && this.value ? { name, value: this.value } : undefined;
  }

  set(nameOrOptions: string | { name: string; value: string }, value?: string): void {
    const name = typeof nameOrOptions === "string" ? nameOrOptions : nameOrOptions.name;
    const v = typeof nameOrOptions === "string" ? (value ?? "") : nameOrOptions.value;
    if (name === this.name) this.value = v;
  }
}
