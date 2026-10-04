/**
 * iDos Games edition: the build-time part (docs/IDOS_EDITION.md §3.1). Plain JS so that
 * next.config.mjs can import it at build time; lib/edition.ts re-exports it with types for the app
 * and the tests. Everything here is a no-op unless IDOS_BUILD=1 (or NEXT_PUBLIC_IDOS_BUILD=1):
 * the main build gets no extra headers and no extra env.
 */

/**
 * "1" or "true" (any case, trimmed) is on; anything else, unset or empty is off.
 * @param {string | undefined | null} v
 * @returns {boolean}
 */
export function flagOn(v) {
  const t = (v ?? "").trim().toLowerCase();
  return t === "1" || t === "true";
}

/**
 * Whether this is the iDos Games edition build. Read at build time by next.config.mjs.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isIdosBuildEnv(env) {
  return flagOn(env.IDOS_BUILD) || flagOn(env.NEXT_PUBLIC_IDOS_BUILD);
}

/**
 * Sites allowed to frame the edition: idosgames.com (the site and its www host) and the per-title
 * hosting `{titleid}.idos.games`, where the iDos shell around the game lives.
 * @type {readonly string[]}
 */
export const DEFAULT_IDOS_FRAME_ANCESTORS = Object.freeze([
  "https://idosgames.com",
  "https://www.idosgames.com",
  "https://*.idos.games",
]);

/** https origin, optionally with one leading `*.` wildcard label and a port; no path. */
const HTTPS_SOURCE = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
/** Plain http is accepted only for a local test page that frames a local edition. */
const LOCAL_SOURCE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * IDOS_FRAME_ANCESTORS: sources separated by spaces or commas, e.g.
 * "https://idosgames.com https://*.idos.games". Unset or empty → the defaults. Tokens that are not a
 * plain https origin (a bare `*`, `https:`, paths, quotes, `data:`…) are dropped and reported in
 * `rejected`; if nothing valid is left, the defaults are used, so a typo never opens the site to
 * every framer and never locks iDos out. A trailing slash is ignored; duplicates are removed.
 * @param {string | undefined | null} raw
 * @returns {{ sources: string[]; rejected: string[]; usedDefault: boolean }}
 */
export function parseFrameAncestors(raw) {
  const tokens = (raw ?? "")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  /** @type {string[]} */
  const sources = [];
  /** @type {string[]} */
  const rejected = [];
  for (const token of tokens) {
    const t = token.toLowerCase().replace(/\/$/, "");
    if (HTTPS_SOURCE.test(t) || LOCAL_SOURCE.test(t)) {
      if (!sources.includes(t)) sources.push(t);
    } else {
      rejected.push(token);
    }
  }
  if (sources.length === 0) return { sources: [...DEFAULT_IDOS_FRAME_ANCESTORS], rejected, usedDefault: true };
  return { sources, rejected, usedDefault: false };
}

/**
 * The CSP directive. 'self' stays so our own pages may still frame each other.
 * @param {readonly string[]} sources
 * @returns {string}
 */
export function frameAncestorsDirective(sources) {
  return ["frame-ancestors", "'self'", ...sources].join(" ");
}

/**
 * next.config `headers()` entries. Main build: none (the config does not even define headers()).
 * Edition: a CSP that only sets frame-ancestors (it restricts nothing else). No X-Frame-Options is
 * sent: browsers that know frame-ancestors ignore it, and DENY/SAMEORIGIN would block old ones.
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string; headers: { key: string; value: string }[] }[]}
 */
export function editionHeaders(env) {
  if (!isIdosBuildEnv(env)) return [];
  const { sources } = parseFrameAncestors(env.IDOS_FRAME_ANCESTORS);
  return [
    {
      source: "/:path*",
      headers: [{ key: "Content-Security-Policy", value: frameAncestorsDirective(sources) }],
    },
  ];
}

/**
 * next.config `env`: the flag inlined into the client and the server bundles. Main build: {}.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function editionPublicEnv(env) {
  return isIdosBuildEnv(env) ? { NEXT_PUBLIC_IDOS_BUILD: "1" } : {};
}
