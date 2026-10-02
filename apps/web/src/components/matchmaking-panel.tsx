"use client";

import { useEffect, useRef, useState } from "react";
import { Room } from "colyseus.js";
import { getColyseusClient } from "@/lib/colyseus";
import { MIN_PLAYERS } from "@extract/shared";

interface Props {
  userId: string;
  nickname: string;
  entryTierCents: string;
  roomName: string;
  onCancel: () => void;
  onBattleReady: (battleRoomId: string) => void;
}

export function MatchmakingPanel(props: Props) {
  const [count, setCount] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const roomRef = useRef<Room | null>(null);
  /** Wall-clock start of this search; replaced by server `startedAt` when state arrives. */
  const searchStartedAtMs = useRef<number>(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsedSec(
        Math.floor((Date.now() - searchStartedAtMs.current) / 1000),
      );
    }, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const client = await getColyseusClient();
        const room = await client.joinOrCreate(props.roomName, {
          userId: props.userId,
          nickname: props.nickname,
          entryTierCents: props.entryTierCents,
        });
        if (cancelled) {
          room.leave();
          return;
        }
        roomRef.current = room;
        room.onStateChange((state: any) => {
          setCount(state.players?.length ?? 0);
          if (typeof state.startedAt === "number" && state.startedAt > 0) {
            searchStartedAtMs.current = state.startedAt;
          }
        });
        room.onMessage("battle_ready", (msg: any) => {
          props.onBattleReady(msg.battleRoomId);
        });
        room.onError((code, message) => setErr(message ?? `error_${code}`));
      } catch (e: any) {
        setErr(e?.message ?? "join_failed");
      }
    })();
    return () => {
      cancelled = true;
      roomRef.current?.leave().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.roomName]);

  const cancel = () => {
    roomRef.current?.leave().catch(() => {});
    props.onCancel();
  };

  return (
    <div className="mx-auto w-full max-w-md px-4 py-12 md:px-6">
      <div className="rounded-[2rem] border border-white/10 bg-zooa-dark/85 p-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-10">
        <h2 className="font-display text-2xl tracking-wide text-[#c4f07a]">Finding match</h2>
        <p className="mt-2 text-sm text-white/55">When the room fills, the battle starts automatically.</p>
        <p className="mt-8 font-mono text-5xl tabular-nums tracking-tight text-zooa-lime">{elapsedSec}s</p>
        <p className="mt-3 text-sm text-white/60">
          Players{" "}
          <span className="font-mono text-white/90">
            {count} / {MIN_PLAYERS}
          </span>
        </p>
        {err && (
          <p className="mt-4 text-sm text-rose-300/90" role="alert">
            {err}
          </p>
        )}
        <button
          type="button"
          onClick={cancel}
          className="mt-8 inline-flex min-h-11 w-full max-w-xs items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98] sm:mx-auto"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
