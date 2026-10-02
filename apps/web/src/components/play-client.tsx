"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MATCH, ROOMS, type JoinTicket } from "@extract/shared";
import { useSession } from "@/lib/session-context";
import { guestPlayUiEnabled } from "@/lib/client-env";
import { parseJsonResponse } from "@/lib/parse-json-response";
import { fmtClock } from "@/lib/items-ui";
import { stageForUser, type PlayStage } from "@/lib/play-stage";
import { MatchmakingPanel } from "./matchmaking-panel";
import { BattleScreen } from "./battle-screen";
import { PlayerInstructions } from "./play-instructions";
import { PlayLeaderboard } from "./play-leaderboard";
import { GuestPlayDialog } from "./guest-play-dialog";
import { Reveal } from "./reveal";
import { RaidLoadoutSummary } from "./lobby/raid-loadout-summary";

interface JoinResponse {
  ticket?: JoinTicket;
  roomName?: string;
  error?: string;
  /** Human-readable reason (loadout errors, gear still in a raid). */
  message?: string;
}

/** Raid card spans the left 7 columns, rules the right 5; recent raids sit under the raid card. */
const lobbyGrid =
  "grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:grid-rows-[auto_auto] lg:gap-10 lg:[grid-template-areas:'raid_raid_raid_raid_raid_raid_raid_rules_rules_rules_rules_rules'_'board_board_board_board_board_board_board_rules_rules_rules_rules_rules']";

export function PlayClient() {
  const { user, loading, refresh } = useSession();
  const [rawStage, setStage] = useState<PlayStage>({ kind: "lobby" });
  /** A search/raid holds the signed ticket of whoever started it; after a sign-out or account switch it is dropped. */
  const stage = stageForUser(rawStage, user?.id);
  const staleStage = stage !== rawStage;
  useEffect(() => {
    if (staleStage) setStage({ kind: "lobby" });
  }, [staleStage]);
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [guestOpen, setGuestOpen] = useState(false);
  /** Bumped after a raid so the recent-raids board refetches. */
  const [boardKey, setBoardKey] = useState(0);

  const startRaid = async () => {
    setJoining(true);
    setJoinErr(null);
    try {
      const res = await fetch("/api/matches/join", { method: "POST", credentials: "include" });
      const data = await parseJsonResponse<JoinResponse>(res);
      if (res.status === 401) {
        await refresh();
        throw new Error("Your session expired — sign in again.");
      }
      if (!res.ok || !data.ticket) throw new Error(data.message ?? data.error ?? "join_failed");
      // The API names the queue; fall back to the shared contract if an older API omits it.
      const roomName = data.roomName || ROOMS.MATCHMAKING;
      setStage({ kind: "matchmaking", ticket: data.ticket, roomName, searchId: Date.now() });
    } catch (e) {
      setJoinErr(e instanceof Error ? e.message : "join_failed");
    } finally {
      setJoining(false);
    }
  };

  const backToLobby = () => {
    setStage({ kind: "lobby" });
    setBoardKey((k) => k + 1);
  };

  if (user && stage.kind === "matchmaking") {
    return (
      <MatchmakingPanel
        key={stage.searchId}
        ticket={stage.ticket}
        roomName={stage.roomName}
        onCancel={() => {
          // Search abandoned: return the locked loadout to the stash right away (the API also
          // expires stale locks after 10 min). A launched raid is refused by the API (in_raid).
          if (!user.isGuest) void fetch("/api/loadout/unlock", { method: "POST", credentials: "include" }).catch(() => {});
          setStage({ kind: "lobby" });
        }}
        onRetry={() => {
          // Fresh ticket + remount (new searchId); a failed join lands back in the lobby with the error.
          setStage({ kind: "lobby" });
          void startRaid();
        }}
        onBattleReady={(battleRoomId) => setStage({ kind: "battle", ticket: stage.ticket, battleRoomId })}
      />
    );
  }

  if (user && stage.kind === "battle") {
    return (
      <BattleScreen
        key={stage.battleRoomId}
        ticket={stage.ticket}
        battleRoomId={stage.battleRoomId}
        nickname={user.nickname}
        onLeave={backToLobby}
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <div className={lobbyGrid}>
        <div className="order-1 min-w-0 lg:order-none lg:[grid-area:raid]">
          {user ? (
            <RaidCard
              nickname={user.nickname}
              isGuest={Boolean(user.isGuest)}
              joining={joining}
              error={joinErr}
              onPlay={startRaid}
            />
          ) : (
            <SignInCard loading={loading} onGuest={() => setGuestOpen(true)} />
          )}
        </div>
        <div className="order-3 min-w-0 lg:order-none lg:[grid-area:rules]">
          <PlayerInstructions />
        </div>
        <div className="order-2 min-w-0 lg:order-none lg:[grid-area:board]">
          <PlayLeaderboard key={boardKey} />
        </div>
      </div>
      <GuestPlayDialog
        open={guestOpen}
        onClose={() => setGuestOpen(false)}
        onSuccess={async () => {
          setGuestOpen(false);
          await refresh();
        }}
      />
    </div>
  );
}

function RaidCard({
  nickname,
  isGuest,
  joining,
  error,
  onPlay,
}: {
  nickname: string;
  isGuest: boolean;
  joining: boolean;
  error: string | null;
  onPlay: () => void;
}) {
  return (
    <Reveal as="section" delay={0} className="toon-panel relative overflow-hidden bg-[#161b28]/95 p-6 md:p-8">
      <div
        className="pointer-events-none absolute -right-10 -top-10 h-56 w-56 rounded-full bg-zooa-lime/15 blur-3xl"
        aria-hidden
      />
      <p className="text-xs uppercase tracking-[0.25em] text-white/50">Raider</p>
      <h1 className="toon-text mt-2 break-words text-4xl tracking-wide text-white md:text-5xl">{nickname}</h1>

      <div className="mt-6">
        {/* Free kit for guests / empty loadouts, otherwise the saved loadout (Loadout tab). */}
        <RaidLoadoutSummary isGuest={isGuest} />
      </div>

      <ul className="mt-6 flex flex-wrap gap-2 text-xs tracking-wide text-white/80">
        <InfoChip>Up to {MATCH.MAX_PLAYERS} raiders</InfoChip>
        <InfoChip>{Math.round(MATCH.DURATION_MS / 60_000)} min raid</InfoChip>
        <InfoChip>Extracts open at {fmtClock(MATCH.EXTRACT_OPEN_AT_MS)}</InfoChip>
        <InfoChip>Bots fill empty spots</InfoChip>
      </ul>

      {error && (
        <p className="font-body mt-5 text-sm font-semibold text-rose-300" role="alert">
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="button"
          onClick={onPlay}
          disabled={joining}
          className="toon-btn min-h-16 px-10 text-2xl tracking-wide md:text-3xl"
        >
          <span className="optical-center">{joining ? "Joining…" : "Play raid"}</span>
        </button>
        {isGuest && (
          <p className="font-body max-w-[34ch] text-sm leading-relaxed text-white/60">
            Playing as a guest.{" "}
            <Link href="/auth/register?next=/play" className="text-zooa-lime underline-offset-4 hover:underline">
              Register
            </Link>{" "}
            to keep your name.
          </p>
        )}
      </div>
    </Reveal>
  );
}

function InfoChip({ children }: { children: React.ReactNode }) {
  return <li className="rounded-full border-2 border-black bg-black/30 px-3 py-1.5">{children}</li>;
}

function SignInCard({ loading, onGuest }: { loading: boolean; onGuest: () => void }) {
  return (
    <Reveal as="section" delay={0} className="toon-panel bg-[#161b28]/95 p-6 text-center md:p-10">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sprites/player.png" alt="" className="mx-auto h-24 w-24 animate-float-sm" draggable={false} />
      <h1 className="toon-text mt-4 text-balance text-4xl tracking-wide text-zooa-lime md:text-5xl">Ready to drop?</h1>
      <p className="font-body mx-auto mt-4 max-w-[44ch] text-base leading-relaxed text-white/70">
        Pick a name to jump into a raid, or sign in to keep your raider and stash.
      </p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {guestPlayUiEnabled && (
          <button
            type="button"
            onClick={onGuest}
            disabled={loading}
            className="toon-btn min-h-14 min-w-[12rem] text-xl tracking-wide"
          >
            <span className="optical-center">Play as guest</span>
          </button>
        )}
        <Link
          href="/auth/login?next=/play"
          className={guestPlayUiEnabled ? "toon-btn-ghost min-h-14 min-w-[8rem] text-base" : "toon-btn min-h-14 min-w-[10rem] text-xl"}
        >
          <span className="optical-center">Sign in</span>
        </Link>
        <Link href="/auth/register?next=/play" className="toon-btn-ghost min-h-14 min-w-[8rem] text-base">
          <span className="optical-center">Register</span>
        </Link>
      </div>
    </Reveal>
  );
}
