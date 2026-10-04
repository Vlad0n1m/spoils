"use client";

/**
 * Main-menu data in one place (WORLD v6 spec §6): the session, the stash (one /api/stash request
 * shared by the top bar, PLAY, the gear strip and the Inventory / Shop panels), the world status,
 * /api/me/world, page visibility, the server-corrected clock and the toast.
 *
 * Two contexts on purpose: `useLobby()` changes only when data changes, `useNow()` ticks once a
 * second. Only countdown components read the clock, so a panel full of stash items does not
 * re-render every second.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { WORLD, worldCycleAt, worldPhase, type MeWorldDto, type WorldStatusDto } from "@extract/shared";
import { useSession, type MeUser } from "@/lib/session-context";
import { useStash, type Resource } from "@/components/lobby/use-lobby";
import type { StashResponse } from "./api-types";
import type { PlayState, SessionKind } from "./play-state";
import { clockOffsetMs } from "./world-clock";
import { usePageVisible, useMeWorld, useTicker, useWorldStatus } from "./use-world";

export interface LobbyValue {
  user: MeUser | null;
  sessionLoading: boolean;
  sessionKind: SessionKind;
  /** Signed in with a real account (has a stash). */
  registered: boolean;
  refreshSession: () => Promise<void>;
  stash: Resource<StashResponse>;
  status: WorldStatusDto | null;
  statusError: boolean;
  reloadStatus: () => Promise<void>;
  me: MeWorldDto | null | undefined;
  reloadMe: () => Promise<void>;
  visible: boolean;
  /** Adopt the server clock of a response (`age` = its Age header, cached responses only). */
  adoptServerTime: (serverTime: number, age?: string | null) => void;
  toast: (text: string) => void;
  toastText: string | null;
}

const LobbyCtx = createContext<LobbyValue | null>(null);
const NowCtx = createContext<number>(0);

export const TOAST_MS = 2_500;

/**
 * `active` = false while a battle runs: polling and the clock pause (the menu stays mounted but
 * hidden, so nothing in it re-renders until the player is back).
 */
export function LobbyProvider({ active = true, children }: { active?: boolean; children: React.ReactNode }) {
  const { user, loading: sessionLoading, refresh: refreshSession } = useSession();
  const registered = Boolean(user && !user.isGuest);
  const sessionKind: SessionKind = !user ? "anon" : user.isGuest ? "guest" : "user";
  const rawStash = useStash(registered);
  // useResource returns a fresh object every render; keep one per data change so the context value
  // (and every useLobby consumer) stays put while only the clock ticks.
  const stash = useMemo<Resource<StashResponse>>(
    () => ({ data: rawStash.data, error: rawStash.error, loading: rawStash.loading, reload: rawStash.reload, mutate: rawStash.mutate }),
    [rawStash.data, rawStash.error, rawStash.loading, rawStash.reload, rawStash.mutate],
  );
  const visible = usePageVisible();

  const [offset, setOffset] = useState(0);
  const adoptServerTime = useCallback((serverTime: number, age?: string | null) => {
    if (!Number.isFinite(serverTime) || serverTime <= 0) return;
    setOffset(clockOffsetMs(serverTime, age ?? null, Date.now()));
  }, []);
  const status = useWorldStatus(visible && active, adoptServerTime);
  const me = useMeWorld(user?.id ?? null, visible && active, adoptServerTime);

  const local = useTicker(1000, active);
  const now = local + offset;

  // Reload the status when the clock crosses a phase edge (entry close, wipe, reset end, next boss
  // reveal): the card would otherwise show the old map's boss until the next poll.
  const wc = worldCycleAt(now);
  const edge = `${wc.cycle}:${worldPhase(wc, now)}:${now >= wc.wipeAt - WORLD.NEXT_BOSS_REVEAL_MS ? 1 : 0}`;
  const firstEdge = useRef(edge);
  const { reload: reloadStatus } = status;
  useEffect(() => {
    if (firstEdge.current === edge) return;
    firstEdge.current = edge;
    // Give the server a moment past the edge (the CDN copy may be up to 5 s old).
    const t = window.setTimeout(() => void reloadStatus(), 1_500);
    return () => window.clearTimeout(t);
  }, [edge, reloadStatus]);

  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((text: string) => {
    window.clearTimeout(toastTimer.current);
    setToastText(text);
    toastTimer.current = window.setTimeout(() => setToastText(null), TOAST_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const value = useMemo<LobbyValue>(
    () => ({
      user,
      sessionLoading,
      sessionKind,
      registered,
      refreshSession,
      stash,
      status: status.data,
      statusError: status.error,
      reloadStatus,
      me: me.data,
      reloadMe: me.reload,
      visible,
      adoptServerTime,
      toast,
      toastText,
    }),
    [user, sessionLoading, sessionKind, registered, refreshSession, stash, status.data, status.error, reloadStatus, me.data, me.reload, visible, adoptServerTime, toast, toastText],
  );

  return (
    <LobbyCtx.Provider value={value}>
      <NowCtx.Provider value={now}>{children}</NowCtx.Provider>
    </LobbyCtx.Provider>
  );
}

export function useLobby(): LobbyValue {
  const v = useContext(LobbyCtx);
  if (!v) throw new Error("useLobby outside LobbyProvider");
  return v;
}

/** Server-corrected wall clock (ms), ticking once a second. */
export function useNow(): number {
  return useContext(NowCtx);
}

// ---------------------------------------------------------------------------- PLAY controller

export interface PlayValue {
  state: PlayState;
  /** What pressing PLAY does in the current state (join, arm, disarm, sign-in sheet, retry status). */
  press: () => void;
  /** Cancel an armed PLAY. */
  disarm: () => void;
  /** Join right now (error "Try again"). */
  join: () => void;
  /** Join right now following the party leader's drop (party prompt "PLAY"). */
  joinDrop: (dropId: string) => void;
}

const PlayCtx = createContext<PlayValue | null>(null);
export const PlayProvider = PlayCtx.Provider;

export function usePlay(): PlayValue {
  const v = useContext(PlayCtx);
  if (!v) throw new Error("usePlay outside PlayProvider");
  return v;
}
