"use client";

import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import {
  BattleState,
  MATCH,
  S2C,
  type JoinTicket,
  type MatchSettlementPayload,
  type OutcomeMsg,
} from "@extract/shared";
import { getColyseusClient } from "@/lib/colyseus";
import type { GameRendererApi, HudSnapshot, RendererOptions } from "@/game/types";
import { Hud } from "./hud";
import { MatchOutcomeOverlay } from "./match-outcome-overlay";

interface Props {
  ticket: JoinTicket;
  battleRoomId: string;
  nickname: string;
  onLeave: () => void;
}

const EMPTY_HUD: HudSnapshot = {
  phase: "drop",
  clockMs: 0,
  durationMs: MATCH.DURATION_MS,
  extractOpenAtMs: MATCH.EXTRACT_OPEN_AT_MS,
  self: null,
  aliveCount: 0,
  totalPlayers: 0,
  nearestExtract: null,
  interactHint: null,
  killFeed: [],
  pingMs: null,
};

interface BattleCallbacks {
  onHud: (s: HudSnapshot) => void;
  onOutcome: (o: OutcomeMsg) => void;
  onSettled: (p: MatchSettlementPayload) => void;
  onDisconnect: () => void;
  onError: (message: string) => void;
}

/**
 * Joins the battle room and boots the renderer. Lives outside React so a StrictMode
 * mount → unmount → mount cycle does not join the room twice (see the effect below).
 */
function startBattle(mountEl: HTMLElement, ticket: JoinTicket, battleRoomId: string, cb: BattleCallbacks) {
  let disposed = false;
  let room: Room<BattleState> | null = null;
  let renderer: GameRendererApi | null = null;

  void (async () => {
    try {
      const client = await getColyseusClient();
      const joined = await client.joinById(battleRoomId, { ticket }, BattleState);
      if (disposed) {
        void joined.leave().catch(() => {});
        return;
      }
      room = joined;
      joined.onMessage(S2C.OUTCOME, (msg: OutcomeMsg) => cb.onOutcome(msg));
      joined.onMessage(S2C.SETTLED, (msg: MatchSettlementPayload) => cb.onSettled(msg));
      joined.onLeave(() => {
        if (!disposed) cb.onDisconnect();
      });

      // Dynamic import keeps Pixi out of the server bundle and out of the lobby's first load.
      const mod = await import("@/game/renderer");
      if (disposed) return;
      // src/game/types.ts is the contract; the renderer module is built against it separately.
      const Renderer = mod.GameRenderer as unknown as new (o: RendererOptions) => GameRendererApi;
      renderer = new Renderer({ mountEl, room: joined, onHud: cb.onHud });
      await renderer.start();
    } catch (e) {
      if (!disposed) cb.onError(e instanceof Error ? e.message : "battle_join_failed");
    }
  })();

  return {
    dispose() {
      disposed = true;
      renderer?.stop();
      void room?.leave().catch(() => {});
    },
  };
}

export function BattleScreen({ ticket, battleRoomId, nickname, onLeave }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ dispose: () => void } | null>(null);
  const disposeTimerRef = useRef<number | undefined>(undefined);
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);
  const [err, setErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<OutcomeMsg | null>(null);
  const [settlement, setSettlement] = useState<MatchSettlementPayload | null>(null);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    // StrictMode runs cleanup + effect back to back: the deferred dispose is cancelled by the
    // second run, so the room is joined once and left only on a real unmount.
    window.clearTimeout(disposeTimerRef.current);
    if (!sessionRef.current && mountRef.current) {
      sessionRef.current = startBattle(mountRef.current, ticket, battleRoomId, {
        onHud: setHud,
        onOutcome: setOutcome,
        onSettled: setSettlement,
        onDisconnect: () => setDisconnected(true),
        onError: setErr,
      });
    }
    return () => {
      disposeTimerRef.current = window.setTimeout(() => {
        sessionRef.current?.dispose();
        sessionRef.current = null;
      }, 0);
    };
    // The parent remounts this component (key) for a new battle; props never change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const self = hud.self;
  const selfOut = Boolean(self && (!self.alive || self.extractedAt > 0));
  const overlayVisible = Boolean(outcome) || selfOut || hud.phase === "ended" || disconnected;

  return (
    <div
      className="fixed inset-0 z-[60] overflow-hidden bg-[#0b0f0a]"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={mountRef} className="absolute inset-0 touch-none select-none" />

      {err ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 p-4">
          <div className="toon-panel w-full max-w-md bg-[#161b28]/95 p-8 text-center">
            <h2 className="toon-text text-3xl tracking-wide text-rose-400">Couldn&apos;t join the raid</h2>
            <p className="mt-4 break-words font-mono text-sm text-white/60" role="alert">
              {err}
            </p>
            <button type="button" onClick={onLeave} className="toon-btn mt-8 min-h-12 w-full text-lg tracking-wide">
              Back to lobby
            </button>
          </div>
        </div>
      ) : (
        <>
          <Hud snapshot={hud} selfNickname={nickname} onLeave={onLeave} />
          {!self && !overlayVisible && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="toon-panel flex items-center gap-3 px-6 py-4 text-xl tracking-wide">
                <span className="h-6 w-6 animate-spin rounded-full border-4 border-black border-t-zooa-lime" aria-hidden />
                <span className="toon-text-thin">Dropping in…</span>
              </div>
            </div>
          )}
        </>
      )}

      <MatchOutcomeOverlay
        visible={!err && overlayVisible}
        outcome={outcome}
        settlement={settlement}
        raidEnded={hud.phase === "ended" || settlement !== null}
        disconnected={disconnected}
        onContinue={onLeave}
      />
    </div>
  );
}
