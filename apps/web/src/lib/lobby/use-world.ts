"use client";

/**
 * Lobby data hooks (WORLD v6 spec §6.5): the public world status, the caller's /api/me/world, page
 * visibility and the one shared clock tick. Polling is light on purpose (the owner's laptop and the
 * CDN both matter): status every 15 s and me/world every 60 s, both only while the tab is visible.
 * Each still fetches once on mount whatever the visibility (see poller.ts).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MeWorldDto, WorldStatusDto } from "@extract/shared";
import { Poller } from "./poller";

export const STATUS_POLL_MS = 15_000;
export const ME_POLL_MS = 60_000;
/** Status failures in a row before the lobby calls the world offline. */
export const STATUS_FAILS_OFFLINE = 2;

/** document.visibilityState === "visible" (true during SSR and before the first effect). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const read = () => setVisible(document.visibilityState === "visible");
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);
  return visible;
}

/** Local Date.now(), refreshed every `ms` while `active` (one timer for the whole menu). */
export function useTicker(ms = 1000, active = true): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setT(Date.now());
    const id = window.setInterval(() => setT(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
  return t;
}

/**
 * Fetch once on mount (visible or not), then every `ms` while `active`, plus once when it turns
 * active again (tab visible / battle over). A new `key` (another account) starts over.
 */
function usePoll(fn: () => void, ms: number, active: boolean, key: string | null = null): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const pollerRef = useRef<Poller | null>(null);
  useEffect(() => {
    const p = new Poller(() => fnRef.current(), ms);
    pollerRef.current = p;
    p.start();
    return () => {
      p.dispose();
      if (pollerRef.current === p) pollerRef.current = null;
    };
  }, [ms, key]);
  useEffect(() => {
    pollerRef.current?.setActive(active);
  }, [active, ms, key]);
}

export interface WorldStatusResource {
  data: WorldStatusDto | null;
  /** STATUS_FAILS_OFFLINE failures in a row (the last good status, if any, is kept in `data`). */
  error: boolean;
  reload: () => Promise<void>;
}

function isStatus(v: unknown): v is WorldStatusDto {
  const s = v as Partial<WorldStatusDto> | null;
  return !!s && typeof s === "object" && s.v === 1 && typeof s.cycle === "number" && typeof s.serverTime === "number";
}

/**
 * GET /api/world/status: on mount (even in a hidden tab), every STATUS_POLL_MS while visible, and on `reload()`.
 * `onClock(serverTime, ageHeader)` gets every good response (the menu's clock offset).
 */
export function useWorldStatus(visible: boolean, onClock: (serverTime: number, age: string | null) => void): WorldStatusResource {
  const [data, setData] = useState<WorldStatusDto | null>(null);
  const [fails, setFails] = useState(0);
  const seq = useRef(0);
  const clockRef = useRef(onClock);
  clockRef.current = onClock;

  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetch("/api/world/status", { credentials: "omit" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== seq.current) return;
      if (!res.ok || !isStatus(body)) throw new Error(`status ${res.status}`);
      clockRef.current(body.serverTime, res.headers.get("age"));
      setData(body);
      setFails(0);
    } catch {
      if (my === seq.current) setFails((f) => f + 1);
    }
  }, []);

  usePoll(() => void reload(), STATUS_POLL_MS, visible);
  return { data, error: fails >= STATUS_FAILS_OFFLINE, reload };
}

export interface MeWorldResource {
  /** undefined while the first answer is pending, null when unavailable. */
  data: MeWorldDto | null | undefined;
  reload: () => Promise<void>;
}

function isMeWorld(v: unknown): v is MeWorldDto {
  const m = v as Partial<MeWorldDto> | null;
  return !!m && typeof m === "object" && typeof m.serverTime === "number" && "activeEntry" in m && "lastRaid" in m;
}

/**
 * GET /api/me/world for a signed-in caller (`userKey` = their id; null = signed out → null): on
 * mount (even in a hidden tab), every ME_POLL_MS while visible, when the tab turns visible, and on `reload()` (after a battle).
 */
export function useMeWorld(userKey: string | null, visible: boolean, onClock: (serverTime: number) => void): MeWorldResource {
  const [data, setData] = useState<MeWorldDto | null | undefined>(undefined);
  const seq = useRef(0);
  const clockRef = useRef(onClock);
  clockRef.current = onClock;

  const reload = useCallback(async () => {
    const my = ++seq.current;
    if (!userKey) {
      setData(null);
      return;
    }
    try {
      const res = await fetch("/api/me/world", { credentials: "include", cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== seq.current) return;
      if (!res.ok || !isMeWorld(body)) {
        // Keep what we had on a transient failure; a first failure means "unknown" (null).
        setData((d) => (d === undefined || res.status === 401 ? null : d));
        return;
      }
      clockRef.current(body.serverTime);
      setData(body);
    } catch {
      if (my === seq.current) setData((d) => (d === undefined ? null : d));
    }
  }, [userKey]);

  // A different account (sign in / out) starts from "loading" again. Declared before the poll so
  // its reset runs before the poll's first fetch for that account.
  useEffect(() => {
    setData(userKey ? undefined : null);
  }, [userKey]);

  usePoll(() => void reload(), ME_POLL_MS, visible && userKey !== null, userKey);
  return { data, reload };
}
