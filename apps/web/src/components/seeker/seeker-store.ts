"use client";

import { useSyncExternalStore } from "react";
import type { SeekerDto } from "@/lib/seeker/types";

/**
 * The signed-in player's Seeker state (GET / POST /api/seeker, lib/seeker), one module store shared by
 * the lobby nick, the wallet card and the account menu, so the chain is asked once per page and a
 * claim or a re-check shows everywhere at once.
 */
export interface SeekerState {
  userId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  data: SeekerDto | null;
  /** A "Check again" or a claim is running. */
  busy: "refresh" | "claim" | null;
  /** Last claim / refresh failure, for the wallet card. */
  error: string | null;
}

const INITIAL: SeekerState = { userId: null, status: "idle", data: null, busy: null, error: null };

let state: SeekerState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<SeekerState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useSeeker(): SeekerState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

/** The badge shows for this account: its linked wallet held an SGT at the last check. */
export function useSeekerVerified(): boolean {
  const s = useSeeker();
  return s.status === "ready" && s.data?.verified === true;
}

async function message(res: Response, fallback: string): Promise<string> {
  try {
    const b = (await res.json()) as { message?: string };
    return b.message ?? fallback;
  } catch {
    return fallback;
  }
}

let loading: Promise<void> | null = null;

/** Loads once per account; `force` reloads (after a wallet link or unlink). */
export function loadSeeker(userId: string, force = false): Promise<void> {
  if (!force && state.userId === userId && state.status !== "idle" && state.status !== "error") return loading ?? Promise.resolve();
  if (state.userId !== userId) set({ ...INITIAL, userId });
  set({ status: state.data ? state.status : "loading", error: null });
  const p = (async () => {
    try {
      const res = await fetch("/api/seeker", { credentials: "same-origin", cache: "no-store" });
      if (state.userId !== userId) return;
      if (!res.ok) {
        set({ status: "error", error: await message(res, "Couldn't load the Seeker status.") });
        return;
      }
      set({ status: "ready", data: (await res.json()) as SeekerDto });
    } catch {
      if (state.userId === userId) set({ status: "error", error: "Couldn't load the Seeker status." });
    }
  })();
  loading = p.finally(() => {
    if (loading === p) loading = null;
  });
  return p;
}

/** "Check again": asks the server to re-read the chain (honoured once a minute per wallet). */
export async function refreshSeeker(): Promise<void> {
  const userId = state.userId;
  if (!userId || state.busy) return;
  set({ busy: "refresh", error: null });
  try {
    const res = await fetch("/api/seeker?refresh=1", { credentials: "same-origin", cache: "no-store" });
    if (state.userId !== userId) return;
    if (!res.ok) set({ error: await message(res, "Couldn't check right now. Try again in a minute.") });
    else set({ status: "ready", data: (await res.json()) as SeekerDto });
  } catch {
    set({ error: "Couldn't check right now. Try again in a minute." });
  } finally {
    set({ busy: null });
  }
}

/** Claims the one-time Seeker frame. True on success. */
export async function claimSeeker(): Promise<boolean> {
  const userId = state.userId;
  if (!userId || state.busy) return false;
  set({ busy: "claim", error: null });
  try {
    const res = await fetch("/api/seeker", { method: "POST", credentials: "same-origin" });
    if (state.userId !== userId) return false;
    if (!res.ok) {
      set({ error: await message(res, "Couldn't claim the frame. Try again.") });
      return false;
    }
    const body = (await res.json()) as { status: SeekerDto };
    set({ status: "ready", data: body.status });
    return true;
  } catch {
    set({ error: "Couldn't claim the frame. Try again." });
    return false;
  } finally {
    set({ busy: null });
  }
}
