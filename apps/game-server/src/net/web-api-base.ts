const DEFAULT_DEV = "http://127.0.0.1:3001";

/**
 * Base URL of the Next app (HMAC calls). Must match the port in `apps/web` `dev` script.
 * Avoids `localhost` → `::1` with Node's fetch/undici when Next is only on IPv4.
 */
export function getWebApiBaseUrl(): string {
  const raw = process.env.WEB_API_BASE_URL?.trim();
  if (!raw) {
    return DEFAULT_DEV;
  }
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
