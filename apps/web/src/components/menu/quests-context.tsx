"use client";

/**
 * The menu's daily tasks and equipped cosmetics: GET /api/quests for registered players while no
 * battle runs and the tab is visible — on load, when the player comes back from a raid (the exit
 * settled the progress on the server), after 00:00 UTC (new tasks) and after a swap or equip. Feeds
 * the tasks strip, the Tasks button's dot, the tasks / rewards sheet and the top bar (title, name
 * colour, badge frame). A mark reward reached since the last look is toasted once.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { MARK_REWARDS, type WearableKind, type EquippedCosmetics, type QuestsDto } from "@extract/shared";
import { useLobby } from "@/lib/lobby/lobby-context";
import { cosmeticLabel } from "@/lib/lobby/levels";
import { playUi } from "@/game/audio/ui-sounds";

export interface QuestActResult {
  ok: boolean;
  message: string;
}

export interface QuestsValue {
  /** null until the first answer, and always for guests and signed-out viewers. */
  data: QuestsDto | null;
  error: boolean;
  reload: () => Promise<void>;
  reroll: (slot: number) => Promise<QuestActResult>;
  equip: (kind: WearableKind, id: string | null) => Promise<QuestActResult>;
  /** Tasks of a UTC day the player has not opened yet (the Tasks button's dot). */
  unseen: boolean;
  markSeen: () => void;
}

const QuestsCtx = createContext<QuestsValue | null>(null);
const SEEN_KEY = "spoils.questsSeenDay";

function readSeen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function isDto(v: unknown): v is QuestsDto {
  const d = v as Partial<QuestsDto> | null;
  return !!d && typeof d === "object" && typeof d.day === "string" && Array.isArray(d.slots) && typeof d.marks === "number";
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
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, json };
  } catch {
    return { ok: false, json: null };
  }
}

export function QuestsProvider({ active, children }: { active: boolean; children: React.ReactNode }) {
  const { registered, user, visible, toast } = useLobby();
  const userKey = registered ? (user?.id ?? null) : null;
  const [data, setData] = useState<QuestsDto | null>(null);
  const [error, setError] = useState(false);
  const [seen, setSeen] = useState<string | null>(null);
  const seq = useRef(0);
  const prevMarks = useRef<number | null>(null);

  useEffect(() => setSeen(readSeen()), []);

  const reload = useCallback(async () => {
    const my = ++seq.current;
    if (!userKey) {
      setData(null);
      return;
    }
    try {
      const res = await fetch("/api/quests", { credentials: "include", cache: "no-store" });
      const body: unknown = await res.json().catch(() => null);
      if (my !== seq.current) return;
      if (!res.ok || !isDto(body)) {
        if (res.status === 401 || res.status === 403) setData(null);
        else setError(true);
        return;
      }
      const before = prevMarks.current;
      if (before !== null && body.marks > before) {
        const hit = MARK_REWARDS.filter((r) => r.marks > before && r.marks <= body.marks).flatMap((r) => r.ids);
        if (hit[0]) {
          toast(`Unlocked · ${cosmeticLabel(hit[0])}`);
          playUi("coin");
        }
      }
      prevMarks.current = body.marks;
      setError(false);
      setData(body);
    } catch {
      if (my === seq.current) setError(true);
    }
  }, [userKey, toast]);

  // Another account: start over.
  useEffect(() => {
    setData(null);
    prevMarks.current = null;
  }, [userKey]);

  // Load while the menu is up and visible: on first show, after a battle (active flips back), and
  // when the tab comes back.
  useEffect(() => {
    if (!userKey || !active || !visible) return;
    void reload();
  }, [userKey, active, visible, reload]);

  // New tasks at 00:00 UTC (a little after, so the server's day has turned).
  const resetAt = data?.resetAt ?? null;
  const serverTime = data?.serverTime ?? null;
  useEffect(() => {
    if (!userKey || !active || resetAt === null || serverTime === null) return;
    const wait = Math.max(5_000, resetAt - serverTime + 3_000);
    if (wait > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => void reload(), wait);
    return () => window.clearTimeout(t);
  }, [userKey, active, resetAt, serverTime, reload]);

  const reroll = useCallback(
    async (slot: number): Promise<QuestActResult> => {
      const r = await post("/api/quests/reroll", { slot });
      await reload();
      return { ok: r.ok, message: String(r.json?.message ?? (r.ok ? "Task swapped." : "Couldn't swap the task. Try again.")) };
    },
    [reload],
  );

  const equip = useCallback(
    async (kind: WearableKind, id: string | null): Promise<QuestActResult> => {
      const r = await post("/api/quests/equip", { kind, id });
      const eq = r.json?.equipped as EquippedCosmetics | undefined;
      if (r.ok && eq) setData((d) => (d ? { ...d, equipped: eq } : d));
      else await reload();
      return { ok: r.ok, message: String(r.json?.message ?? (r.ok ? "Saved." : "Couldn't save. Try again.")) };
    },
    [reload],
  );

  const day = data?.day ?? null;
  const unseen = day !== null && seen !== day;
  const markSeen = useCallback(() => {
    if (!day) return;
    try {
      window.localStorage.setItem(SEEN_KEY, day);
    } catch {
      // Private mode: the dot just stays for this visit.
    }
    setSeen(day);
  }, [day]);

  const value = useMemo<QuestsValue>(
    () => ({ data, error, reload, reroll, equip, unseen, markSeen }),
    [data, error, reload, reroll, equip, unseen, markSeen],
  );
  return <QuestsCtx.Provider value={value}>{children}</QuestsCtx.Provider>;
}

export function useQuests(): QuestsValue {
  const v = useContext(QuestsCtx);
  if (!v) throw new Error("useQuests outside QuestsProvider");
  return v;
}
