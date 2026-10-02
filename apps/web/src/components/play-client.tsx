"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/lib/session-context";
import { TierPicker } from "./tier-picker";
import { MatchmakingPanel } from "./matchmaking-panel";
import { BattleScreen } from "./battle-screen";
import { PlayerInstructions } from "./play-instructions";
import { PlayLeaderboard } from "./play-leaderboard";
import { Reveal } from "./reveal";

type Stage =
  | { kind: "pick" }
  | { kind: "matchmaking"; entryTierCents: string; mmRoom: string }
  | {
      kind: "battle";
      battleRoomId: string;
      entryTierCents: string;
    };

/** 12-col mosaic: left stack (7) buy-in + leaderboard, right rail (5) rules spanning both rows. */
const playMosaicGrid =
  "grid grid-cols-1 items-start gap-8 lg:grid-cols-12 lg:grid-rows-[auto_auto] lg:gap-10 lg:[grid-template-areas:'buyin_buyin_buyin_buyin_buyin_buyin_buyin_rules_rules_rules_rules_rules'_'board_board_board_board_board_board_board_rules_rules_rules_rules_rules']";

export function PlayClient() {
  const { user, refresh } = useSession();
  const [stage, setStage] = useState<Stage>({ kind: "pick" });

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-6 md:py-10">
        <div className={playMosaicGrid}>
          <div className="order-3 min-w-0 lg:order-none lg:[grid-area:rules]">
            <PlayerInstructions />
          </div>
          <div className="order-2 min-w-0 lg:order-none lg:[grid-area:board]">
            <PlayLeaderboard />
          </div>
          <Reveal
            as="div"
            delay={0}
            className="order-1 min-w-0 rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 text-center shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-10 lg:order-none lg:[grid-area:buyin]"
          >
            <p className="font-display text-balance text-lg leading-snug tracking-wide text-white md:text-xl">
              Sign in or register to play.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/auth/login?next=/play"
                className="font-display inline-flex min-h-11 min-w-[8.5rem] items-center justify-center rounded-full bg-zooa-lime px-6 text-sm tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98]"
              >
                Sign in
              </Link>
              <Link
                href="/auth/register?next=/play"
                className="inline-flex min-h-11 min-w-[8.5rem] items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98]"
              >
                Register
              </Link>
            </div>
          </Reveal>
        </div>
      </div>
    );
  }

  if (stage.kind === "pick") {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-10">
        <div className={playMosaicGrid}>
          <div className="order-3 min-w-0 lg:order-none lg:[grid-area:rules]">
            <PlayerInstructions />
          </div>
          <div className="order-2 min-w-0 lg:order-none lg:[grid-area:board]">
            <PlayLeaderboard />
          </div>
          <div className="order-1 min-w-0 lg:order-none lg:[grid-area:buyin]">
            <TierPicker
              balanceCents={user.balanceCents}
              onDebited={refresh}
              onJoin={(t, mm) =>
                setStage({ kind: "matchmaking", entryTierCents: t, mmRoom: mm })
              }
            />
          </div>
        </div>
      </div>
    );
  }

  if (stage.kind === "matchmaking") {
    return (
      <MatchmakingPanel
        userId={user.id}
        nickname={user.nickname}
        entryTierCents={stage.entryTierCents}
        roomName={stage.mmRoom}
        onCancel={() => setStage({ kind: "pick" })}
        onBattleReady={(battleRoomId) =>
          setStage({
            kind: "battle",
            battleRoomId,
            entryTierCents: stage.entryTierCents,
          })
        }
      />
    );
  }

  if (stage.kind === "battle") {
    return (
      <BattleScreen
        userId={user.id}
        battleRoomId={stage.battleRoomId}
        entryTierCents={stage.entryTierCents}
        onSettled={() => void refresh()}
        onLeave={() => {
          void refresh();
          setStage({ kind: "pick" });
        }}
      />
    );
  }

  return null;
}
