"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { memberChip, readyCount } from "@/lib/social/menu";
import { playUi } from "@/game/audio/ui-sounds";
import { useLobby } from "@/lib/lobby/lobby-context";
import { CHIP_TONE, PresenceDot } from "./panels/friends-panel";
import { useParty } from "./party-context";

const SMALL_BTN =
  "font-body inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-[3px] border-black px-3 text-sm font-bold shadow-[0_3px_0_#000] transition-[transform,box-shadow] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60";

/**
 * Party strip above PLAY (only in a party): one chip per member (presence dot, nickname, LEADER /
 * READY / NOT READY / IN RAID / OFFLINE), then the caller's own controls: members toggle "Follow"
 * (their ready state), the leader gets "+" (opens Friends to invite), everyone "Leave" (tap
 * twice). One row of 44 px targets: the member chips scroll sideways on their own (a fade marks a
 * cut edge) while the controls stay pinned on the right, so a narrow phone never paints chips under
 * the buttons; on a phone the labels shorten ("Follow"). On a landscape phone the menu puts the strip
 * beside PLAY.
 */
export function PartyStrip({ onInvite }: { onInvite: () => void }) {
  const { registered, toast } = useLobby();
  const { state, act } = useParty();
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    if (!confirmLeave) return;
    const t = window.setTimeout(() => setConfirmLeave(false), 3_000);
    return () => window.clearTimeout(t);
  }, [confirmLeave]);

  const listRef = useRef<HTMLUListElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setMore((m) => (m.left === left && m.right === right ? m : { left, right }));
  }, []);
  const party = state?.party;
  const memberKey = party?.members.map((m) => `${m.nickname}:${m.presence}:${m.follow ? 1 : 0}`).join("|") ?? "";
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, memberKey]);

  if (!registered || !party) return null;
  const rc = readyCount(party);

  const run = async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    const r = await act("party", action, body);
    setBusy(false);
    setConfirmLeave(false);
    toast(r.message);
    playUi(r.ok ? "click" : "error");
  };

  return (
    <section
      aria-label={`Party, ${rc.ready} of ${rc.total} ready`}
      className="mx-auto mb-2 w-full md:w-[min(34rem,100%)] [@media(max-height:500px)]:mb-0 [@media(max-height:500px)]:min-w-0 [@media(max-height:500px)]:flex-1"
    >
      <div className="flex items-center gap-1.5">
        {/* Members scroll sideways on their own; the controls stay pinned and always visible. */}
        <div className="relative min-w-0 flex-1">
          <ul
            ref={listRef}
            onScroll={measure}
            aria-label="Party members"
            className="flex items-center gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {party.members.map((m) => {
              const chip = memberChip(m);
              return (
                <li
                  key={m.nickname}
                  className={clsx(
                    "flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border-[3px] border-black bg-[#161b28]/95 py-1 pl-2 pr-1.5 shadow-[0_3px_0_#000]",
                    m.you && "ring-2 ring-zooa-lime/60",
                  )}
                >
                  <PresenceDot presence={m.presence} />
                  <span className="max-w-[7rem] truncate text-sm tracking-wide text-white max-sm:max-w-[4.5rem] [@media(max-height:500px)]:max-w-[4.5rem]">
                    {m.leader && (
                      <span className="mr-0.5 text-amber-300" aria-label="Leader">
                        ★
                      </span>
                    )}
                    {m.nickname}
                  </span>
                  <span className={clsx("font-body rounded-md border-2 border-black px-1 text-[0.6rem] font-bold leading-4", CHIP_TONE[chip.tone])}>{chip.label}</span>
                </li>
              );
            })}
          </ul>
          {/* More members to the side: a fade on the cut edge says the row scrolls. */}
          {more.left && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 mb-1 w-6 bg-gradient-to-r from-black/70 to-transparent" />}
          {more.right && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 mb-1 w-8 bg-gradient-to-l from-black/70 to-transparent" />}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 pb-1">
          {!party.isLeader && (
            <button
              type="button"
              disabled={busy}
              aria-pressed={party.follow}
              aria-label={party.follow ? "Following the leader" : "Follow leader"}
              onClick={() => void run("follow", { follow: !party.follow })}
              className={clsx(SMALL_BTN, party.follow ? "bg-zooa-lime text-black" : "bg-white text-black")}
              title="Drop in automatically when the leader presses PLAY"
            >
              {party.follow ? "✓ " : ""}
              <span className="max-sm:hidden [@media(max-height:500px)]:hidden">{party.follow ? "Following" : "Follow leader"}</span>
              <span aria-hidden className="hidden max-sm:inline [@media(max-height:500px)]:inline">
                Follow
              </span>
            </button>
          )}
          {party.isLeader && party.members.length + party.invited.length < party.maxSize && (
            <button type="button" onClick={onInvite} className={clsx(SMALL_BTN, "bg-zooa-lime px-2.5 text-black")} aria-label="Invite friends to the party">
              <span aria-hidden className="text-lg leading-none">
                +
              </span>
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirmLeave ? void run("leave") : setConfirmLeave(true))}
            className={clsx(SMALL_BTN, confirmLeave ? "bg-rose-400 text-black" : "bg-[#1d2333] text-white")}
          >
            {confirmLeave ? "Leave?" : "Leave"}
          </button>
        </div>
      </div>
      <p className="font-body mt-0.5 text-center text-xs text-white/60 [@media(max-height:500px)]:hidden">
        {party.isLeader ? `Your party drops in with you · ${rc.ready}/${rc.total} ready` : `${party.leader} leads · ${rc.ready}/${rc.total} ready`}
      </p>
    </section>
  );
}
