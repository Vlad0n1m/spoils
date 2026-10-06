"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { PRESENCE_LABEL, memberChip, readyCount, secondsLeft } from "@/lib/social/menu";
import type { PartyDto, PartyMemberDto } from "@/lib/social/types";
import { fmtClockS } from "@/lib/lobby/world-clock";
import { playUi } from "@/game/audio/ui-sounds";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { CHIP_TONE, PresenceDot } from "./panels/friends-panel";
import { useParty } from "./party-context";

const BTN =
  "font-body inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border-[3px] border-black px-3 text-sm font-bold shadow-[0_3px_0_#000] transition-[transform,box-shadow] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:cursor-not-allowed disabled:opacity-60";

const AVATAR_TONE: Record<PartyMemberDto["presence"], string> = {
  online: "bg-[linear-gradient(180deg,#6f86c0,#3c4c72)] text-white",
  raid: "bg-[linear-gradient(180deg,#7dd3fc,#0284c7)] text-white",
  offline: "bg-zinc-600 text-white/70",
};

function CrossIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}

function PartyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="16.5" cy="8" r="3.2" fill="#9fb3e0" stroke="#000" strokeWidth="1.8" />
      <path d="M11 19.5c0-3.3 2.4-5.6 5.5-5.6s5.5 2.3 5.5 5.6z" fill="#9fb3e0" stroke="#000" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="8.5" cy="7.5" r="3.6" fill="#fff" stroke="#000" strokeWidth="1.8" />
      <path d="M2 20c0-3.7 2.8-6.3 6.5-6.3S15 16.3 15 20z" fill="#fff" stroke="#000" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}

/** A round initial for the stacked avatars of the party button (presence as a small corner dot). */
function Avatar({ m }: { m: PartyMemberDto }) {
  return (
    <span
      className={clsx(
        "menu-label relative grid h-8 w-8 shrink-0 place-items-center rounded-full border-[3px] border-black text-sm leading-none short:h-7 short:w-7",
        AVATAR_TONE[m.presence],
        m.leader && "ring-2 ring-amber-300",
      )}
    >
      <span className="optical-center">{m.nickname.slice(0, 1).toUpperCase()}</span>
      <PresenceDot presence={m.presence} className="absolute -bottom-1 -right-0.5 h-2.5 w-2.5 border" />
    </span>
  );
}

/**
 * Party button above PLAY (only in a party): a compact chip — party icon, the members as stacked
 * initials (leader ringed in amber, presence dot on each) and "2/4 ready" — that opens the party
 * sheet. Replaces the old strip of member chips, which cut nicknames and hid members on phones.
 */
export function PartyButton({ onInvite }: { onInvite: () => void }) {
  const { registered } = useLobby();
  const { state } = useParty();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const party = state?.party ?? null;

  const close = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => btnRef.current?.focus({ preventScroll: true }));
  }, []);
  // Left the party (or got kicked) while the sheet is open: nothing to show.
  useEffect(() => {
    if (!party) setOpen(false);
  }, [party]);

  if (!registered || !party) return null;
  const rc = readyCount(party);
  const shown = party.members.slice(0, 4);
  const extra = party.members.length - shown.length;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-party-button
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Party: ${party.members.length} ${party.members.length === 1 ? "member" : "members"}, ${rc.ready} of ${rc.total} ready. Show members`}
        onClick={() => {
          playUi("click");
          setOpen(true);
        }}
        className="menu-chip min-h-12 gap-2 self-end bg-[#141a29]/95 py-1 pl-2 pr-3 text-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 active:translate-y-[2px] short:min-h-11"
      >
        <PartyIcon className="h-7 w-7 shrink-0 short:h-6 short:w-6" />
        <span className="flex items-center -space-x-1.5" aria-hidden>
          {shown.map((m) => (
            <Avatar key={m.nickname} m={m} />
          ))}
          {extra > 0 && (
            <span className="font-body grid h-8 w-8 place-items-center rounded-full border-[3px] border-black bg-black text-xs font-bold text-white short:h-7 short:w-7">
              +{extra}
            </span>
          )}
        </span>
        <span className="flex flex-col items-start leading-none" aria-hidden>
          <span className="menu-label text-sm tracking-wide short:text-xs">
            <span className="optical-center">Party</span>
          </span>
          <span className="font-body mt-0.5 text-xs font-bold tabular-nums text-white/70">
            {rc.ready}/{rc.total} ready
          </span>
        </span>
      </button>
      {open &&
        createPortal(
          <PartySheet
            party={party}
            onClose={close}
            onInvite={() => {
              setOpen(false);
              onInvite();
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * Party sheet: a side sheet from the right (landscape phones, tablets, desktops; full width on a
 * portrait phone) listing every member with the full nickname (it wraps instead of being cut), the
 * leader's star, "(you)", the level and the state chip (LEADER / READY / NOT READY / IN RAID /
 * OFFLINE). The leader can hand over the lead or kick (tap twice) and cancel pending invites; at the
 * bottom: Follow leader (members), Invite friends (leader with room) and Leave (tap twice). Closes
 * on ×, a tap outside and Esc; focus goes back to the party button.
 */
function PartySheet({ party, onClose, onInvite }: { party: PartyDto; onClose: () => void; onInvite: () => void }) {
  const { toast } = useLobby();
  const { act } = useParty();
  const now = useNow();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  /** The member whose leader actions (Make leader / Kick) are unfolded: one at a time keeps the list short. */
  const [tools, setTools] = useState<string | null>(null);
  const rc = readyCount(party);

  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(null), 3_000);
    return () => window.clearTimeout(t);
  }, [confirm]);

  const run = async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    const r = await act("party", action, body);
    setBusy(false);
    setConfirm(null);
    toast(r.message);
    playUi(r.ok ? "click" : "error");
  };

  return (
    <div
      className="fixed inset-0 z-[50] bg-black/60 pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        // The sheet owns the keyboard: the menu's hotkeys (I, B, F, …) stay off while it is open.
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="toon-panel absolute inset-y-2 right-2 flex w-[min(24rem,calc(100%-1rem))] flex-col overflow-hidden bg-[#141a29] text-white animate-pop-in motion-reduce:animate-none short:inset-y-1.5"
      >
        <header className="flex items-center gap-2 border-b-[3px] border-black bg-[#1d2333] py-1.5 pl-3 pr-1.5 short:py-1">
          <PartyIcon className="h-7 w-7 shrink-0" />
          <h2 id={titleId} className="menu-label flex-1 text-xl leading-none tracking-wide short:text-lg">
            <span className="optical-center">Party</span>{" "}
            <span className="font-body text-sm font-bold tracking-normal text-white/70 [text-shadow:none]">
              {party.members.length}/{party.maxSize} · {rc.ready} ready
            </span>
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close party"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border-[3px] border-black bg-white text-black shadow-[0_3px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
          >
            <CrossIcon className="h-5 w-5" />
          </button>
        </header>

        <ul aria-label="Party members" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain p-2 [scrollbar-width:thin]">
          {party.members.map((m) => {
            const chip = memberChip(m);
            const kick = `kick:${m.nickname}`;
            return (
              <li
                key={m.nickname}
                className={clsx(
                  "flex flex-col gap-1.5 rounded-xl border-[3px] border-black bg-[#1d2333] px-2.5 py-1.5 shadow-[0_3px_0_#000]",
                  m.you && "ring-2 ring-zooa-lime/60",
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PresenceDot presence={m.presence} />
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-base leading-tight tracking-wide text-white">
                      {m.leader && (
                        <span className="mr-1 text-amber-300" aria-label="Leader">
                          ★
                        </span>
                      )}
                      {m.nickname}
                      {m.you && <span className="font-body ml-1 text-xs font-bold text-white/60">(you)</span>}
                    </span>
                    <span className="font-body block text-xs font-semibold text-white/60">
                      Lv {m.level} · {PRESENCE_LABEL[m.presence]}
                    </span>
                  </span>
                  <span className={clsx("font-body shrink-0 rounded-md border-2 border-black px-1.5 text-xs font-bold leading-5", CHIP_TONE[chip.tone])}>
                    {chip.label}
                  </span>
                  {party.isLeader && !m.you && (
                    <button
                      type="button"
                      onClick={() => setTools((t) => (t === m.nickname ? null : m.nickname))}
                      aria-expanded={tools === m.nickname}
                      aria-label={`Actions for ${m.nickname}`}
                      className="-my-1 -mr-1.5 grid h-11 w-9 shrink-0 place-items-center rounded-lg text-xl font-bold leading-none text-white/80 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime"
                    >
                      {tools === m.nickname ? <CrossIcon className="h-4 w-4" /> : <span aria-hidden>⋯</span>}
                    </button>
                  )}
                </div>
                {party.isLeader && !m.you && tools === m.nickname && (
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run("lead", { nickname: m.nickname })}
                      className={clsx(BTN, "min-h-9 flex-1 bg-white px-2 text-xs text-black")}
                      aria-label={`Make ${m.nickname} the leader`}
                    >
                      Make leader
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => (confirm === kick ? void run("kick", { nickname: m.nickname }) : setConfirm(kick))}
                      className={clsx(BTN, "min-h-9 flex-1 px-2 text-xs", confirm === kick ? "bg-rose-400 text-black" : "bg-[#2a3247] text-white")}
                      aria-label={confirm === kick ? `Tap again to remove ${m.nickname}` : `Remove ${m.nickname} from the party`}
                    >
                      {confirm === kick ? "Kick?" : "Kick"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {party.invited.map((i) => (
            <li key={`inv-${i.nickname}`} className="flex items-center gap-2 rounded-xl border-2 border-dashed border-white/25 px-2.5 py-1.5">
              <span className="font-body min-w-0 flex-1 text-sm text-white/70">
                <b className="font-display break-all text-base tracking-wide text-white/85">{i.nickname}</b> · invited ·{" "}
                <span className="tabular-nums">{fmtClockS(secondsLeft(i.expiresAt, now))}</span>
              </span>
              {party.isLeader && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run("uninvite", { nickname: i.nickname })}
                  className={clsx(BTN, "min-h-9 bg-white px-2 text-xs text-black")}
                  aria-label={`Cancel the invite to ${i.nickname}`}
                >
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>

        <footer className="flex flex-wrap items-center gap-1.5 border-t-[3px] border-black bg-[#1d2333] p-2">
          {!party.isLeader && (
            <button
              type="button"
              disabled={busy}
              aria-pressed={party.follow}
              onClick={() => void run("follow", { follow: !party.follow })}
              className={clsx(BTN, "flex-1", party.follow ? "bg-zooa-lime text-black" : "bg-white text-black")}
              title={`Drop in automatically when ${party.leader} presses PLAY`}
            >
              {party.follow ? "✓ Following" : "Follow leader"}
            </button>
          )}
          {party.isLeader && party.members.length + party.invited.length < party.maxSize && (
            <button type="button" onClick={onInvite} className={clsx(BTN, "flex-1 bg-zooa-lime text-black")}>
              + Invite friends
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => (confirm === "leave" ? void run("leave") : setConfirm("leave"))}
            className={clsx(BTN, confirm === "leave" ? "bg-rose-400 text-black" : "bg-[#2a3247] text-white")}
          >
            {confirm === "leave" ? "Leave?" : "Leave"}
          </button>
        </footer>
      </div>
    </div>
  );
}
