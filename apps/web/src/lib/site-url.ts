/**
 * Public origin of the site from NEXT_PUBLIC_SITE_URL (e.g. https://spoils.example), fixed at build
 * time. The root layout sets it as Next's metadataBase, so pages can send absolute og:url and
 * og:image values; unset, pages keep relative links only and send no og:image (Next would otherwise
 * resolve it against localhost).
 */
export function parseSiteUrl(raw: string | undefined | null): URL | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return null;
    return new URL(u.origin);
  } catch {
    return null;
  }
}

/** Keep `process.env.NEXT_PUBLIC_SITE_URL` spelled out: that literal is what Next inlines. */
export const SITE_URL: URL | null = parseSiteUrl(process.env.NEXT_PUBLIC_SITE_URL);
