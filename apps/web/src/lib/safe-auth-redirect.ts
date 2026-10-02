/** Post-login destination: only same-origin relative paths. */
export const DEFAULT_AUTH_REDIRECT = "/play";

/** Placeholder origin used only to resolve `raw`; anything that escapes it is rejected. */
const PROBE_ORIGIN = "http://auth-redirect.invalid";

export function safeAuthRedirect(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_AUTH_REDIRECT;
  const t = raw.trim();
  // Control chars / whitespace are stripped by the WHATWG URL parser ("/\t/evil.com" → "//evil.com").
  if (/[\u0000-\u001F\u007F\s\\]/.test(t)) return DEFAULT_AUTH_REDIRECT;
  if (!t.startsWith("/") || t.startsWith("//")) return DEFAULT_AUTH_REDIRECT;
  let u: URL;
  try {
    u = new URL(t, PROBE_ORIGIN);
  } catch {
    return DEFAULT_AUTH_REDIRECT;
  }
  // Dot-segment normalization can itself yield a protocol-relative path ("/.//evil.com" → "//evil.com").
  if (u.origin !== PROBE_ORIGIN || u.pathname.startsWith("//")) return DEFAULT_AUTH_REDIRECT;
  return u.pathname + u.search + u.hash;
}
