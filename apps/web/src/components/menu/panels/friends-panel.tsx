"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { PARTY } from "@extract/shared";
import { useLobby, useNow } from "@/lib/lobby/lobby-context";
import { panelHref } from "@/lib/lobby/panels";
import { fmtClockS } from "@/lib/lobby/world-clock";
import { PRESENCE_LABEL, canInvite, inviteBlockReason, memberChip, secondsLeft, type ChipTone } from "@/lib/social/menu";
import type { FriendDto, FriendsDto, PartyDto, PartyInviteDto, Presence } from "@/lib/social/types";
import { playUi } from "@/game/audio/ui-sounds";
import { Paged } from "@/components/paged";
import { LevelBadge } from "../level-badge";
import { useParty, type ActResult } from "../party-context";

const REFRESH_MS = 15_000;

const BTN =
  "font-body inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl border-[3px] border-black px-3 text-sm font-bold shadow-[0_3px_0_#000] transition-[transform,box-shadow] active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:cursor-not-allowed disabled:opacity-60";
const BTN_LIME = `${BTN} bg-zooa-lime text-black`;
const BTN_WHITE = `${BTN} bg-white text-black`;
const BTN_DARK = `${BTN} bg-[#1d2333] text-white`;

const DOT: Record<Presence, string> = { raid: "bg-sky-400", online: "bg-zooa-lime", offline: "bg-zinc-500" };
export const CHIP_TONE: Record<ChipTone, string> = {
  lime: "bg-zooa-lime text-black",
  sky: "bg-sky-300 text-black",
  amber: "bg-amber-300 text-black",
  grey: "bg-zinc-500 text-black",
};

export function PresenceDot({ presence, className }: { presence: Presence; className?: string }) {
  return <span className={clsx("inline-block h-3 w-3 shrink-0 rounded-full border-2 border-black", DOT[presence], className)} aria-hidden />;
}

/**
 * Friends (menu panel, drawer from the right): Friends (add by nickname, presence, invite to the
 * party, remove), Requests (incoming accept / decline, outgoing cancel), Party (members, ready state,
 * leader tools, invites). Registered users only; guests and signed-out viewers get a register prompt.
 */
export function FriendsPanel({ tab, onTab }: { tab: string; onTab: (t: string) => void }) {
  const { registered, sessionLoading, sessionKind, visible } = useLobby();
  const { state, act, version } = useParty();
  const [data, setData] = useState<FriendsDto | null>(null);
  const [error, setError] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const res = await fetch("/api/friends", { credentials: "include", cache: "no-store" });
      const body = (await res.json().catch(() => null)) as FriendsDto | null;
      if (my !== seq.current) return;
      if (!res.ok || !body || !Array.isArray(body.friends)) throw new Error("bad");
      setData(body);
      setError(false);
    } catch {
      if (my === seq.current) setError(true);
    }
  }, []);

  useEffect(() => {
    if (!registered || !visible) return;
    void load();
    const id = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [registered, visible, load, version]);

  const run = useCallback(
    async (scope: "friends" | "party", action: string, body?: Record<string, unknown>): Promise<ActResult> => {
      const r = await act(scope, action, body);
      setNote({ ok: r.ok, text: r.message });
      playUi(r.ok ? "click" : "error");
      return r;
    },
    [act],
  );

  if (!registered) return <SocialGate loading={sessionLoading} guest={sessionKind === "guest"} tab={tab} />;

  const party = state?.party ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 short:gap-2">
      <p className="font-body min-h-5 shrink-0 text-sm" role="status" aria-live="polite">
        {note && <span className={note.ok ? "text-zooa-lime" : "text-rose-300"}>{note.text}</span>}
      </p>
      {tab === "requests" ? (
        <RequestsTab data={data} error={error} onRetry={() => void load()} run={run} />
      ) : tab === "party" ? (
        <PartyTab party={party} invites={state?.invites ?? []} run={run} onFriends={() => onTab("friends")} />
      ) : (
        <FriendsTab data={data} error={error} onRetry={() => void load()} party={party} run={run} requests={state?.requests ?? 0} onRequests={() => onTab("requests")} />
      )}
    </div>
  );
}

type Run = (scope: "friends" | "party", action: string, body?: Record<string, unknown>) => Promise<ActResult>;

function SocialGate({ loading, guest, tab }: { loading: boolean; guest: boolean; tab: string }) {
  if (loading) return <div className="py-6" aria-busy="true" />;
  const back = encodeURIComponent(panelHref({ panel: "friends", tab }));
  return (
    <div className="my-auto py-6 short:py-0">
      <div className="toon-panel mx-auto max-w-xl bg-[#161b28]/95 p-8 text-center short:p-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/player.png" alt="" className="mx-auto h-20 w-20 object-contain short:h-12 short:w-12" draggable={false} />
        <h2 className="toon-text mt-4 text-3xl tracking-wide text-zooa-lime short:mt-2 short:text-2xl">Register to add friends</h2>
        <p className="font-body mx-auto mt-3 max-w-[44ch] text-base text-white/75">
          Friends and parties are for registered raiders: add friends by nickname, see who&apos;s online and drop in together.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3 short:mt-3">
          <Link href={`/auth/register?next=${back}`} className="toon-btn min-h-12 px-6 text-lg">
            <span className="optical-center">Register</span>
          </Link>
          {!guest && (
            <Link href={`/auth/login?next=${back}`} className="toon-btn-ghost min-h-12 px-6 text-base">
              <span className="optical-center">Sign in</span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadState({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  if (error) {
    return (
      <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
        <p className="font-body text-white/75">Couldn&apos;t load your friends.</p>
        <button type="button" onClick={onRetry} className="toon-btn-ghost mt-4 min-h-11 px-5 text-sm">
          <span className="optical-center">Retry</span>
        </button>
      </div>
    );
  }
  return (
    <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden" aria-busy="true" aria-label="Loading">
      {Array.from({ length: 5 }, (_, i) => (
        <li key={i} className="h-14 animate-pulse rounded-xl bg-white/[0.06] motion-reduce:animate-none" />
      ))}
    </ul>
  );
}

function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <li className={clsx("flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white/[0.04] px-2 py-1.5 short:min-h-12 short:py-1", className)}>{children}</li>;
}

function Who({ nickname, level, sub, presence }: { nickname: string; level: number; sub?: string; presence?: Presence }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2.5">
      <LevelBadge level={level} size="sm" />
      <span className="min-w-0">
        <span className="block truncate text-base tracking-wide text-white">{nickname}</span>
        {(sub || presence) && (
          <span className="font-body flex items-center gap-1.5 text-xs lg:text-[0.8125rem] text-white/75">
            {presence && <PresenceDot presence={presence} className="h-2.5 w-2.5 border" />}
            {sub ?? (presence ? PRESENCE_LABEL[presence] : "")}
          </span>
        )}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------- Friends tab

function FriendsTab({
  data,
  error,
  onRetry,
  party,
  run,
  requests,
  onRequests,
}: {
  data: FriendsDto | null;
  error: boolean;
  onRetry: () => void;
  party: PartyDto | null;
  run: Run;
  requests: number;
  onRequests: () => void;
}) {
  const [nick, setNick] = useState("");
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = nick.trim();
    if (!n || busy) return;
    setBusy(true);
    const r = await run("friends", "request", { nickname: n });
    setBusy(false);
    if (r.ok) setNick("");
  };

  return (
    <>
      <form onSubmit={add} className="flex shrink-0 gap-2">
        <label htmlFor={inputId} className="sr-only">
          Raider nickname
        </label>
        <input
          id={inputId}
          value={nick}
          onChange={(e) => setNick(e.target.value)}
          placeholder="Add a raider by nickname"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={17}
          enterKeyHint="send"
          className="font-body min-h-12 min-w-0 flex-1 rounded-xl border-[3px] border-black bg-white px-3 text-base short:min-h-10 text-black placeholder:text-black/45 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70"
        />
        <button type="submit" disabled={busy || nick.trim().length < 2} className={clsx(BTN_LIME, "min-h-12 px-4 text-base short:min-h-10")}>
          Add
        </button>
      </form>

      {requests > 0 && (
        <button type="button" onClick={onRequests} className={clsx(BTN_DARK, "w-full shrink-0 justify-between")}>
          <span>
            {requests} friend {requests === 1 ? "request" : "requests"} waiting
          </span>
          <span aria-hidden>→</span>
        </button>
      )}

      {!data ? (
        <LoadState error={error} onRetry={onRetry} />
      ) : data.friends.length === 0 ? (
        <p className="font-body rounded-2xl border-[3px] border-black bg-[#161b28]/95 p-6 text-center text-white/75">
          No friends yet. Add a raider by their nickname — they&apos;ll see your request in their menu.
        </p>
      ) : (
        <>
          <p className="font-body shrink-0 text-xs lg:text-[0.8125rem] text-white/70">
            {data.friends.length}/{data.limits.maxFriends} friends · {data.friends.filter((f) => f.presence !== "offline").length} online
          </p>
          <Paged as="ul" gap={6} minCol={340} maxCols={2} label="Friend pages">
            {data.friends.map((f) => (
              <FriendRow key={f.nickname} f={f} party={party} run={run} />
            ))}
          </Paged>
        </>
      )}
    </>
  );
}

function FriendRow({ f, party, run }: { f: FriendDto; party: PartyDto | null; run: Run }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = window.setTimeout(() => setConfirm(false), 4_000);
    return () => window.clearTimeout(t);
  }, [confirm]);
  const go = async (scope: "friends" | "party", action: string) => {
    setBusy(true);
    await run(scope, action, { nickname: f.nickname });
    setBusy(false);
    setConfirm(false);
  };
  const block = inviteBlockReason(f, party);
  return (
    <Row>
      <Who nickname={f.nickname} level={f.level} presence={f.presence} sub={block ? `${PRESENCE_LABEL[f.presence]} · ${block}` : undefined} />
      <span className="flex gap-1.5">
        {confirm ? (
          <>
            <button type="button" disabled={busy} onClick={() => void go("friends", "remove")} className={clsx(BTN, "bg-rose-400 text-black")}>
              Remove
            </button>
            <button type="button" onClick={() => setConfirm(false)} className={BTN_WHITE}>
              Keep
            </button>
          </>
        ) : (
          <>
            {canInvite(f, party) && (
              <button type="button" disabled={busy} onClick={() => void go("party", "invite")} className={BTN_LIME} aria-label={`Invite ${f.nickname} to your party`}>
                Invite
              </button>
            )}
            <button type="button" onClick={() => setConfirm(true)} className={BTN_DARK} aria-label={`Remove ${f.nickname} from friends`}>
              <span aria-hidden>✕</span>
            </button>
          </>
        )}
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------------------- Requests tab

function RequestsTab({ data, error, onRetry, run }: { data: FriendsDto | null; error: boolean; onRetry: () => void; run: Run }) {
  const [busy, setBusy] = useState<string | null>(null);
  const go = async (action: string, nickname: string) => {
    setBusy(`${action}:${nickname}`);
    await run("friends", action, { nickname });
    setBusy(null);
  };
  if (!data) return <LoadState error={error} onRetry={onRetry} />;
  return (
    <Paged gap={6} minCol={340} maxCols={2} label="Request pages">
      <section aria-labelledby="req-in" className="paged-group">
        <h3 id="req-in" className="text-lg tracking-wide text-white">
          Incoming
        </h3>
        {data.incoming.length === 0 ? (
          <p className="font-body text-sm text-white/75">No requests waiting.</p>
        ) : (
          <ul className="paged-group">
            {data.incoming.map((r) => (
              <Row key={r.nickname}>
                <Who nickname={r.nickname} level={r.level} sub="Wants to be friends" />
                <span className="flex gap-1.5">
                  <button type="button" disabled={busy !== null} onClick={() => void go("accept", r.nickname)} className={BTN_LIME}>
                    Accept
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void go("decline", r.nickname)} className={BTN_WHITE}>
                    Decline
                  </button>
                </span>
              </Row>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="req-out" className="paged-group">
        <h3 id="req-out" className="pt-2 text-lg tracking-wide text-white">
          Sent <span className="font-body text-sm font-normal text-white/70">{data.outgoing.length}/{data.limits.maxPending}</span>
        </h3>
        {data.outgoing.length === 0 ? (
          <p className="font-body text-sm text-white/75">Nothing sent. Add raiders from the Friends tab.</p>
        ) : (
          <ul className="paged-group">
            {data.outgoing.map((r) => (
              <Row key={r.nickname}>
                <Who nickname={r.nickname} level={r.level} sub="Waiting for an answer" />
                <button type="button" disabled={busy !== null} onClick={() => void go("cancel", r.nickname)} className={BTN_WHITE}>
                  Cancel
                </button>
              </Row>
            ))}
          </ul>
        )}
      </section>
    </Paged>
  );
}

// ---------------------------------------------------------------------------- Party tab

function PartyTab({
  party,
  invites,
  run,
  onFriends,
}: {
  party: PartyDto | null;
  invites: PartyInviteDto[];
  run: Run;
  onFriends: () => void;
}) {
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"leave" | "disband" | null>(null);
  const go = async (action: string, body?: Record<string, unknown>) => {
    setBusy(true);
    await run("party", action, body);
    setBusy(false);
    setConfirm(null);
  };

  return (
    <Paged gap={6} minCol={340} maxCols={2} label="Party pages">
      {invites.length > 0 && (
        <section aria-labelledby="party-inv" className="paged-group">
          <h3 id="party-inv" className="text-lg tracking-wide text-white">
            Invites
          </h3>
          <ul className="paged-group">
            {invites.map((i) => (
              <Row key={i.partyId} className="bg-zooa-lime/10">
                <span className="font-body min-w-0 flex-1 text-sm text-white">
                  <b className="font-display text-base tracking-wide">{i.from}</b> invited you · {i.size}/{PARTY.MAX_SIZE} ·{" "}
                  <span className="tabular-nums text-white/75">{fmtClockS(secondsLeft(i.expiresAt, now))}</span>
                </span>
                <span className="flex gap-1.5">
                  <button type="button" disabled={busy} onClick={() => void go("accept", { partyId: i.partyId })} className={BTN_LIME}>
                    Join
                  </button>
                  <button type="button" disabled={busy} onClick={() => void go("decline", { partyId: i.partyId })} className={BTN_WHITE}>
                    Decline
                  </button>
                </span>
              </Row>
            ))}
          </ul>
        </section>
      )}

      {!party ? (
        <div className="toon-panel bg-[#161b28]/95 p-6 text-center">
          <p className="font-body text-white/80">You&apos;re not in a party. Invite friends to start one — up to {PARTY.MAX_SIZE} raiders.</p>
          <button type="button" onClick={onFriends} className="toon-btn mt-4 min-h-12 px-6 text-base">
            <span className="optical-center">Pick friends</span>
          </button>
        </div>
      ) : (
        <section aria-labelledby="party-members" className="paged-group">
          <h3 id="party-members" className="pt-1 text-lg tracking-wide text-white">
            Your party <span className="font-body text-sm font-normal text-white/70">{party.members.length}/{party.maxSize}</span>
          </h3>
          <ul className="paged-group">
            {party.members.map((m) => {
              const chip = memberChip(m);
              return (
                <Row key={m.nickname} className={m.you ? "ring-2 ring-zooa-lime/50" : undefined}>
                  <Who nickname={m.you ? `${m.nickname} (you)` : m.nickname} level={m.level} presence={m.presence} />
                  <span className={clsx("font-body rounded-full border-2 border-black px-2 py-0.5 text-xs lg:text-[0.8125rem] font-bold", CHIP_TONE[chip.tone])}>{chip.label}</span>
                  {party.isLeader && !m.you && (
                    <span className="flex gap-1.5">
                      <button type="button" disabled={busy} onClick={() => void go("lead", { nickname: m.nickname })} className={BTN_WHITE} aria-label={`Make ${m.nickname} the leader`}>
                        Make leader
                      </button>
                      <button type="button" disabled={busy} onClick={() => void go("kick", { nickname: m.nickname })} className={BTN_DARK} aria-label={`Remove ${m.nickname} from the party`}>
                        Kick
                      </button>
                    </span>
                  )}
                </Row>
              );
            })}
            {party.invited.map((i) => (
              <Row key={`inv-${i.nickname}`} className="border-2 border-dashed border-white/20 bg-transparent">
                <span className="font-body min-w-0 flex-1 text-sm text-white/70">
                  <b className="font-display text-base tracking-wide text-white/85">{i.nickname}</b> · invited ·{" "}
                  <span className="tabular-nums">{fmtClockS(secondsLeft(i.expiresAt, now))}</span>
                </span>
                {party.isLeader && (
                  <button type="button" disabled={busy} onClick={() => void go("uninvite", { nickname: i.nickname })} className={BTN_WHITE} aria-label={`Cancel the invite to ${i.nickname}`}>
                    Cancel
                  </button>
                )}
              </Row>
            ))}
          </ul>

          {!party.isLeader && (
            <label className="font-body flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-[3px] border-black bg-[#1d2333] px-3 text-sm font-bold text-white shadow-[0_3px_0_#000]">
              <input
                type="checkbox"
                checked={party.follow}
                disabled={busy}
                onChange={(e) => void go("follow", { follow: e.target.checked })}
                className="h-6 w-6 accent-[#CCFF00]"
              />
              <span>
                Follow leader <span className="font-normal text-white/75">— drop in automatically when {party.leader} presses PLAY</span>
              </span>
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            {party.isLeader && party.members.length + party.invited.length < party.maxSize && (
              <button type="button" onClick={onFriends} className={BTN_LIME}>
                Invite friends
              </button>
            )}
            {confirm ? (
              <>
                <button type="button" disabled={busy} onClick={() => void go(confirm)} className={clsx(BTN, "bg-rose-400 text-black")}>
                  {confirm === "leave" ? "Yes, leave" : "Yes, disband"}
                </button>
                <button type="button" onClick={() => setConfirm(null)} className={BTN_WHITE}>
                  Keep the party
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => setConfirm("leave")} className={BTN_WHITE}>
                  Leave party
                </button>
                {party.isLeader && (
                  <button type="button" onClick={() => setConfirm("disband")} className={BTN_DARK}>
                    Disband
                  </button>
                )}
              </>
            )}
          </div>
        </section>
      )}

      {/* Collapsed by default: the rules are one tap away instead of a block of text to scroll past. */}
      <details className="font-body group rounded-2xl border-[3px] border-black bg-[#161b28]/95 px-4 text-sm leading-relaxed text-white/75">
        <summary className="font-display flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-base tracking-wide text-white [&::-webkit-details-marker]:hidden">
          How parties work
          <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
        </summary>
        <ul className="list-disc space-y-1 pb-3 pl-5">
          <li>When the leader presses PLAY, the party has {PARTY.DROP_TTL_MS / 1000} s to drop in next to them.</li>
          <li>Party members see each other on the map and can&apos;t hurt each other.</li>
          <li>Everyone locks their own loadout and keeps their own loot — nothing is shared or split.</li>
        </ul>
      </details>
    </Paged>
  );
}
