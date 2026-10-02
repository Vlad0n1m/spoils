"use client";

import { useEffect, useRef, useState } from "react";
import type { Room } from "colyseus.js";
import {
  BattleState,
  MATCH,
  ROOMS,
  S2C,
  type JoinTicket,
  type MatchSettlementPayload,
  type OutcomeMsg,
} from "@extract/shared";
import { getColyseusClient } from "@/lib/colyseus";
import { describeRoomExit, errorCodeAndReason, type RoomExit } from "@/lib/room-exit";
import { createHudStore, shallowEqual } from "@/game/hud";
import type { GameRendererApi, HudSnapshot, RendererOptions } from "@/game/types";
import { Hud, useHud } from "./hud";
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
  /** The room closed on us; `exit` explains a kick (e.g. JOINED_ELSEWHERE), null = plain close. */
  onDisconnect: (exit: RoomExit | null) => void;
  onError: (exit: RoomExit) => void;
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
      if (joined.name && joined.name !== ROOMS.BATTLE) {
        // A stale or wrong room id: never feed a non-battle state to the renderer.
        void joined.leave().catch(() => {});
        throw new Error(`unexpected_room_${joined.name}`);
      }
      joined.onMessage(S2C.OUTCOME, (msg: OutcomeMsg) => cb.onOutcome(msg));
      joined.onMessage(S2C.SETTLED, (msg: MatchSettlementPayload) => cb.onSettled(msg));
      joined.onLeave((code, reason) => {
        if (!disposed) cb.onDisconnect(describeRoomExit(code, reason));
      });

      // Dynamic import keeps Pixi out of the server bundle and out of the lobby's first load.
      const mod = await import("@/game/renderer");
      if (disposed) return;
      // src/game/types.ts is the contract; the renderer module is built against it separately.
      const Renderer = mod.GameRenderer as unknown as new (o: RendererOptions) => GameRendererApi;
      renderer = new Renderer({ mountEl, room: joined, onHud: cb.onHud });
      await renderer.start();
    } catch (e) {
      if (disposed) return;
      const { code, reason } = errorCodeAndReason(e);
      cb.onError(
        describeRoomExit(code, reason) ?? {
          title: "Couldn't join the raid",
          message: reason || "battle_join_failed",
          action: "back",
        },
      );
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

/** What this screen itself needs from the HUD: whether to show the loader / outcome overlay. */
function screenSlice(s: HudSnapshot) {
  const self = s.self;
  return {
    hasSelf: Boolean(self),
    selfOut: Boolean(self && (!self.alive || self.extractedAt > 0)),
    phase: s.phase,
  };
}

export function BattleScreen({ ticket, battleRoomId, nickname, onLeave }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ dispose: () => void } | null>(null);
  const disposeTimerRef = useRef<number | undefined>(undefined);
  // The renderer pushes HUD snapshots ~30×/s into this store; React reads throttled slices of it
  // (≤ 10 commits/s) instead of re-rendering the whole tree on every push.
  const [hudStore] = useState(() => createHudStore(EMPTY_HUD));
  const [err, setErr] = useState<RoomExit | null>(null);
  const [outcome, setOutcome] = useState<OutcomeMsg | null>(null);
  const [settlement, setSettlement] = useState<MatchSettlementPayload | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [kick, setKick] = useState<RoomExit | null>(null);

  useEffect(() => {
    // StrictMode runs cleanup + effect back to back: the deferred dispose is cancelled by the
    // second run, so the room is joined once and left only on a real unmount.
    window.clearTimeout(disposeTimerRef.current);
    if (!sessionRef.current && mountRef.current) {
      sessionRef.current = startBattle(mountRef.current, ticket, battleRoomId, {
        onHud: hudStore.push,
        onOutcome: setOutcome,
        onSettled: setSettlement,
        onDisconnect: (exit) => {
          setKick(exit);
          setDisconnected(true);
        },
        onError: setErr,
      });
    }
    return () => {
      disposeTimerRef.current = window.setTimeout(() => {
        sessionRef.current?.dispose();
        sessionRef.current = null;
        hudStore.dispose();
      }, 0);
    };
    // The parent remounts this component (key) for a new battle; props never change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { hasSelf, selfOut, phase } = useHud(hudStore, screenSlice, shallowEqual);
  const overlayVisible = Boolean(outcome) || selfOut || phase === "ended" || disconnected;

  return (
    <div
      className="fixed inset-0 z-[60] overflow-hidden bg-[#0b0f0a]"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={mountRef} className="absolute inset-0 touch-none select-none" />

      {err ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 p-4">
          <div className="toon-panel w-full max-w-md bg-[#161b28]/95 p-8 text-center">
            <h2 className="toon-text text-3xl tracking-wide text-rose-400">{err.title}</h2>
            <p className="font-body mt-4 break-words text-base leading-relaxed text-white/70" role="alert">
              {err.message}
            </p>
            <button type="button" onClick={onLeave} className="toon-btn mt-8 min-h-12 w-full text-lg tracking-wide">
              Back to lobby
            </button>
          </div>
        </div>
      ) : (
        <>
          <Hud store={hudStore} selfNickname={nickname} onLeave={onLeave} />
          {!hasSelf && !overlayVisible && (
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
        raidEnded={phase === "ended" || settlement !== null}
        disconnected={disconnected}
        kick={kick}
        onContinue={onLeave}
      />
    </div>
  );
}
