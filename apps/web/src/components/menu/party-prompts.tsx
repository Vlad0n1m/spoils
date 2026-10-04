"use client";

import { useState } from "react";
import { PARTY } from "@extract/shared";
import { useLobby, useNow, usePlay } from "@/lib/lobby/lobby-context";
import { fmtClockS } from "@/lib/lobby/world-clock";
import { dropPrompt, secondsLeft } from "@/lib/social/menu";
import { playUi } from "@/game/audio/ui-sounds";
import { useParty } from "./party-context";

const BTN =
  "font-body inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border-[3px] border-black px-4 text-sm font-bold shadow-[0_3px_0_#000] transition-[transform,box-shadow] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60";

/**
 * Floating party prompts above PLAY (over panels too, so a member reading the leaderboard still
 * sees them): "Leader is dropping in — PLAY" with the drop's countdown while PLAY could join, and the
 * newest party invite with Join / Decline. × hides a prompt (the invite stays in Friends · Party).
 * Members with "Follow leader" on drop in by themselves (PlayController), so they see no drop prompt.
 */
export function PartyPrompts({ hidden }: { hidden: boolean }) {
  const { registered, toast } = useLobby();
  const { state: party, act } = useParty();
  const { state, joinDrop } = usePlay();
  const now = useNow();
  const [dismissedDrop, setDismissedDrop] = useState<string | null>(null);
  const [dismissedInvite, setDismissedInvite] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!registered || hidden || !party) return null;

  const playKind = state.kind === "error" ? state.base.kind : state.kind;
  const drop = party.party?.follow ? null : dropPrompt({ drop: party.drop, playKind, now, dismissed: dismissedDrop });
  const invite = party.invites.find((i) => `${i.partyId}:${i.expiresAt}` !== dismissedInvite && i.expiresAt > now) ?? null;
  if (!drop && !invite) return null;

  const answer = async (action: "accept" | "decline", partyId: string) => {
    setBusy(true);
    const r = await act("party", action, { partyId });
    setBusy(false);
    toast(r.message);
    playUi(r.ok ? "click" : "error");
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(12.5rem+env(safe-area-inset-bottom))] z-[45] flex flex-col items-center gap-2 px-3 md:bottom-[12rem] [@media(max-height:500px)]:bottom-[calc(5rem+env(safe-area-inset-bottom))]">
      {drop && (
        <section
          aria-label="Party drop"
          className="toon-panel pointer-events-auto flex w-full max-w-md items-center gap-3 bg-[#121722] p-2.5 pl-4 animate-pop-in motion-reduce:animate-none"
        >
          <p className="font-body min-w-0 flex-1 text-sm text-white">
            {/* Only the static line is live: a countdown inside a live region is re-read every second. */}
            <span role="status">
              <b className="font-display text-base tracking-wide text-zooa-lime">{drop.leader}</b> is dropping in
            </span>
            <span className="block text-xs lg:text-[0.8125rem] tabular-nums text-white/75">
              Drop in next to them · <span role="timer">{fmtClockS(drop.secondsLeft)}</span>
            </span>
          </p>
          <button
            type="button"
            onClick={() => {
              playUi("click");
              joinDrop(drop.dropId);
            }}
            className={`${BTN} bg-zooa-lime px-5 text-base text-black`}
          >
            PLAY
          </button>
          <button type="button" onClick={() => setDismissedDrop(drop.dropId)} className={`${BTN} w-11 bg-white px-0 text-black`} aria-label="Hide the drop prompt">
            ✕
          </button>
        </section>
      )}
      {invite && !drop && (
        <section
          aria-label="Party invite"
          className="toon-panel pointer-events-auto flex w-full max-w-md flex-wrap items-center gap-2 bg-[#121722] p-2.5 pl-4 animate-pop-in motion-reduce:animate-none"
        >
          <p className="font-body min-w-0 flex-1 text-sm text-white">
            <b className="font-display text-base tracking-wide text-zooa-lime">{invite.from}</b> invited you to a party
            <span className="block text-xs lg:text-[0.8125rem] tabular-nums text-white/75">
              {invite.size}/{PARTY.MAX_SIZE} · expires in {fmtClockS(secondsLeft(invite.expiresAt, now))}
            </span>
          </p>
          <span className="flex gap-1.5">
            <button type="button" disabled={busy} onClick={() => void answer("accept", invite.partyId)} className={`${BTN} bg-zooa-lime text-black`}>
              Join
            </button>
            <button type="button" disabled={busy} onClick={() => void answer("decline", invite.partyId)} className={`${BTN} bg-white text-black`}>
              Decline
            </button>
            <button
              type="button"
              onClick={() => setDismissedInvite(`${invite.partyId}:${invite.expiresAt}`)}
              className={`${BTN} w-11 bg-[#1d2333] px-0 text-white`}
              aria-label="Hide the invite"
            >
              ✕
            </button>
          </span>
        </section>
      )}
    </div>
  );
}
