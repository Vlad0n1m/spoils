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
  isIdosBuildEnv,
  parseFrameAncestors,
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
