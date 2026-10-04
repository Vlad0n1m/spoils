// next.config `headers()` of both builds (security audit "security headers"): the main build sent
// none at all. Plain .mjs so next.config.mjs can import it (like edition-frame.mjs).
import { editionHeaders, isIdosBuildEnv } from "./edition-frame.mjs";

/**
 * Every page and route:
 *  - X-Content-Type-Options: nosniff, Referrer-Policy: strict-origin-when-cross-origin;
 *  - Strict-Transport-Security (production builds only, so a dev server never pins localhost to
 *    https; no includeSubDomains, the owner adds it once every subdomain is on https);
 *  - main build: `Content-Security-Policy: frame-ancestors 'self'` (no third-party framing:
 *    clickjacking of the market / wallet pages); the iDos edition keeps its own frame-ancestors
 *    list (editionHeaders). No X-Frame-Options in either build (docs/IDOS_EDITION.md §3).
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string; headers: { key: string; value: string }[] }[]}
 */
export function securityHeaders(env) {
  const common = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
  if (env.NODE_ENV === "production") common.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
  if (isIdosBuildEnv(env)) {
    return editionHeaders(env).map((e) => ({ source: e.source, headers: [...common, ...e.headers] }));
  }
  return [{ source: "/:path*", headers: [...common, { key: "Content-Security-Policy", value: "frame-ancestors 'self'" }] }];
}
