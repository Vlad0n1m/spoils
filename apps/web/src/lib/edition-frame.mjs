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
 * Sites allowed to frame the edition by default: idosgames.com and its www host only. The iDos
 * shell of our title lives at `https://<titleid>.idos.games`; add that exact origin through
 * IDOS_FRAME_ANCESTORS once the Title exists. Never `https://*.idos.games` by default: every
 * publisher uploads their own static build there, so a wildcard would let any other title frame the
 * signed-in edition (same partitioned cookie) and clickjack its buy and list buttons.
 * @type {readonly string[]}
 */
export const DEFAULT_IDOS_FRAME_ANCESTORS = Object.freeze(["https://idosgames.com", "https://www.idosgames.com"]);

/**
 * Wildcard sources (`https://*.host`) of a list: allowed only when IDOS_FRAME_ANCESTORS names them
 * on purpose; next.config.mjs warns at build time.
 * @param {readonly string[]} sources
 * @returns {string[]}
 */
export function wildcardSources(sources) {
  return sources.filter((s) => s.startsWith("https://*."));
}

/** https origin, optionally with one leading `*.` wildcard label and a port; no path. */
const HTTPS_SOURCE = /^https:\/\/(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;
/** Plain http is accepted only for a local test page that frames a local edition. */
const LOCAL_SOURCE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

/**
 * IDOS_FRAME_ANCESTORS: sources separated by spaces or commas that replace the defaults, e.g.
 * "https://idosgames.com https://www.idosgames.com https://<titleid>.idos.games". Unset or empty →
 * the defaults. A `https://*.host` wildcard is accepted (an explicit opt-in). Tokens that are not a
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

/** iDos Title id: 8 characters of [A-Z0-9], optionally with the DEV sandbox suffix `-DEV`. */
const TITLE_ID = /^[A-Z0-9]{8}(-DEV)?$/;

/**
 * IDOS_TITLE_IDS: the iDos Titles whose shell may sign players in, separated by spaces or commas,
 * e.g. "ABCD1234" (prod) or "ABCD1234-DEV" (the DEV sandbox) or both. Uppercased; anything else is
 * dropped. Empty → [] (the iDos sign-in bridge stays off).
 * @param {string | undefined | null} raw
 * @returns {string[]}
 */
export function parseIdosTitleIds(raw) {
  /** @type {string[]} */
  const out = [];
  for (const token of (raw ?? "").split(/[\s,]+/)) {
    const t = token.trim().toUpperCase();
    if (TITLE_ID.test(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Where iDos hosts a Title's static build (its shell): `https://{titleid}.idos.games`, the DEV copy at
 * `https://{titleid}-dev.idos.games` (lowercase: hostnames are case-insensitive and that is how the
 * platform's game host spells them).
 * @param {string} titleId
 * @returns {string}
 */
export function titleShellOrigin(titleId) {
  return `https://${titleId.toLowerCase()}.idos.games`;
}

/**
 * Shell origins of IDOS_TITLE_IDS: the only parents the edition accepts an iDos session from
 * (components/idos/idos-bridge.tsx), and frame-ancestors next to the defaults when
 * IDOS_FRAME_ANCESTORS is unset.
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function idosShellOrigins(env) {
  return parseIdosTitleIds(env.IDOS_TITLE_IDS).map(titleShellOrigin);
}

/**
 * The edition's frame-ancestors rule (security-headers.mjs adds the common headers). Main build: none.
 * Edition: a CSP that only sets frame-ancestors (it restricts nothing else). No X-Frame-Options is
 * sent: browsers that know frame-ancestors ignore it, and DENY/SAMEORIGIN would block old ones.
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string; headers: { key: string; value: string }[] }[]}
 */
export function editionHeaders(env) {
  if (!isIdosBuildEnv(env)) return [];
  const { sources, usedDefault } = parseFrameAncestors(env.IDOS_FRAME_ANCESTORS);
  // No explicit list: the defaults plus the exact shell origins of our own Titles (never a wildcard).
  if (usedDefault) for (const o of idosShellOrigins(env)) if (!sources.includes(o)) sources.push(o);
  return [
    {
      source: "/:path*",
      headers: [{ key: "Content-Security-Policy", value: frameAncestorsDirective(sources) }],
    },
  ];
}

/**
 * next.config `env`: the flag inlined into the client and the server bundles, plus the shell origins of
 * IDOS_TITLE_IDS (NEXT_PUBLIC_IDOS_SHELL_ORIGINS, space-separated) when set. Main build: {}.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function editionPublicEnv(env) {
  if (!isIdosBuildEnv(env)) return {};
  const shells = idosShellOrigins(env);
  return shells.length > 0
    ? { NEXT_PUBLIC_IDOS_BUILD: "1", NEXT_PUBLIC_IDOS_SHELL_ORIGINS: shells.join(" ") }
    : { NEXT_PUBLIC_IDOS_BUILD: "1" };
}
