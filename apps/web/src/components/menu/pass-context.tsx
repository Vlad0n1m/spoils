"use client";

/**
 * The menu's Alpha Pass (GAME_DESIGN §18e): GET /api/pass for registered players while no battle
 * runs and the tab is visible (on load, after a raid, after an action). Feeds the Pass tab of the
 * tasks sheet, the Pass tile's dot (a reached tier not yet claimed) and the hero's skin. Actions:
 * claim a tier, send a bug report, answer the survey. All progress comes from the server.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PassDto } from "@extract/shared";
import { useLobby } from "@/lib/lobby/lobby-context";
import { cosmeticLabel } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";

export interface PassActResult {
  ok: boolean;
  message: string;
}

export interface PassValue {
  data: PassDto | null;
  error: boolean;
  /** Reached tiers whose reward is not claimed yet (the tile's dot). */
  claimable: number;
  reload: () => Promise<void>;
  claim: (tier: number) => Promise<PassActResult>;
  reportBug: (text: string, context: string) => Promise<PassActResult>;
  answerSurvey: (answers: Record<string, string>) => Promise<PassActResult>;
}

const PassCtx = createContext<PassValue | null>(null);

function isDto(v: unknown): v is PassDto {
  const d = v as Partial<PassDto> | null;
  return !!d && typeof d === "object" && typeof d.ap === "number" && Array.isArray(d.tiers) && !!d.weekly;
}

async function post(url: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { ok: false, json: null };
  }
}

export function PassProvider({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { registered, user, visible, toast } = useLobby();
  const userKey = registered ? (user?.id ?? null) : null;
  const [data, setData] = useState<PassDto | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);
  const prevTier = useRef<number | null>(null);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    if (!userKey) {
      setData(null);
      return;
    }
    try {
      const res = await fetch("/api/pass", { credentials: "include", cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== seq.current) return;
      if (!res.ok || !isDto(body)) {
        if (res.status === 401 || res.status === 403) setData(null);
        else setError(true);
        return;
      }
      const before = prevTier.current;
      if (before !== null && body.tier > before) {
        toast(`Alpha Pass tier ${body.tier} · claim ${body.tiers[body.tier - 1]?.name ?? "your reward"}`);
        playUi("coin");
      }
      prevTier.current = body.tier;
      setError(false);
      setData(body);
    } catch {
      if (my === seq.current) setError(true);
    }
  }, [userKey, toast]);

  useEffect(() => {
    setData(null);
    prevTier.current = null;
  }, [userKey]);

  useEffect(() => {
    if (!userKey || !active || !visible) return;
    void reload();
  }, [userKey, active, visible, reload]);

  const claim = useCallback(
    async (tier: number): Promise<PassActResult> => {
      const r = await post("/api/pass/claim", { tier });
      await reload();
      const reward = typeof r.json?.reward === "string" ? r.json.reward : null;
      return { ok: r.ok, message: String(r.json?.message ?? (r.ok ? `Claimed · ${reward ? cosmeticLabel(reward) : "reward"}` : "Couldn't claim. Try again.")) };
    },
    [reload],
  );

  const reportBug = useCallback(
    async (text: string, context: string): Promise<PassActResult> => {
      const r = await post("/api/pass/bug", { text, context });
      if (r.ok) await reload();
      return { ok: r.ok, message: String(r.json?.message ?? (r.ok ? "Thanks! The team will review it." : "Couldn't send. Try again.")) };
    },
    [reload],
  );

  const answerSurvey = useCallback(
    async (answers: Record<string, string>): Promise<PassActResult> => {
      const r = await post("/api/pass/survey", { answers });
      await reload();
      return { ok: r.ok, message: String(r.json?.message ?? (r.ok ? "Thanks for the answers!" : "Couldn't send. Try again.")) };
    },
    [reload],
  );

  const claimable = data ? data.tiers.filter((t) => t.reached && !t.claimed).length : 0;
  const value = useMemo<PassValue>(
    () => ({ data, error, claimable, reload, claim, reportBug, answerSurvey }),
    [data, error, claimable, reload, claim, reportBug, answerSurvey],
  );
  return <PassCtx.Provider value={value}>{children}</PassCtx.Provider>;
}

export function usePass(): PassValue {
  const v = useContext(PassCtx);
  if (!v) throw new Error("usePass outside PassProvider");
  return v;
}
