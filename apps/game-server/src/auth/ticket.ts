/**
 * Join tickets: the game server trusts a player's identity only through the web API's HMAC.
 * Rooms call verifyJoinTicket in onAuth; anything malformed, forged, stale or unverifiable is null.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { JOIN_TICKET_TTL_MS, joinTicketPayload, type JoinTicket } from "@extract/shared";

/** Clocks of the web API and the game server may disagree a little. */
const MAX_FUTURE_SKEW_MS = 30_000;
const MAX_USER_ID_LEN = 128;
const MAX_NICKNAME_LEN = 24;
/** Loadout ids are DB uuids; "" = free kit. Anything else cannot be a real loadout. */
const LOADOUT_ID_RE = /^(?:[0-9a-zA-Z-]{1,64})?$/;

let warnedNoSecret = false;

/** Accepts the ticket object or its JSON string (clients may pass either as a join option). */
export function verifyJoinTicket(raw: unknown, now = Date.now()): JoinTicket | null {
  const secret = process.env.GAME_SERVER_HMAC_SECRET;
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.error("[auth] GAME_SERVER_HMAC_SECRET is not set — every join ticket is rejected");
    }
    return null;
  }

  let obj: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 4096) return null;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const t = obj as Record<string, unknown>;
  const { userId, nickname, issuedAt, sig } = t;
  // "" = free kit. Missing is read as "" (the signature still has to cover it).
  const loadoutId = t.loadoutId === undefined ? "" : t.loadoutId;
  if (typeof loadoutId !== "string" || !LOADOUT_ID_RE.test(loadoutId)) return null;
  if (typeof userId !== "string" || userId.length < 1 || userId.length > MAX_USER_ID_LEN) return null;
  if (typeof nickname !== "string") return null;
  const nickLen = [...nickname].length;
  if (nickLen < 1 || nickLen > MAX_NICKNAME_LEN) return null;
  if (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return null;
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig)) return null;

  if (issuedAt > now + MAX_FUTURE_SKEW_MS) return null;
  if (now - issuedAt > JOIN_TICKET_TTL_MS) return null;

  const expected = createHmac("sha256", secret)
    .update(joinTicketPayload({ userId, nickname, issuedAt, loadoutId }))
    .digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  return { userId, nickname, issuedAt, loadoutId, sig: sig.toLowerCase() };
}

/** Test helper and the format the web API uses (apps/web/src/lib/join-ticket.ts). */
export function signJoinTicket(
  who: { userId: string; nickname: string; issuedAt: number; loadoutId?: string },
  secret: string,
): JoinTicket {
  const t = { ...who, loadoutId: who.loadoutId ?? "" };
  const sig = createHmac("sha256", secret).update(joinTicketPayload(t)).digest("hex");
  return { ...t, sig };
}
