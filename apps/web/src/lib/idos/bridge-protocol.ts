/**
 * postMessage protocol between the iDos shell (deploy/idos-shell, served from
 * https://{titleid}.idos.games) and this edition in its iframe. deploy/idos-shell/src/protocol.ts
 * repeats these names; change both together.
 *
 *   edition → shell  { type: "spoils:idos:hello", v: 1 }              (to each allowed shell origin)
 *   shell → edition  { type: "spoils:idos:session", v: 1, titleId, userId, ticket, nickname? }
 *
 * The edition accepts the session message only from `window.parent` at an allowed origin
 * (lib/edition.ts IDOS_SHELL_ORIGINS) and hands it to POST /api/idos/session, which checks it with
 * iDos before anything is signed in. The ticket never goes into a URL.
 */

export const BRIDGE_VERSION = 1;
export const MSG_HELLO = "spoils:idos:hello";
export const MSG_SESSION = "spoils:idos:session";

export interface ShellSessionMessage {
  titleId: string;
  userId: string;
  ticket: string;
  nickname?: string;
}

/** The session message, or null for anything else (other messages, wrong version, wrong types). */
export function parseShellMessage(data: unknown): ShellSessionMessage | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type !== MSG_SESSION || m.v !== BRIDGE_VERSION) return null;
  const { titleId, userId, ticket, nickname } = m;
  if (typeof titleId !== "string" || typeof userId !== "string" || typeof ticket !== "string") return null;
  if (!titleId || !userId || !ticket) return null;
  const out: ShellSessionMessage = { titleId, userId, ticket };
  if (typeof nickname === "string" && nickname.length > 0) out.nickname = nickname.slice(0, 64);
  return out;
}

/**
 * Our nickname rules (2–16 of [a-zA-Z0-9_]) applied to an iDos username: other characters dropped,
 * cut to 12 so a numeric suffix still fits; too short → "raider".
 */
export function nicknameBase(raw: string | undefined): string {
  const clean = (raw ?? "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 12);
  return clean.length >= 2 ? clean : "raider";
}
