"use client";

import { useEffect, useRef, useState } from "react";
import { Room } from "colyseus.js";
import {
  BattleState,
  type MatchSettlementPayload,
  type PlayerOutcomePayload,
} from "@extract/shared";
import { getColyseusClient } from "@/lib/colyseus";
import type { GameRenderer } from "@/game/renderer";
import { Hud } from "./hud";
import { Leaderboard } from "./leaderboard";
import { MatchOutcomeOverlay } from "./match-outcome-overlay";

interface Props {
  userId: string;
  battleRoomId: string;
  entryTierCents: string;
  onSettled?: (payload: MatchSettlementPayload) => void;
  onLeave: () => void;
}

export interface HudSnapshot {
  phase: "lockin" | "open" | "ended";
  clockMs: number;
  selfMassUnits: string;
  selfAlive: boolean;
  selfDiedAt: number;
  selfExtractStartedAt: number;
  selfExtractedAt: number;
  selfExitOrder: number;
  zoneRadius: number;
  leaderboard: Array<{ nickname: string; mass: string; alive: boolean }>;
}

const EMPTY_HUD: HudSnapshot = {
  phase: "lockin",
  clockMs: 0,
  selfMassUnits: "0",
  selfAlive: true,
  selfDiedAt: 0,
  selfExtractStartedAt: 0,
  selfExtractedAt: 0,
  selfExitOrder: 0,
  zoneRadius: 0,
  leaderboard: [],
};

type OutOverlay = "off" | "fading" | "content";

export function BattleScreen(props: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<GameRenderer | null>(null);
  const roomRef = useRef<Room | null>(null);
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);
  const [pingMs, setPingMs] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [overlayPhase, setOverlayPhase] = useState<OutOverlay>("off");
  const [settlement, setSettlement] = useState<MatchSettlementPayload | null>(null);
  const [playerOutcome, setPlayerOutcome] = useState<PlayerOutcomePayload | null>(null);
  const fadeStartedRef = useRef(false);
  const pingIntervalRef = useRef<number | undefined>(undefined);

  const personalOut =
    hud.selfExtractedAt > 0 || hud.selfDiedAt > 0;

  useEffect(() => {
    if (fadeStartedRef.current || !personalOut) return;
    fadeStartedRef.current = true;
    setOverlayPhase("fading");
    const t = window.setTimeout(() => setOverlayPhase("content"), 1000);
    return () => window.clearTimeout(t);
  }, [personalOut]);

  useEffect(() => {
    if (!settlement || fadeStartedRef.current) return;
    fadeStartedRef.current = true;
    setOverlayPhase("fading");
    const t = window.setTimeout(() => setOverlayPhase("content"), 1000);
    return () => window.clearTimeout(t);
  }, [settlement]);

  useEffect(() => {
    let cancelled = false;
    setPingMs(null);
    (async () => {
      try {
        const client = await getColyseusClient();
        const room = await client.joinById(
          props.battleRoomId,
          { userId: props.userId },
          BattleState,
        );
        if (cancelled) {
          room.leave();
          return;
        }
        roomRef.current = room;
        room.onMessage("pong", (msg: { t?: number }) => {
          if (cancelled) return;
          if (typeof msg?.t === "number" && Number.isFinite(msg.t)) {
            setPingMs(Math.round(performance.now() - msg.t));
          }
        });
        pingIntervalRef.current = window.setInterval(() => {
          if (cancelled) return;
          room.send("ping", { t: performance.now() });
        }, 1500);
        room.send("ping", { t: performance.now() });
        room.onMessage("player_outcome", (msg: PlayerOutcomePayload) => {
          if (msg.userId === props.userId) setPlayerOutcome(msg);
        });
        room.onMessage("settled", (payload: MatchSettlementPayload) => {
          setSettlement(payload);
          setPlayerOutcome(null);
          props.onSettled?.(payload);
        });
        room.onLeave(() => {
          // ignore for now
        });
        // Dynamic import so Pixi (and its browser env chunk) only load in this client effect,
        // which avoids Next dev "Loading chunk … environment-brow … failed" after HMR.
        const { GameRenderer } = await import("@/game/renderer");
        const renderer = new GameRenderer({
          mountEl: containerRef.current!,
          room,
          selfUserId: props.userId,
          onHud: setHud,
        });
        rendererRef.current = renderer;
        await renderer.start();
      } catch (e: any) {
        if (pingIntervalRef.current) {
          clearInterval(pingIntervalRef.current);
          pingIntervalRef.current = undefined;
        }
        setErr(e?.message ?? "battle_join_failed");
      }
    })();
    return () => {
      cancelled = true;
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = undefined;
      }
      rendererRef.current?.stop();
      roomRef.current?.leave().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.battleRoomId]);

  if (err) {
    return (
      <div className="mx-auto w-full max-w-md px-4 py-16 md:px-6">
        <div className="rounded-[2rem] border border-white/10 bg-zooa-dark/85 p-8 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur">
          <p className="text-rose-300/90" role="alert">
            {err}
          </p>
          <button
            type="button"
            onClick={props.onLeave}
            className="mt-6 inline-flex min-h-11 w-full max-w-xs items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98] sm:mx-auto"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div
        ref={containerRef}
        className="absolute inset-0 touch-none select-none"
      />
      <Hud
        snapshot={hud}
        pingMs={pingMs}
        onForfeit={props.onLeave}
      />
      <Leaderboard entries={hud.leaderboard} />
      <MatchOutcomeOverlay
        phase={overlayPhase}
        settlement={settlement}
        playerOutcome={playerOutcome}
        userId={props.userId}
        entryTierCents={props.entryTierCents}
        arenaPhase={hud.phase}
        clockMs={hud.clockMs}
        selfDiedAt={hud.selfDiedAt}
        selfExtractedAt={hud.selfExtractedAt}
        selfExitOrder={hud.selfExitOrder}
        onContinue={props.onLeave}
      />
    </div>
  );
}
