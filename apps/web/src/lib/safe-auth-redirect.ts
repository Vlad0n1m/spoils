/** Post-login destination: only same-origin relative paths. */
export const DEFAULT_AUTH_REDIRECT = "/play";

export function safeAuthRedirect(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return DEFAULT_AUTH_REDIRECT;
  const t = raw.trim();
  if (!t.startsWith("/") || t.startsWith("//") || t.includes("\\")) {
    return DEFAULT_AUTH_REDIRECT;
  }
  return t;
}
