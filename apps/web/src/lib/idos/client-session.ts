/**
 * The iDos SDK session as the web components see it inside the iDos client (deploy/idos-shell).
 *
 * The client signs the player in with @idosgames/core and, before mounting the lobby, exposes the
 * session on `window.__SPOILS_IDOS__` (deploy/idos-shell/src/main.tsx). The SPOILS shop needs the
 * player's current ClientSessionTicket on every payment and balance read: our server pays from the
 * player's iDos balance with that ticket (lib/idos/store-pay.ts), and iDos checks it each time. The
 * ticket and UserID are getters, read at the moment of the call, because the SDK refreshes its
 * session on its own. Nothing here is stored: the ticket stays in the SDK's memory.
 *
 * Outside the iDos client (the main build, or the edition opened directly on its own domain, or
 * during server rendering) there is no SDK session and every helper answers null: the SPOILS tab is
 * then not shown at all.
 */
import { IDOS_BUILD } from "../edition";

export interface IdosClientSession {
  titleId: string;
  userId: () => string | undefined;
  ticket: () => string | undefined;
}

declare global {
  interface Window {
    __SPOILS_IDOS__?: IdosClientSession;
  }
}

/** The SDK session of the iDos client, or null anywhere else (and in the main build). */
export function idosClientSession(win: { __SPOILS_IDOS__?: unknown } | undefined = typeof window === "undefined" ? undefined : window, idosBuild: boolean = IDOS_BUILD): IdosClientSession | null {
  if (!idosBuild || !win) return null;
  const s = win.__SPOILS_IDOS__ as Partial<IdosClientSession> | undefined;
  if (!s || typeof s !== "object" || typeof s.titleId !== "string" || typeof s.ticket !== "function" || typeof s.userId !== "function") return null;
  return s as IdosClientSession;
}

/** The current session ticket, or null without a signed-in iDos session. */
export function idosTicket(session: IdosClientSession | null = idosClientSession()): string | null {
  try {
    const t = session?.ticket();
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}
