/**
 * Base URL of the web API for HMAC calls, or null when WEB_API_BASE_URL is unset — then the game
 * server runs standalone and skips settlement (matches still finish).
 * `localhost` is rewritten to 127.0.0.1: Node's fetch may resolve it to ::1 while Next listens on IPv4.
 */
export function getWebApiBaseUrl(): string | null {
  const raw = process.env.WEB_API_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname === "::1") {
      u.hostname = "127.0.0.1";
    }
    const s = u.toString();
    return s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return raw.replace(/\/$/, "");
  }
}
