"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { Room } from "colyseus.js";
import { MATCH, type JoinTicket } from "@extract/shared";
import { getColyseusClient } from "@/lib/colyseus";

interface Props {
  ticket: JoinTicket;
  roomName: string;
  onCancel: () => void;
  onBattleReady: (battleRoomId: string) => void;
}

interface MmView {
  players: number;
  /** Wall-clock ms when bots fill the lobby. */
  deadlineAt: number;
  launching: boolean;
}

/**
 * The matchmaking room's schema belongs to the game server; read it loosely so a renamed or
 * missing field degrades the countdown instead of breaking the lobby.
 */
function readMmState(state: unknown, fallbackDeadline: number): MmView {
  const s = (state ?? {}) as Record<string, unknown>;
  const players = s.players as { length?: number; size?: number } | undefined;
  const count = typeof players?.length === "number" ? players.length : typeof players?.size === "number" ? players.size : 0;
  const now = Date.now();
  const raw = typeof s.deadlineAt === "number" ? s.deadlineAt : 0;
  // Ignore deadlines that only make sense with a badly skewed client clock.
  const sane = raw > now - 10_000 && raw < now + 120_000;
  const status = typeof s.status === "string" ? s.status : "waiting";
  return {
    players: count,
    deadlineAt: sane ? raw : fallbackDeadline,
    launching: status === "starting" || status === "started",
  };
}

export function MatchmakingPanel({ ticket, roomName, onCancel, onBattleReady }: Props) {
  const [view, setView] = useState<MmView>(() => ({
    players: 1,
    deadlineAt: Date.now() + MATCH.MATCHMAKING_TIMEOUT_MS,
    launching: false,
  }));
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  const sessionRef = useRef<{ dispose: () => void } | null>(null);
  const disposeTimerRef = useRef<number | undefined>(undefined);
  const onReadyRef = useRef(onBattleReady);
  onReadyRef.current = onBattleReady;

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // Deferred dispose: StrictMode's immediate re-run cancels it, so we join the room only once.
    window.clearTimeout(disposeTimerRef.current);
    if (!sessionRef.current) {
      let disposed = false;
      let room: Room | null = null;
      const fallbackDeadline = Date.now() + MATCH.MATCHMAKING_TIMEOUT_MS;
      void (async () => {
        try {
          const client = await getColyseusClient();
          const joined = await client.joinOrCreate(roomName, { ticket });
          if (disposed) {
            void joined.leave().catch(() => {});
            return;
          }
          room = joined;
          joined.onStateChange((state: unknown) => setView(readMmState(state, fallbackDeadline)));
          joined.onMessage("battle_ready", (msg: { battleRoomId?: unknown }) => {
            if (typeof msg?.battleRoomId === "string") onReadyRef.current(msg.battleRoomId);
          });
          joined.onError((code, message) => setErr(message ?? `error_${code}`));
        } catch (e) {
          if (!disposed) setErr(e instanceof Error ? e.message : "join_failed");
        }
      })();
      sessionRef.current = {
        dispose() {
          disposed = true;
          void room?.leave().catch(() => {});
        },
      };
    }
    return () => {
      disposeTimerRef.current = window.setTimeout(() => {
        sessionRef.current?.dispose();
        sessionRef.current = null;
      }, 0);
    };
    // Remounted by the parent for every new search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const secsLeft = Math.max(0, Math.ceil((view.deadlineAt - now) / 1000));
  const humans = Math.max(1, Math.min(MATCH.MAX_PLAYERS, view.players));
  const launching = view.launching || secsLeft === 0;

  return (
    <div className="mx-auto w-full max-w-lg px-4 py-10 md:py-16">
      <div className="toon-panel bg-[#161b28]/95 p-6 text-center md:p-10">
        <p className="text-xs uppercase tracking-[0.25em] text-white/50">Demo raid</p>
        <h2 className="toon-text mt-2 text-4xl tracking-wide text-zooa-lime md:text-5xl">
          {err ? "Matchmaking failed" : launching ? "Dropping in…" : "Finding raid"}
        </h2>

        {!err && (
          <>
            <p className="mt-5 text-base tracking-wide text-white/80">
              {launching ? (
                "Bots are filling the empty spots"
              ) : (
                <>
                  Bots fill the lobby in{" "}
                  <span className="toon-text-thin text-2xl tabular-nums text-amber-300">{secsLeft}s</span>
                </>
              )}
            </p>

            <ul className="mx-auto mt-7 grid max-w-xs grid-cols-8 gap-1.5" aria-label={`${humans} players waiting`}>
              {Array.from({ length: MATCH.MAX_PLAYERS }, (_, i) => (
                <li
                  key={i}
                  className={clsx(
                    "grid aspect-square place-items-center rounded-lg border-2 border-black",
                    i < humans ? "bg-zooa-lime shadow-[0_2px_0_#000]" : launching ? "bg-sky-300/70" : "bg-white/10",
                  )}
                >
                  {i < humans && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src="/sprites/player.png" alt="" className="h-full w-full p-0.5" draggable={false} />
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm tabular-nums text-white/60">
              {humans} {humans === 1 ? "player" : "players"} waiting · up to {MATCH.MAX_PLAYERS}
            </p>
          </>
        )}

        {err && (
          <p className="mt-5 break-words font-mono text-sm text-rose-300" role="alert">
            {err}
          </p>
        )}

        <button
          type="button"
          onClick={onCancel}
          className="toon-btn-ghost mt-8 min-h-12 w-full max-w-xs text-base tracking-wide"
        >
          {err ? "Back" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
