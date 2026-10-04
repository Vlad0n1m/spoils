"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WORLD, type JoinTicket, type WorldJoinResponse } from "@extract/shared";
import { BRAND } from "@/lib/brand";
import { PlayProvider, useLobby, useNow, type PlayValue } from "@/lib/lobby/lobby-context";
import { flushDraft } from "@/lib/lobby/draft-flush";
import { readArmedCycle, writeArmedCycle } from "@/lib/lobby/news-seen";
import { classifyJoinFailure, derivePlayState, playAction, type PlayError } from "@/lib/lobby/play-state";
import type { WorldJoinErrorBody } from "@/lib/lobby/api-types";
import { worldView } from "@/lib/lobby/world-clock";
import { playUi } from "@/game/audio/ui-sounds";
import { atRiskOf, loadoutOf } from "./gear-strip";

/** What the menu needs to switch to the battle stage. */
export interface BattleStart {
  ticket: JoinTicket;
  roomId: string;
  cycle: number;
}

/** A re-join the battle screen asked for (RoomExit "retry"): run the join after `delayMs`. */
export interface RetryRequest {
  seq: number;
  delayMs: number;
}

/** world_starting / world_full: this many tries in all (spec §6.5). */
const MAX_JOIN_TRIES = 3;
/** An in_raid answer without settlesAt shows GEAR IN RAID this long before the reloads decide. */
const IN_RAID_FALLBACK_MS = 30_000;

function isJoinResponse(v: unknown): v is WorldJoinResponse {
  const r = v as Partial<WorldJoinResponse> | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.roomId === "string" &&
    r.roomId.length > 0 &&
    typeof r.cycle === "number" &&
    !!r.ticket &&
    typeof r.ticket === "object" &&
    typeof r.ticket.userId === "string" &&
    typeof r.ticket.sig === "string"
  );
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * PLAY logic (WORLD v6 spec §6.5) around the pure derivePlayState: POST /api/world/join and its
 * failures, the armed auto-enter for the next map (sessionStorage `spoils.armed`, rand(0..4 s)
 * jitter, visible tabs only — a hidden tab gets "▶ Map open" in its title and the coin sound),
 * and the clock offset from every join answer. Renders only the provider: `children` come from the
 * menu, so the per-second state reaches the PLAY consumers alone.
 */
export function PlayController({
  onBattle,
  onSignIn,
  retry,
  children,
}: {
  onBattle: (b: BattleStart) => void;
  onSignIn: () => void;
  /** The battle screen's join was refused with a retry reason: join again (exit_settling after 2 s). */
  retry: RetryRequest | null;
  children: React.ReactNode;
}) {
  const lobby = useLobby();
  const { sessionLoading, sessionKind, stash, status, statusError, me, visible, adoptServerTime, reloadStatus, reloadMe, refreshSession } = lobby;
  const now = useNow();

  const [joining, setJoining] = useState(false);
  const joiningRef = useRef(false);
  const [armed, setArmed] = useState<number | null>(null);
  const jitter = useRef(0);
  const [error, setError] = useState<PlayError | null>(null);
  const [inRaidUntil, setInRaidUntil] = useState<number | null>(null);
  const meRef = useRef(me);
  meRef.current = me;
  /** The me/world answer the lobby held when /api/world/join said in_raid (only later answers count). */
  const meAtInRaid = useRef<typeof me | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  // Armed survives a reload of the tab (session storage), not a closed tab.
  useEffect(() => {
    setArmed(readArmedCycle());
    jitter.current = Math.random() * WORLD.AUTO_ENTER_JITTER_MS;
  }, []);
  const setArmedCycle = useCallback((c: number | null) => {
    setArmed(c);
    writeArmedCycle(c);
  }, []);

  const stashInput = useMemo(() => {
    if (sessionKind !== "user") return null;
    const d = stash.data;
    return {
      loaded: Boolean(d) || Boolean(stash.error),
      inRaid: d?.active?.status === "in_raid",
      atRisk: atRiskOf(loadoutOf(d)),
      starterClaimed: d?.starterClaimed ?? true,
    };
  }, [sessionKind, stash.data, stash.error]);

  const state = derivePlayState({
    session: { loading: sessionLoading, kind: sessionKind },
    stash: stashInput,
    world: status,
    worldError: statusError,
    me,
    local: { joining, armedCycle: armed, error, hidden: !visible, inRaidUntil },
    now,
  });

  const join = useCallback(async () => {
    if (joiningRef.current) return;
    joiningRef.current = true;
    setJoining(true);
    setError(null);
    let tries = 0;
    try {
      // The join locks the saved draft: send a loadout edit still inside its autosave debounce first.
      await flushDraft();
      if (!alive.current) return;
      for (;;) {
        tries++;
        let status = 0;
        let body: unknown = null;
        try {
          const res = await fetch("/api/world/join", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "content-type": "application/json" },
            body: "{}",
          });
          status = res.status;
          body = await res.json().catch(() => null);
        } catch {
          status = 0;
        }
        if (!alive.current) return;
        const st = (body as { serverTime?: unknown } | null)?.serverTime;
        if (typeof st === "number") adoptServerTime(st);
        if (status >= 200 && status < 300 && isJoinResponse(body)) {
          setArmedCycle(null);
          onBattle({ ticket: body.ticket, roomId: body.roomId, cycle: body.cycle });
          return;
        }
        const f = classifyJoinFailure(status, body as Partial<WorldJoinErrorBody> | null);
        if (f.kind === "retry" && tries < MAX_JOIN_TRIES) {
          await sleep(f.afterMs);
          if (!alive.current) return;
          continue;
        }
        if (f.kind === "retry") setError({ message: f.message, fix: "retry" });
        else if (f.kind === "closed") void reloadStatus();
        else if (f.kind === "in_raid") {
          meAtInRaid.current = meRef.current;
          setInRaidUntil(f.settlesAt ?? Date.now() + IN_RAID_FALLBACK_MS);
          void reloadMe();
          void stash.reload();
        } else {
          setError(f.error);
          if (f.error.fix === "signin") void refreshSession();
          if (f.error.fix === "inventory") void stash.reload();
        }
        playUi("error");
        return;
      }
    } finally {
      joiningRef.current = false;
      if (alive.current) setJoining(false);
    }
  }, [adoptServerTime, onBattle, reloadMe, reloadStatus, refreshSession, setArmedCycle, stash]);

  // The raid behind an in_raid answer often settles long before settlesAt (an exit report a few
  // seconds late): a me/world answer that arrived after it with no active entry, and no gear held by a
  // raid, frees PLAY at once instead of keeping GEAR IN RAID until the old map's ends_at + 5 min.
  const stashInRaid = stashInput?.inRaid ?? false;
  useEffect(() => {
    if (inRaidUntil === null || me === undefined || me === meAtInRaid.current) return;
    if (!me?.activeEntry && !stashInRaid) setInRaidUntil(null);
  }, [me, inRaidUntil, stashInRaid]);

  // A retry from the battle screen: show DROPPING IN… during the wait, then a fresh join.
  const retrySeq = retry?.seq ?? null;
  const retryDelay = retry?.delayMs ?? 0;
  useEffect(() => {
    if (retrySeq === null) return;
    setJoining(true);
    const t = window.setTimeout(() => {
      setJoining(false);
      void join();
    }, retryDelay);
    return () => window.clearTimeout(t);
    // One run per request (seq); join's identity may change meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retrySeq]);

  const disarm = useCallback(() => {
    setArmedCycle(null);
    playUi("click");
  }, [setArmedCycle]);

  const press = useCallback(() => {
    const a = playAction(state);
    if (a !== "join") setError(null);
    switch (a) {
      case "join":
        playUi("click");
        void join();
        return;
      case "arm": {
        const v = worldView(status, now);
        jitter.current = Math.random() * WORLD.AUTO_ENTER_JITTER_MS;
        setArmedCycle(v.armCycle);
        playUi("equip");
        return;
      }
      case "disarm":
        disarm();
        return;
      case "signin":
        onSignIn();
        return;
      case "retry_status":
        void reloadStatus();
        return;
      default:
        return;
    }
  }, [state, join, status, now, setArmedCycle, disarm, onSignIn, reloadStatus]);

  // A new map clears an old error (entry limit, closed entry, a stale loadout message).
  const cycle = worldView(status, now).cycle;
  const seenCycle = useRef(cycle);
  useEffect(() => {
    if (seenCycle.current === cycle) return;
    seenCycle.current = cycle;
    setError(null);
  }, [cycle]);

  // Armed auto-enter: at openAt + jitter of the armed cycle; a hidden tab is pinged instead.
  const pinged = useRef<string | null>(null);
  useEffect(() => {
    if (armed === null || joining) return;
    const v = worldView(status, now);
    if (v.phase !== "open") {
      if (armed < v.armCycle) setArmedCycle(null);
      return;
    }
    if (armed !== v.cycle) {
      if (armed < v.cycle) setArmedCycle(null);
      return;
    }
    if (now < v.openAt + jitter.current) return;
    setArmedCycle(null);
    if (visible) {
      void join();
      return;
    }
    if (pinged.current === null) pinged.current = document.title;
    document.title = `▶ Map open — ${BRAND.name}`;
    playUi("coin");
  }, [armed, joining, status, now, visible, join, setArmedCycle]);
  useEffect(() => {
    if (!visible || pinged.current === null) return;
    document.title = pinged.current;
    pinged.current = null;
  }, [visible]);

  const value = useMemo<PlayValue>(() => ({ state, press, disarm, join: () => void join() }), [state, press, disarm, join]);
  return <PlayProvider value={value}>{children}</PlayProvider>;
}
