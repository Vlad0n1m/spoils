/**
 * iDos Games edition (docs/IDOS_EDITION.md): the same app built with IDOS_BUILD=1, which
 * next.config.mjs inlines as NEXT_PUBLIC_IDOS_BUILD=1. The edition runs on its own subdomain and DB
 * (deploy/idos.compose.yml) and is shown in an iframe on idosgames.com. With the flag off (the
 * default) every helper here returns the main build's behaviour unchanged.
 */

export {
  DEFAULT_IDOS_FRAME_ANCESTORS,
  editionHeaders,
  editionPublicEnv,
  flagOn,
  frameAncestorsDirective,
  idosShellOrigins,
  isIdosBuildEnv,
  parseFrameAncestors,
  parseIdosTitleIds,
  titleShellOrigin,
  wildcardSources,
} from "./edition-frame.mjs";
import { flagOn } from "./edition-frame.mjs";

/** Shown after the game name in the edition: "SPOILS — iDos Games edition". */
export const IDOS_EDITION_LABEL = "iDos Games edition";

/**
 * Build flag of this bundle. The literal `process.env.NEXT_PUBLIC_IDOS_BUILD` is what Next inlines,
 * so keep it spelled out here (no destructuring, no dynamic key).
 */
export const IDOS_BUILD: boolean = flagOn(process.env.NEXT_PUBLIC_IDOS_BUILD);

/** Edition label of a build: null in the main build. */
export function editionLabel(idosBuild: boolean = IDOS_BUILD): string | null {
  return idosBuild ? IDOS_EDITION_LABEL : null;
}

/** "SPOILS" in the main build, "SPOILS — iDos Games edition" in the edition. */
export function brandFullName(name: string, idosBuild: boolean = IDOS_BUILD): string {
  const label = editionLabel(idosBuild);
  return label ? `${name} — ${label}` : name;
}

export interface EditionCookieOverrides {
  sameSite?: "none";
  secure?: true;
  partitioned?: true;
}

/**
 * Session cookie attributes on top of the main ones (lib/session.ts). Main build: none (SameSite=Lax
 * and the usual Secure rule stay). Edition: the page lives in a cross-site iframe, where a Lax cookie
 * is never sent, so SameSite=None; browsers drop SameSite=None without Secure, so Secure is forced
 * (Chrome and Firefox treat http://localhost as secure, so local tests still work); Partitioned
 * (CHIPS) keeps the cookie working where third-party cookies are being phased out. The partitioned
 * cookie belongs to the idosgames.com top-level site only; opening the edition's subdomain directly
 * starts a separate sign-in.
 */
export function editionSessionCookie(idosBuild: boolean = IDOS_BUILD): EditionCookieOverrides {
  if (!idosBuild) return {};
  return { sameSite: "none", secure: true, partitioned: true };
}

/** The part of `window` that isFramed reads (so tests can pass a stub). */
export interface FrameWindow {
  readonly self: unknown;
  readonly top: unknown;
}

/**
 * Whether the page runs inside a frame (window.top !== window.self). Comparing the two references
 * is allowed across origins; if a browser throws anyway, the page is framed by someone else.
 */
export function isFramed(win: FrameWindow | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win) return false;
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/**
 * Edition running inside the iDos frame: our own wallet linking (Wallet Standard / Phantom) is hidden
 * there, because idosgames.com runs its own wallet card and blocks wallet access in the frame.
 * Always false in the main build, framed or not.
 */
export function isIdosFramed(idosBuild: boolean = IDOS_BUILD, win?: FrameWindow): boolean {
  return idosBuild && isFramed(win);
}

/**
 * The SOL economy (docs/IDOS_EDITION.md §3.5): the player-to-player market and treasury lots, the paid
 * starter kit, the custodial balance with deposit / withdraw / dev top-up, wallet linking (SIWS) and
 * the /economy money page. On in the main build; off in the iDos edition, whose economy is the iDos
 * Title's (its currencies, store and game token) and which keeps only the game loop (raids, loot,
 * CR traders, XP, levels, pass, friends, leaderboards).
 */
export function solEconomyEnabled(idosBuild: boolean = IDOS_BUILD): boolean {
  return !idosBuild;
}

/** solEconomyEnabled() of this bundle (a build-time constant). */
export const SOL_ECONOMY: boolean = solEconomyEnabled();

/** Which pieces of the lobby UI a build shows. Every flag is true in the main build. */
export interface EditionUi {
  /** SOL balance pill in the top bar and the "Wallet" stat in the stash. */
  walletBalance: boolean;
  /** "Wallet" links (account menu, More sheet, stash) and Connect wallet (SIWS). */
  walletLinks: boolean;
  /** "Economy" links to the /economy money page. */
  economyLinks: boolean;
  /** The paid starter kit card and "Buy starter kit" buttons. */
  starterKitSale: boolean;
  /** Shop · Market tab, "Sell on market" in the stash, market lines in the rules. */
  market: boolean;
}

export function editionUi(idosBuild: boolean = IDOS_BUILD): EditionUi {
  const sol = solEconomyEnabled(idosBuild);
  return { walletBalance: sol, walletLinks: sol, economyLinks: sol, starterKitSale: sol, market: sol };
}

/** editionUi() of this bundle. */
export const EDITION_UI: EditionUi = editionUi();

/**
 * API routes of the SOL economy: 404 in the edition (middleware.ts), whatever the UI shows.
 * Cron routes are not listed (the edition's cron keeps calling them; they hold no SOL path today).
 */
export const IDOS_DISABLED_API: readonly string[] = Object.freeze([
  "/api/market",
  "/api/wallet",
  "/api/withdraw",
  "/api/stash/starter",
  "/api/economy",
  "/api/onchain",
]);

/** Pages of the SOL economy: the edition redirects them to /play. */
export const IDOS_DISABLED_PAGES: readonly string[] = Object.freeze(["/wallet", "/economy", "/onchain"]);

/** Edition-only API (the iDos sign-in bridge): 404 in the main build. */
export const MAIN_DISABLED_API: readonly string[] = Object.freeze(["/api/idos"]);

/** `/api/market` covers `/api/market` and `/api/market/buy`, never `/api/marketing`. */
function underPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * What a build does with a request path: "api" → answer 404, "page" → redirect to /play, null → serve
 * it. Trailing slashes and letter case are ignored (Next routes are case-sensitive, so a differently
 * cased path never reaches a route anyway, but it must not slip past the gate either).
 */
export function editionBlock(pathname: string, idosBuild: boolean = IDOS_BUILD): "api" | "page" | null {
  const p = (pathname.replace(/\/+$/, "") || "/").toLowerCase();
  if (idosBuild) {
    if (IDOS_DISABLED_API.some((x) => underPrefix(p, x))) return "api";
    if (IDOS_DISABLED_PAGES.some((x) => underPrefix(p, x))) return "page";
    return null;
  }
  return MAIN_DISABLED_API.some((x) => underPrefix(p, x)) ? "api" : null;
}

/**
 * Origins of the iDos shells (https://{titleid}.idos.games) allowed to hand this page an iDos session.
 * Built in from IDOS_TITLE_IDS at build time (next.config → NEXT_PUBLIC_IDOS_SHELL_ORIGINS); empty in
 * the main build and in an edition built without Title ids.
 */
export function shellOriginsFromEnv(raw: string | undefined, idosBuild: boolean = IDOS_BUILD): string[] {
  if (!idosBuild) return [];
  return (raw ?? "").split(/\s+/).filter((o) => /^https:\/\/[a-z0-9]{8}(-dev)?\.idos\.games$/.test(o));
}

/** shellOriginsFromEnv() of this bundle (the literal env name is what Next inlines). */
export const IDOS_SHELL_ORIGINS: readonly string[] = shellOriginsFromEnv(process.env.NEXT_PUBLIC_IDOS_SHELL_ORIGINS);

/**
 * Accounts made by the iDos sign-in bridge (app/api/idos/session) have no email of their own; they get
 * a placeholder at the reserved `.invalid` domain (RFC 2606), which no one can register or receive.
 */
export const IDOS_ACCOUNT_EMAIL_DOMAIN = "idos.invalid";

export function isIdosAccountEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(`@${IDOS_ACCOUNT_EMAIL_DOMAIN}`);
}
