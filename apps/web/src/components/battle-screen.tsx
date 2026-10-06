"use client";

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import type { Room } from "colyseus.js";
import {
  BattleState,
  ROOMS,
  S2C,
  WORLD,
  generateMap,
  mapHash,
  type BattleJoinOptions,
  type JoinTicket,
  type JoinedMsg,
  type MapData,
  type MatchSummaryMsg,
  type OutcomeMsg,
} from "@extract/shared";
import { getColyseusClient } from "@/lib/colyseus";
import { describeRoomExit, errorCodeAndReason, type RoomExit } from "@/lib/room-exit";
import { createHudStore, shallowEqual, type HudStore } from "@/game/hud";
import type { GameRendererApi, HudSnapshot, PanelActions, RendererOptions } from "@/game/types";
import { createRoomInventoryClient } from "@/game/inventory-client";
import { cineExitOf, outcomeHoldMs } from "@/game/outcome-hold";
import { warmSpritesFor } from "@/game/sprite-cache";
import { shouldUseTouch } from "@/game/touch-mode";
import { Hud, useHud } from "./hud";
import { InventoryOverlay } from "./inventory/inventory-overlay";
import { MatchOutcomeOverlay } from "./match-outcome-overlay";
import { ReplayOverlay, SpectateBar, nextMateKey } from "./spectate-replay";
import { writeLastRaidSeen } from "@/lib/lobby/news-seen";
import { RECONNECT, fetchRejoinTicket, reconnectDelayMs, shouldAutoReconnect } from "@/lib/lobby/reconnect";
import { TutorialOverlay } from "./tutorial-overlay";
import { useTouchMode } from "./use-touch-mode";
import { RotateOverlay, usePortrait } from "./rotate-overlay";
import { reloadOnChunkError } from "@/lib/chunk-reload";
import { keepLandscape } from "@/game/orientation";

interface Props {
  ticket: JoinTicket;
  battleRoomId: string;
  nickname: string;
  onLeave: () => void;
  /**
   * Optional: the join was refused with a "retry" reason (RoomExit.action). The menu runs
   * /api/world/join again for a fresh ticket. "exit_settling" calls it at once (the menu waits 2 s,
   * at most 5 times); other retry reasons offer a "Try again" button. Without it only "Back to lobby".
   */
  onRetry?: (exit: RoomExit) => void;
  /** Registered player (guests earn no XP): the HUD shows the extract XP timer. */
  earnsXp?: boolean;
}

const EMPTY_HUD: HudSnapshot = {
  phase: "drop",
  clockMs: 0,
  durationMs: WORLD.MAP_MS,
  extractOpenAtMs: WORLD.EXTRACT_ARM_MS,
  wipeWarn: 0,
  boss: null,
  enteredAtMs: 0,
  self: null,
  aliveCount: 0,
  totalPlayers: 0,
  nearestExtract: null,
  extracts: [],
  interactHint: null,
  killFeed: [],
  pingMs: null,
};

/** What an in-raid overlay (inventory, search panel, full map) gets once the room is joined. */
export interface BattleOverlayContext {
  room: Room<BattleState>;
  /** The local player's key in state.self (S2C.JOINED), null until known. */
  selfKey: () => string | null;
  /** The static map once the renderer built it. */
  map: () => MapData | null;
  hud: HudStore;
}

export interface BattleOverlayInstance {
  node: ReactNode;
  /** True while the overlay owns the mouse (no fire, aim frozen). */
  isInputBlocked?(): boolean;
  /** Panel keys the game input forwards (Tab / T / Esc / M). */
  panelActions?: PanelActions;
  dispose?(): void;
}

export interface BattleOverlay {
  id: string;
  create(ctx: BattleOverlayContext): BattleOverlayInstance;
}

/**
 * In-raid overlays mounted over the canvas (the `<OverlaySlot>` of the critique). Feature lanes
 * register here at the integration step (e.g. the inventory overlay: createRoomInventoryClient +
 * <InventoryOverlay client/>), so they never edit the screen or the renderer themselves.
 */
export const BATTLE_OVERLAYS: BattleOverlay[] = [
  {
    // Tab inventory + search panel. Keys arrive through the renderer's input (panelActions), so
    // bindInventoryHotkeys is NOT used here (it would toggle twice).
    id: "inventory",
    create(ctx) {
      const client = createRoomInventoryClient(ctx.room, {
        selfKey: ctx.selfKey,
        containers: () => ctx.map()?.containers ?? null,
      });
      return {
        node: <InventoryOverlay client={client} />,
        isInputBlocked: client.isBlocking,
        panelActions: {
          toggleInventory: client.toggle,
          // T outside a search would only toast "not searching".
          takeAll: () => {
            if (client.getSnapshot().search) client.takeAll();
          },
          closePanel: () => void client.escape(),
        },
        dispose: client.dispose,
      };
    },
  },
];

/** mapHash of the v2 map, sent on join so the server can log generator drift (computed once). */
let steppeHash: string | null = null;
function clientMapHash(): string {
  if (steppeHash === null) {
    try {
      steppeHash = mapHash(generateMap("steppe"));
    } catch {
      steppeHash = "";
    }
  }
  return steppeHash;
}

interface BattleCallbacks {
  hud: HudStore;
  onHud: (s: HudSnapshot) => void;
  onOutcome: (o: OutcomeMsg) => void;
  onSettled: (p: MatchSummaryMsg) => void;
  onOverlays: (nodes: Array<{ id: string; node: ReactNode }>) => void;
  /** The room closed on us; `exit` explains a kick (e.g. JOINED_ELSEWHERE), null = plain close. */
  onDisconnect: (exit: RoomExit | null) => void;
  onError: (exit: RoomExit) => void;
  /** S2C.JOINED arrived: the raider is on the map with this connection. */
  onJoined?: () => void;
}

/**
 * Joins the battle room and boots the renderer. Lives outside React so a StrictMode
 * mount → unmount → mount cycle does not join the room twice (see the effect below).
 */
function startBattle(mountEl: HTMLElement, ticket: JoinTicket, battleRoomId: string, cb: BattleCallbacks) {
  let disposed = false;
  let room: Room<BattleState> | null = null;
  let renderer: GameRendererApi | null = null;
  let selfKey: string | null = null;
  // The wipe close (CLOSE_CODES.WIPED) is benign once the player has a result on screen.
  let hadOutcome = false;
  const overlays: BattleOverlayInstance[] = [];

  void (async () => {
    try {
      // The server puts us on the map at the join and nothing is drawn until every sprite is in:
      // fetch the renderer module and finish the sprite warm-up (sprite-cache.ts, capped) first, so
      // the time on the map unseen is only the GPU upload. The menu already warmed most of them.
      const rendererMod = import("@/game/renderer");
      rendererMod.catch(() => {});
      await warmSpritesFor();
      if (disposed) return;
      const client = await getColyseusClient();
      // touch: the Alpha Pass "phone" tester task (the server only echoes it into the exit report).
      const options: BattleJoinOptions = { ticket, mapHash: clientMapHash(), ...(shouldUseTouch() ? { touch: true } : {}) };
      const joined = await client.joinById(battleRoomId, options, BattleState);
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
      // JOINED arrives right after the join, long before the renderer module has loaded.
      joined.onMessage(S2C.JOINED, (msg: JoinedMsg) => {
        if (typeof msg?.selfKey === "string" && msg.selfKey) selfKey = msg.selfKey;
        cb.onJoined?.();
      });
      joined.onMessage(S2C.OUTCOME, (msg: OutcomeMsg) => {
        hadOutcome = true;
        cb.onOutcome(msg);
      });
      joined.onMessage(S2C.SETTLED, (msg: MatchSummaryMsg) => cb.onSettled(msg));
      // Party mates' positions (S2C.PARTY, ~2 Hz) start before the renderer module has loaded; the
      // renderer adds its own handler (game/party.ts). This one only keeps the console quiet.
      joined.onMessage(S2C.PARTY, () => {});
      joined.onLeave((code, reason) => {
        if (!disposed) cb.onDisconnect(describeRoomExit(code, reason, { hadOutcome }));
      });

      // Dynamic import keeps Pixi out of the server bundle and out of the lobby's first load.
      const mod = await rendererMod;
      if (disposed) return;
      // src/game/types.ts is the contract; the renderer module is built against it separately.
      const Renderer = mod.GameRenderer as unknown as new (o: RendererOptions) => GameRendererApi;
      const ctx: BattleOverlayContext = {
        room: joined,
        selfKey: () => selfKey ?? renderer?.selfKey?.() ?? null,
        map: () => renderer?.map?.() ?? null,
        hud: cb.hud,
      };
      for (const o of BATTLE_OVERLAYS) {
        try {
          overlays.push(o.create(ctx));
        } catch (err) {
          console.error(`[battle] overlay ${o.id} failed`, err);
        }
      }
      // First overlay that handles a panel key wins.
      const panel = (k: keyof PanelActions) => () => {
        for (const o of overlays) {
          const f = o.panelActions?.[k];
          if (f) return f();
        }
      };
      // Only forward a key some overlay handles: an unhandled M must stay with the map system.
      const has = (k: keyof PanelActions) => overlays.some((o) => o.panelActions?.[k]);
      renderer = new Renderer({
        mountEl,
        room: joined,
        onHud: cb.onHud,
        selfKey: () => selfKey,
        isInputBlocked: () => overlays.some((o) => o.isInputBlocked?.() === true),
        panelActions: overlays.some((o) => o.panelActions)
          ? {
              toggleInventory: panel("toggleInventory"),
              takeAll: has("takeAll") ? panel("takeAll") : undefined,
              closePanel: panel("closePanel"),
              toggleMap: has("toggleMap") ? panel("toggleMap") : undefined,
            }
          : undefined,
      });
      cb.onOverlays(overlays.map((o, i) => ({ id: BATTLE_OVERLAYS[i]?.id ?? String(i), node: o.node })));
      await renderer.start();
    } catch (e) {
      if (disposed) return;
      // A page opened before a deploy asks for chunks that no longer exist: reload into the new build.
      if (reloadOnChunkError(e)) return;
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
    /** The renderer once booted (spectate / replay controls), else null. */
    renderer: () => renderer,
    dispose() {
      disposed = true;
      renderer?.stop();
      for (const o of overlays.splice(0)) {
        try {
          o.dispose?.();
        } catch {
          /* best effort */
        }
      }
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
    /** Which canvas beat plays (cinematics.ts): the overlay waits for it. */
    selfExit: cineExitOf(self, null),
    phase: s.phase,
    enteredAtMs: s.enteredAtMs,
  };
}

const killTallySlice = (s: HudSnapshot) => s.killTally ?? null;

/** Death replay and spectate state the screen itself switches on. */
function afterRunSlice(s: HudSnapshot) {
  const sp = s.spectate;
  return {
    replayAvailable: s.replay?.available ?? false,
    replayPlaying: s.replay?.playing ?? false,
    replayAuto: s.replay?.autoPlay ?? true,
    watching: sp?.watching?.key ?? null,
    pending: sp?.pending ?? false,
    // Joined to one string so the slice compares by value (the renderer builds a new array each push).
    mates: sp ? sp.mates.map((m) => `${m.key}\u0001${m.name}`).join("\u0002") : "",
    endedReason: sp?.ended?.reason ?? null,
    endedName: sp?.ended?.name ?? "",
  };
}

function parseMates(s: string): Array<{ key: string; name: string }> {
  if (!s) return [];
  return s.split("\u0002").map((x) => {
    const [key = "", name = ""] = x.split("\u0001");
    return { key, name };
  });
}

export function BattleScreen({ ticket, battleRoomId, nickname, onLeave, onRetry, earnsXp = true }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sessionRef = useRef<{ dispose: () => void; renderer: () => GameRendererApi | null } | null>(null);
  /** Mounted (StrictMode-safe): a reconnect finishing after unmount does nothing. */
  const alive = useRef(true);
  const disposeTimerRef = useRef<number | undefined>(undefined);
  // The renderer pushes HUD snapshots ~30×/s into this store; React reads throttled slices of it
  // (≤ 10 commits/s) instead of re-rendering the whole tree on every push.
  const [hudStore] = useState(() => createHudStore(EMPTY_HUD));
  const [err, setErr] = useState<RoomExit | null>(null);
  const [outcome, setOutcome] = useState<OutcomeMsg | null>(null);
  const [settlement, setSettlement] = useState<MatchSummaryMsg | null>(null);
  const [overlayNodes, setOverlayNodes] = useState<Array<{ id: string; node: ReactNode }>>([]);
  const [disconnected, setDisconnected] = useState(false);
  const [kick, setKick] = useState<RoomExit | null>(null);
  /** Automatic reconnect after a socket drop mid-raid: the try in progress (1..MAX_TRIES), 0 = none. */
  const [reconnecting, setReconnecting] = useState(0);
  const reconnectTries = useRef(0);
  const reconnectTimer = useRef<number | undefined>(undefined);
  const outcomeRef = useRef<OutcomeMsg | null>(null);
  const retryRef = useRef(onRetry);
  useEffect(() => {
    retryRef.current = onRetry;
  });

  // "Settling your last raid…": the menu re-runs the join by itself (after 2 s, at most 5 times).
  useEffect(() => {
    if (err?.code === "exit_settling") retryRef.current?.(err);
  }, [err]);

  useEffect(() => {
    // StrictMode runs cleanup + effect back to back: the deferred dispose is cancelled by the
    // second run, so the room is joined once and left only on a real unmount.
    window.clearTimeout(disposeTimerRef.current);
    // A socket drop mid-raid (not a kick, no outcome yet): fetch a rejoin-only ticket and reconnect
    // in place, RECONNECT.MAX_TRIES times with backoff, before the exit screen shows. The server keeps
    // an out-of-combat raider hidden and safe meanwhile (WORLD.DISCONNECT_SHELTER_MS).
    const giveUp = (exit: RoomExit | null) => {
      setReconnecting(0);
      setKick(exit);
      setDisconnected(true);
    };
    const scheduleReconnect = (exit: RoomExit) => {
      const n = ++reconnectTries.current;
      if (n > RECONNECT.MAX_TRIES) return giveUp(exit);
      setReconnecting(n);
      reconnectTimer.current = window.setTimeout(() => {
        void (async () => {
          sessionRef.current?.dispose();
          sessionRef.current = null;
          const r = await fetchRejoinTicket();
          if (!alive.current) return;
          if (!r.ok) return r.final ? giveUp(exit) : scheduleReconnect(exit);
          if (!mountRef.current) return;
          sessionRef.current = startBattle(mountRef.current, r.ticket, r.roomId, callbacks(r.ticket, exit));
        })();
      }, reconnectDelayMs(n));
    };
    const callbacks = (t: JoinTicket, lastDrop: RoomExit | null): BattleCallbacks => ({
      hud: hudStore,
      onHud: hudStore.push,
      onOverlays: setOverlayNodes,
      onOutcome: (o) => {
        outcomeRef.current = o;
        setOutcome(o);
        // The outcome screen already shows this raid's result: the menu must not repeat it as a card.
        if (t.entryId) writeLastRaidSeen(t.entryId);
      },
      onSettled: setSettlement,
      onJoined: () => {
        reconnectTries.current = 0;
        setReconnecting(0);
      },
      onDisconnect: (exit) => {
        if (shouldAutoReconnect(exit, outcomeRef.current !== null)) return scheduleReconnect(exit!);
        giveUp(exit);
      },
      // A reconnect whose room join fails tries again (then gives up with the drop's message).
      onError: (exit) => (lastDrop ? scheduleReconnect(lastDrop) : setErr(exit)),
    });
    alive.current = true;
    if (!sessionRef.current && mountRef.current) {
      sessionRef.current = startBattle(mountRef.current, ticket, battleRoomId, callbacks(ticket, null));
    }
    return () => {
      alive.current = false;
      window.clearTimeout(reconnectTimer.current);
      disposeTimerRef.current = window.setTimeout(() => {
        sessionRef.current?.dispose();
        sessionRef.current = null;
        hudStore.dispose();
      }, 0);
    };
    // The parent remounts this component (key) for a new battle; props never change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { hasSelf, selfOut, selfExit, phase, enteredAtMs } = useHud(hudStore, screenSlice, shallowEqual);
  // The renderer keeps the same tally object until a kill lands, so identity is enough here.
  const killTally = useHud(hudStore, killTallySlice);
  const touch = useTouchMode();
  const portrait = usePortrait();
  // Phones: ask for landscape for the whole raid (manifest + TWA ask too; refusals are ignored).
  useEffect(() => (touch ? keepLandscape() : undefined), [touch]);
  // The extraction / death cinematic plays on the canvas first; the overlay's dim and card would
  // hide it. Once the hold ran out it stays (one battle per mount).
  const cineExit = selfExit ?? cineExitOf(null, outcome?.exit);
  const holdMs = outcomeHoldMs(cineExit, phase, disconnected);
  const [holdDone, setHoldDone] = useState(false);
  useEffect(() => {
    if (!cineExit || holdMs === 0) return;
    const t = window.setTimeout(() => setHoldDone(true), holdMs);
    return () => window.clearTimeout(t);
  }, [cineExit, holdMs]);

  // After the run: the death replay (once by itself, game/killcam.ts) and watching a party mate.
  const after = useHud(hudStore, afterRunSlice, shallowEqual);
  const mates = parseMates(after.mates);
  const [replayAutoDone, setReplayAutoDone] = useState(false);
  const replayDue =
    cineExit === "death" && holdDone && !replayAutoDone && after.replayAvailable && after.replayAuto && !disconnected && phase !== "ended";
  useEffect(() => {
    if (!replayDue) return;
    setReplayAutoDone(true);
    sessionRef.current?.renderer()?.startReplay?.();
  }, [replayDue]);
  const watchingNow = after.watching !== null || after.pending;
  const spectate = useCallback((key: string | null) => sessionRef.current?.renderer()?.spectate?.(key), []);
  const skipReplay = useCallback(() => sessionRef.current?.renderer()?.stopReplay?.(), []);
  const watchReplay = useCallback(() => {
    sessionRef.current?.renderer()?.startReplay?.();
  }, []);
  const canWatchMates = !disconnected && phase !== "ended" && mates.length > 0;

  const overlayVisible =
    (phase === "ended" || disconnected || ((Boolean(outcome) || selfOut) && (holdMs === 0 || holdDone))) &&
    !(after.replayPlaying && !disconnected) &&
    !replayDue &&
    !(watchingNow && !disconnected && phase !== "ended");

  return (
    <div
      className="fixed inset-0 z-[60] overflow-hidden bg-[#0b0f0a]"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* viewport-fit=cover: the canvas fills the whole screen, under a landscape phone's camera
          cutout and home indicator too. What the player reads or taps stays inside the safe area:
          the HUD (hud.tsx) and the touch controls (touch-controls.ts) by the --safe-* insets
          (globals.css), the canvas HUD (minimap, full map, party arrows) by game/safe-area.ts. */}
      <div ref={mountRef} className="absolute inset-0 touch-none select-none" />

      {err ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 p-4">
          <div className="toon-panel w-full max-w-md bg-[#161b28]/95 p-8 text-center">
            <h2 className="toon-text text-3xl tracking-wide text-rose-400">{err.title}</h2>
            <p className="font-body mt-4 break-words text-base leading-relaxed text-white/70" role="alert">
              {err.message}
            </p>
            {err.action === "retry" && onRetry && err.code !== "exit_settling" && (
              <button
                type="button"
                onClick={() => onRetry(err)}
                className="toon-btn mt-8 min-h-12 w-full text-lg tracking-wide"
              >
                Try again
              </button>
            )}
            <button
              type="button"
              onClick={onLeave}
              className={clsx(
                "toon-btn min-h-12 w-full text-lg tracking-wide",
                err.action === "retry" && onRetry && err.code !== "exit_settling" ? "mt-3 opacity-80" : "mt-8",
              )}
            >
              Back to lobby
            </button>
          </div>
        </div>
      ) : (
        <>
          <Hud store={hudStore} selfNickname={nickname} onLeave={onLeave} earnsXp={earnsXp} />
          {/* Alpha first raid (JoinTicket.tutorial): step-by-step hints until the extract. */}
          {ticket.tutorial && hasSelf && !overlayVisible && <TutorialOverlay store={hudStore} touch={touch} />}
          {overlayNodes.map((o) => (
            <Fragment key={o.id}>{o.node}</Fragment>
          ))}
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

      {!err && reconnecting > 0 && !disconnected && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black/40" role="status" aria-live="polite">
          <div className="toon-panel flex items-center gap-3 px-6 py-4 text-xl tracking-wide">
            <span className="h-6 w-6 animate-spin rounded-full border-4 border-black border-t-zooa-lime motion-reduce:animate-none" aria-hidden />
            <span className="toon-text-thin">
              Reconnecting… {reconnecting}/{RECONNECT.MAX_TRIES}
            </span>
          </div>
        </div>
      )}
      {!err && after.replayPlaying && !disconnected && <ReplayOverlay store={hudStore} onSkip={skipReplay} />}
      {!err && watchingNow && !disconnected && phase !== "ended" && (
        <SpectateBar
          store={hudStore}
          touch={touch}
          onNext={() => {
            const k = nextMateKey(mates, after.watching);
            if (k && k !== after.watching) spectate(k);
          }}
          onStop={() => spectate(null)}
          onLeave={onLeave}
        />
      )}

      {touch && portrait && <RotateOverlay />}

      <MatchOutcomeOverlay
        visible={!err && overlayVisible}
        spectate={
          canWatchMates || after.endedReason
            ? {
                mates: canWatchMates ? mates : [],
                ended: after.endedReason ? { reason: after.endedReason, name: after.endedName } : null,
                onSpectate: spectate,
              }
            : null
        }
        onWatchReplay={after.replayAvailable && !disconnected && phase !== "ended" ? watchReplay : undefined}
        outcome={outcome}
        settlement={settlement}
        raidEnded={phase === "ended" || settlement !== null}
        disconnected={disconnected}
        kick={kick}
        killTally={killTally}
        enteredAtMs={enteredAtMs}
        onContinue={onLeave}
      />
    </div>
  );
}
