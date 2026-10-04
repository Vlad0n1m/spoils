"use client";

/**
 * The menu's social state: GET /api/party polled every PARTY.POLL_MS in a party, PARTY.IDLE_POLL_MS
 * otherwise (the answer's `pollMs`), while no battle runs, registered users only; outside a party
 * only while the tab is visible (in a party a hidden tab keeps polling, so "Follow leader" can ping it). It feeds the Friends button's dot, the party strip, the invite and drop prompts and the
 * PLAY controller's "Follow leader". `act` posts one friends / party action and refreshes the state;
 * new invites and friend requests are toasted once.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PARTY } from "@extract/shared";
import { useLobby } from "@/lib/lobby/lobby-context";
import { freshInvites, moreRequests, socialErrorText } from "@/lib/social/menu";
import type { PartyStateDto } from "@/lib/social/types";
import { playUi } from "@/game/audio/ui-sounds";

export interface ActResult {
  ok: boolean;
  message: string;
  status?: "sent" | "accepted";
}

export interface PartyValue {
  /** null until the first answer (and always for guests and signed-out viewers). */
  state: PartyStateDto | null;
  reload: () => Promise<void>;
  /** POST /api/{friends|party}/<action>; refreshes the state afterwards. */
  act: (scope: "friends" | "party", action: string, body?: Record<string, unknown>) => Promise<ActResult>;
  /** Bumped after every successful action (the Friends panel reloads its list on it). */
  version: number;
}

const PartyCtx = createContext<PartyValue | null>(null);

function isState(v: unknown): v is PartyStateDto {
  const s = v as Partial<PartyStateDto> | null;
  return !!s && typeof s === "object" && typeof s.serverTime === "number" && Array.isArray(s.invites) && "party" in s;
}

export function PartyProvider({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { registered, user, visible, toast } = useLobby();
  const [state, setState] = useState<PartyStateDto | null>(null);
  const [version, setVersion] = useState(0);
  const seq = useRef(0);
  const prevInvites = useRef<PartyStateDto["invites"] | null>(null);
  const prevRequests = useRef<number | null>(null);
  const userKey = registered ? (user?.id ?? null) : null;

  const reload = useCallback(async () => {
    const my = ++seq.current;
    if (!userKey) {
      setState(null);
      return;
    }
    try {
      const res = await fetch("/api/party", { credentials: "include", cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== seq.current) return;
      if (!res.ok || !isState(body)) {
        if (res.status === 401 || res.status === 403) setState(null);
        return;
      }
      const fresh = freshInvites(prevInvites.current, body.invites);
      if (fresh[0]) {
        toast(`${fresh[0].from} invited you to a party`);
        playUi("coin");
      } else if (moreRequests(prevRequests.current, body.requests)) {
        toast("New friend request");
      }
      prevInvites.current = body.invites;
      prevRequests.current = body.requests;
      setState(body);
    } catch {
      // Keep the last state on a network blip; the next poll tries again.
    }
  }, [userKey, toast]);

  // Another account (sign in / out): start over, no toasts for what the new account already had.
  useEffect(() => {
    setState(null);
    prevInvites.current = null;
    prevRequests.current = null;
  }, [userKey]);

  const pollMs = state?.pollMs ?? PARTY.IDLE_POLL_MS;
  const inParty = Boolean(state?.party);
  useEffect(() => {
    if (!userKey || !active || (!visible && !inParty)) return;
    if (visible) void reload();
    const id = window.setInterval(() => void reload(), Math.max(PARTY.POLL_MS, pollMs));
    return () => window.clearInterval(id);
  }, [userKey, active, visible, inParty, pollMs, reload]);

  const act = useCallback(
    async (scope: "friends" | "party", action: string, body: Record<string, unknown> = {}): Promise<ActResult> => {
      let status = 0;
      let json: unknown = null;
      try {
        const res = await fetch(`/api/${scope}/${action}`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        status = res.status;
        json = await res.json().catch(() => null);
      } catch {
        status = 0;
      }
      const ok = status >= 200 && status < 300;
      const out: ActResult = ok
        ? { ok, message: String((json as { message?: unknown } | null)?.message ?? "Done."), status: (json as ActResult | null)?.status }
        : { ok, message: socialErrorText(status, json) };
      if (ok) setVersion((v) => v + 1);
      void reload();
      return out;
    },
    [reload],
  );

  const value = useMemo<PartyValue>(() => ({ state, reload, act, version }), [state, reload, act, version]);
  return <PartyCtx.Provider value={value}>{children}</PartyCtx.Provider>;
}

export function useParty(): PartyValue {
  const v = useContext(PartyCtx);
  if (!v) throw new Error("useParty outside PartyProvider");
  return v;
}
