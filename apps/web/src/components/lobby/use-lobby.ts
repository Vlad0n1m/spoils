"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, StashResponse } from "@/lib/lobby/api-types";

/** Client plumbing for the lobby tabs: JSON calls with readable errors, the stash resource. */

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: ApiError | null,
  ) {
    super(message);
  }
}

/** fetch → JSON; non-2xx throws ApiCallError carrying the route's `message` (UI text). */
export async function api<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    credentials: "include",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data ?? null) as ApiError | null;
    throw new ApiCallError(res.status, err?.error ?? `http_${res.status}`, err?.message ?? err?.error ?? `Request failed (HTTP ${res.status})`, err);
  }
  return data as T;
}

export interface Resource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Optimistic local patch (e.g. new CR after a purchase) until the next reload. */
  mutate: (fn: (d: T) => T) => void;
}

/** Loads `url` once (and on `reload()`); `enabled=false` keeps it idle (signed-out viewers). */
export function useResource<T>(url: string | null): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const d = await api<T>(url);
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const mutate = useCallback((fn: (d: T) => T) => setData((d) => (d ? fn(d) : d)), []);
  return { data, error, loading, reload, mutate };
}

export function useStash(enabled: boolean): Resource<StashResponse> {
  return useResource<StashResponse>(enabled ? "/api/stash" : null);
}

/** One uuid per user action: the server's idempotency key (junker buys). */
export function newRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  // Fallback for very old browsers: RFC 4122 v4 from Math.random (not security-relevant here).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Minutes/hours/days left until `ts`, compact ("6d", "3h", "12m", "now"). */
export function timeLeft(ts: number, now = Date.now()): string {
  const ms = ts - now;
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "5 min ago" style for history rows. */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
