"use client";

import Link from "next/link";
import { useState } from "react";
import { FREE_KIT, MATCH, type JoinTicket } from "@extract/shared";
import { useSession } from "@/lib/session-context";
import { guestPlayUiEnabled } from "@/lib/client-env";
import { parseJsonResponse } from "@/lib/parse-json-response";
import { fmtClock } from "@/lib/items-ui";
import { MatchmakingPanel } from "./matchmaking-panel";
import { BattleScreen } from "./battle-screen";
import { PlayerInstructions } from "./play-instructions";
import { PlayLeaderboard } from "./play-leaderboard";
import { GuestPlayDialog } from "./guest-play-dialog";
import { Reveal } from "./reveal";

type Stage =
  | { kind: "lobby" }
  | { kind: "matchmaking"; ticket: JoinTicket; roomName: string; searchId: number }
  | { kind: "battle"; ticket: JoinTicket; battleRoomId: string };

interface JoinResponse {
  ticket?: JoinTicket;
  roomName?: string;
  error?: string;
}

/** Raid card spans the left 7 columns, rules the right 5; recent raids sit under the raid card. */
const lobbyGrid =
  "grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:grid-rows-[auto_auto] lg:gap-10 lg:[grid-template-areas:'raid_raid_raid_raid_raid_raid_raid_rules_rules_rules_rules_rules'_'board_board_board_board_board_board_board_rules_rules_rules_rules_rules']";

export function PlayClient() {
  const { user, loading, refresh } = useSession();
  const [stage, setStage] = useState<Stage>({ kind: "lobby" });
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
      if (!res.ok || !data.ticket || !data.roomName) throw new Error(data.error ?? "join_failed");
      setStage({ kind: "matchmaking", ticket: data.ticket, roomName: data.roomName, searchId: Date.now() });
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
        onCancel={() => setStage({ kind: "lobby" })}
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
        <h2 className="text-sm uppercase tracking-[0.18em] text-white/55">You drop with the free kit</h2>
        <ul className="mt-3 flex flex-wrap gap-3">
          <KitTile icon="/sprites/pistol.png" label="Pistol" note="Free — never lost" />
          <KitTile icon="/sprites/ammo.png" label={`${FREE_KIT.AMMO_LIGHT} light ammo`} note="Auto-pickup more" />
          <KitTile icon="/sprites/bandage.png" label={`${FREE_KIT.BANDAGES} bandage`} note="+25 HP" />
        </ul>
      </div>

      <ul className="mt-6 flex flex-wrap gap-2 text-xs tracking-wide text-white/80">
        <InfoChip>Up to {MATCH.MAX_PLAYERS} raiders</InfoChip>
        <InfoChip>{Math.round(MATCH.DURATION_MS / 60_000)} min raid</InfoChip>
        <InfoChip>Extracts open at {fmtClock(MATCH.EXTRACT_OPEN_AT_MS)}</InfoChip>
        <InfoChip>Bots fill empty spots</InfoChip>
      </ul>

      {error && (
        <p className="mt-5 text-sm text-rose-300" role="alert">
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
          <span className="optical-center">{joining ? "Joining…" : "Play raid (demo)"}</span>
        </button>
        {isGuest && (
          <p className="max-w-[32ch] text-xs leading-relaxed text-white/50">
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

function KitTile({ icon, label, note }: { icon: string; label: string; note: string }) {
  return (
    <li className="flex items-center gap-3 rounded-2xl border-[3px] border-black bg-white/[0.06] py-2 pl-2 pr-4 shadow-[0_3px_0_#000]">
      <span className="grid h-12 w-12 place-items-center rounded-xl border-2 border-black bg-zinc-300/80">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={icon} alt="" className="h-10 w-10 object-contain" draggable={false} />
      </span>
      <span>
        <span className="block text-sm tracking-wide text-white">{label}</span>
        <span className="mt-1 block text-[0.7rem] text-white/50">{note}</span>
      </span>
    </li>
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
      <p className="mx-auto mt-4 max-w-[44ch] text-sm leading-relaxed text-white/60">
        Pick a name to jump into a demo raid, or sign in to keep your raider.
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
