"use client";

/**
 * Reward visuals shared by the level rewards (rewards-tab.tsx), the Alpha Pass (pass-tab.tsx) and the
 * LEVEL N window (level-up-modal.tsx): every reward is SHOWN, not listed — a title as its nameplate,
 * a name colour as the player's nick in that colour, a badge frame around the player's level shield,
 * the Alpha Veteran skin as the character art, the Founder medal, and feature unlocks as icons.
 * Presentation only: what is owned, worn and claimable comes from the caller.
 */
import { useState } from "react";
import clsx from "clsx";
import { cosmeticDef, type WearableKind } from "@extract/shared";
import type { RewardItem } from "@/lib/lobby/levels";
import { useLobby } from "@/lib/lobby/lobby-context";
import { playUi } from "@/game/audio/ui-sounds";
import { LevelBadge } from "./level-badge";
import { useQuests } from "./quests-context";

export const MINT = "#5cf2c6";
const AMBER = "#ffc93c";

/** Card state: locked (not reached), next (the next one to get), owned (unlocked), wearing, claimable (pass), claimed (pass badge). */
export type RewardState = "locked" | "next" | "owned" | "wearing" | "claimable" | "claimed";

const KIND_WORD: Readonly<Record<string, string>> = {
  title: "Title",
  color: "Name colour",
  frame: "Badge frame",
  skin: "Skin",
  badge: "Board badge",
  market: "Market",
  trader: "Traders",
  band: "Badge colour",
};

const BAND_LEVEL: Readonly<Record<string, number>> = {
  lime: 5,
  blue: 10,
  violet: 15,
  gold: 20,
};

/** The card's caption word ("Title", "Traders"…). */
export function rewardKindWord(item: RewardItem): string {
  return KIND_WORD[item.kind === "feature" ? (item.feature ?? "band") : item.kind] ?? item.kind;
}

/** The card's name: the cosmetic's name, or a short feature line ("Selling unlocked", "Tier 2"). */
export function rewardName(item: RewardItem): string {
  if (item.kind !== "feature") return (item.id && cosmeticDef(item.id)?.name) || item.label;
  if (item.feature === "market") return "Selling unlocked";
  if (item.feature === "trader") return item.label.split(":")[0]!.replace("Traders tier", "Tier");
  return item.label.replace("Level badge turns", "Badge turns");
}

/** Second line of a feature card: the trader tier's goods; empty otherwise. */
export function rewardDetail(item: RewardItem): string {
  if (item.kind === "feature" && item.feature === "trader") return item.label.split(":").slice(1).join(":").trim();
  if (item.kind === "feature" && item.feature === "market") return "Sell loot to other raiders";
  return "";
}

/** Accent colour of a reward (glow behind the art, card rim). */
export function rewardAccent(item: RewardItem): string {
  const d = item.id ? cosmeticDef(item.id) : null;
  if (item.kind === "feature") {
    if (item.feature === "market") return "#ccff00";
    if (item.feature === "trader") return "#4cc9ff";
    const band = /turns (\w+)/.exec(item.label)?.[1] ?? "";
    return (
      (
        {
          lime: "#ccff00",
          blue: "#4cc9ff",
          violet: "#b07bff",
          gold: AMBER,
        } as Record<string, string>
      )[band] ?? "#cbd5e1"
    );
  }
  if (d?.grant === "pass") return MINT;
  if (d?.grant === "trophy") return AMBER;
  if (item.hex) return item.hex;
  return AMBER;
}

/** A title as its nameplate: a bevelled plate with the name in capitals (pass titles in mint, the rest in amber). */
export function TitlePlate({
  name,
  tone = "amber",
  size = "md",
  className,
}: {
  name: string;
  tone?: "amber" | "mint";
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const [top, base] = tone === "mint" ? ["#b8ffe9", MINT] : ["#ffe7a3", AMBER];
  return (
    <span
      className={clsx(
        "inline-flex max-w-full items-center justify-center gap-1.5 rounded-lg border-[3px] border-black text-center uppercase leading-tight tracking-wide text-black shadow-[0_3px_0_#000,inset_0_2px_0_rgba(255,255,255,0.6)]",
        size === "lg" ? "px-3 py-1.5 text-lg" : size === "md" ? "px-2 py-1 text-sm" : "px-1.5 py-0.5 text-xs",
        className,
      )}
      style={{ background: `linear-gradient(180deg, ${top}, ${base})` }}
    >
      <span aria-hidden className="text-[0.6em] opacity-70">
        ◆
      </span>
      <span className="optical-center min-w-0 break-words">{name}</span>
      <span aria-hidden className="text-[0.6em] opacity-70">
        ◆
      </span>
    </span>
  );
}

/** A name colour shown on the player's own nick. */
export function NickPreview({ nick, hex, className }: { nick: string; hex: string; className?: string }) {
  return (
    <span className={clsx("toon-text-thin block max-w-full truncate text-center leading-tight", className)} style={{ color: hex }}>
      {nick}
    </span>
  );
}

function Img({ src, alt, className }: { src: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} draggable={false} className={clsx("pointer-events-none select-none", className)} />;
}

/**
 * The reward itself, drawn: `nick` and `level` make the name colour and the frame the player's own.
 * `big` = the Alpha Pass cards and the LEVEL N window (larger nick and shield).
 */
export function RewardArt({ item, nick, level, big }: { item: RewardItem; nick: string; level: number; big?: boolean }) {
  const d = item.id ? cosmeticDef(item.id) : null;
  if (item.kind === "title") return <TitlePlate name={d?.name ?? item.label} tone={d?.grant === "pass" ? "mint" : "amber"} size={big ? "md" : "sm"} />;
  if (item.kind === "color" && item.hex)
    return (
      <span className="flex w-full min-w-0 flex-col items-center gap-1">
        <NickPreview
          nick={nick}
          hex={item.hex}
          className={nick.length <= 7 ? (big ? "text-2xl" : "text-xl") : nick.length <= 10 ? "text-lg" : big ? "text-base" : "text-sm"}
        />
        <span className="h-2 w-12 rounded-full border-2 border-black" style={{ background: item.hex }} aria-hidden />
      </span>
    );
  if (item.kind === "frame" && item.id) return <LevelBadge level={level} size="lg" frame={item.id} className={big ? "scale-110" : undefined} />;
  if (item.kind === "skin") return <Img src="/lobby/hero_alpha.png" alt="Alpha Veteran skin" className="h-full w-full object-cover object-[50%_6%]" />;
  if (item.kind === "badge")
    return <Img src="/lobby/reward_founder.png" alt="Founder badge" className={big ? "h-24 w-24 object-contain" : "h-20 w-20 object-contain"} />;
  if (item.feature === "market") return <Img src="/lobby/reward_market.png" alt="" className="h-20 w-20 object-contain" />;
  if (item.feature === "trader") return <Img src="/lobby/menu_shop.png" alt="" className="h-20 w-20 object-contain" />;
  const band = /turns (\w+)/.exec(item.label)?.[1] ?? "";
  return <LevelBadge level={BAND_LEVEL[band] ?? level} size="lg" />;
}

export function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 22" className={clsx("h-4 w-4", className)} aria-hidden>
      <path d="M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9" fill="none" stroke="#000" strokeWidth="4.2" strokeLinecap="round" />
      <path d="M5.5 9V6.5a4.5 4.5 0 0 1 9 0V9" fill="none" stroke="#e5e7eb" strokeWidth="2" strokeLinecap="round" />
      <rect x="2" y="9" width="16" height="11.5" rx="2.5" fill="#e5e7eb" stroke="#000" strokeWidth="2" />
      <circle cx="10" cy="14.2" r="1.7" fill="#000" />
    </svg>
  );
}

/**
 * One reward card: the caption ("Title"), the drawn reward over a glow in its accent colour, the
 * name, and a footer (`footer`: a Wear / Claim button or a status). Locked cards grey the art and
 * carry a lock; the next reward pulses; `celebrate` plays the claim burst (glow, shine, confetti).
 */
export function RewardCard({
  item,
  state,
  nick,
  level,
  footer,
  big,
  ribbon,
  celebrate,
  className,
  style,
  artRef,
}: {
  item: RewardItem;
  state: RewardState;
  nick: string;
  level: number;
  footer?: React.ReactNode;
  big?: boolean;
  /** A label pinned over the top edge ("TIER 3", "NEXT"). */
  ribbon?: React.ReactNode;
  celebrate?: boolean;
  className?: string;
  style?: React.CSSProperties;
  artRef?: React.Ref<HTMLDivElement>;
}) {
  const accent = rewardAccent(item);
  const locked = state === "locked" || state === "next";
  const detail = rewardDetail(item);
  const lit = state === "claimable" || state === "next";
  return (
    <div
      className={clsx(
        "relative flex shrink-0 flex-col rounded-2xl border-[3px] border-black shadow-[0_4px_0_#000]",
        big ? "w-[10.5rem] short:w-[9.5rem]" : "w-[9.25rem]",
        className,
      )}
      style={{
        background: locked ? "linear-gradient(180deg,#222a3f,#181e2f)" : "linear-gradient(180deg,#2c3758,#1b2239)",
        ...style,
      }}
    >
      {/* Pulsing rim on the next reward / a claimable tier. */}
      {lit && (
        <span
          className="rw-ring pointer-events-none absolute -inset-[7px] rounded-[1.35rem] border-[3px]"
          style={{
            borderColor: state === "claimable" ? "#ccff00" : accent,
            boxShadow: `0 0 18px ${state === "claimable" ? "#ccff00" : accent}`,
          }}
          aria-hidden
        />
      )}
      {celebrate && (
        <span
          className="rw-glow pointer-events-none absolute -inset-3 rounded-[1.6rem]"
          style={{
            background: `radial-gradient(circle, ${accent}cc, transparent 70%)`,
          }}
          aria-hidden
        />
      )}
      {ribbon}
      <div
        className={clsx(
          "relative shrink-0 overflow-hidden rounded-t-[0.85rem]",
          (celebrate || state === "claimable") && (celebrate ? "rw-shine" : "rw-shine-loop"),
        )}
      >
        <p className="font-body relative z-[1] px-2 pt-1.5 text-center text-xs font-bold uppercase tracking-wider text-white/75">{rewardKindWord(item)}</p>
        <div
          ref={artRef}
          className={clsx(
            "relative mx-2 mb-1 mt-1 grid place-items-center overflow-hidden rounded-xl border-2 border-black/60 px-1.5",
            big ? "h-32 short:h-24" : "h-24 short:h-20",
            item.kind === "skin" && "px-0",
          )}
          style={{
            background: `radial-gradient(circle at 50% 62%, ${accent}${locked ? "33" : "66"}, rgba(0,0,0,0.25) 72%)`,
          }}
        >
          <div className={clsx("grid h-full w-full place-items-center", state === "locked" && "opacity-75 grayscale-[0.4]", celebrate && "rw-pop")}>
            <RewardArt item={item} nick={nick} level={level} big={big} />
          </div>
          {locked && (
            <span className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded-full border-2 border-black bg-[#121722]" aria-label="Locked">
              <LockIcon />
            </span>
          )}
          {(state === "wearing" || state === "owned" || state === "claimed") && (
            <span
              className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full border-2 border-black bg-zooa-lime text-xs text-black"
              aria-label="Unlocked"
            >
              ✓
            </span>
          )}
        </div>
      </div>
      <div className="flex grow flex-col px-2 pb-2">
        <p className={clsx("text-center leading-tight tracking-wide text-white", big ? "text-base" : "text-sm")}>{rewardName(item)}</p>
        {detail && (
          <p className="font-body mt-0.5 line-clamp-2 text-center text-xs leading-snug text-white/75" title={detail}>
            {detail}
          </p>
        )}
        {footer && <div className="mt-auto flex flex-col pt-1.5">{footer}</div>}
      </div>
      {celebrate && <Confetti />}
    </div>
  );
}

const CONFETTI = ["#CCFF00", "#5cf2c6", "#ffc93c", "#4cc9ff", "#f43f5e", "#ffffff", "#b07bff"];

/** CSS confetti thrown out of a card's middle (hidden under reduced motion). */
export function Confetti({ count = 18 }: { count?: number }) {
  return (
    <span className="pointer-events-none absolute left-1/2 top-[40%] z-10" aria-hidden>
      {Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 + (i % 3) * 0.3;
        const r = 70 + ((i * 37) % 60);
        return (
          <span
            key={i}
            className="rw-confetti absolute h-3.5 w-2.5 rounded-[2px] border-2 border-black"
            style={
              {
                background: CONFETTI[i % CONFETTI.length],
                "--dx": `${Math.round(Math.cos(a) * r)}px`,
                "--dy": `${Math.round(Math.sin(a) * r * 0.8 + 40)}px`,
                "--rot": `${(i * 97) % 540}deg`,
                animationDelay: `${(i % 5) * 30}ms`,
              } as React.CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

/** Wear / Wearing toggle for an owned wearable cosmetic (the server checks ownership again). */
export function WearButton({ kind, id, className }: { kind: WearableKind; id: string; className?: string }) {
  const quests = useQuests();
  const { toast } = useLobby();
  const [busy, setBusy] = useState(false);
  const worn = quests.data?.equipped[kind] === id;
  const toggle = async () => {
    setBusy(true);
    const r = await quests.equip(kind, worn ? null : id);
    setBusy(false);
    playUi(r.ok ? "click" : "error");
    if (!r.ok) toast(r.message);
  };
  return (
    <button
      type="button"
      disabled={busy || !quests.data}
      onClick={() => void toggle()}
      aria-pressed={worn}
      className={clsx(
        "font-body flex min-h-11 w-full items-center justify-center rounded-xl border-[3px] border-black px-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 disabled:opacity-60",
        worn ? "bg-zooa-lime text-black shadow-[0_3px_0_#000]" : "bg-white text-black shadow-[0_3px_0_#000] hover:bg-zinc-100",
        className,
      )}
    >
      {busy ? "…" : worn ? "Wearing ✓" : "Wear"}
    </button>
  );
}

/** A status line in a card footer ("Level 8", "120 AP to go"). */
export function CardStatus({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "lime" | "mint" }) {
  return (
    <p
      className={clsx(
        "font-body flex min-h-11 items-center justify-center gap-1.5 rounded-xl border-2 border-black/50 bg-black/30 px-2 text-center text-xs font-bold tabular-nums",
        tone === "lime" ? "text-zooa-lime" : tone === "mint" ? "text-[#5cf2c6]" : "text-white/80",
      )}
    >
      {children}
    </p>
  );
}

/**
 * The player's plate: level shield with the worn frame, the nick in the worn colour, the worn title
 * as its nameplate, the Founder medal when owned. The Alpha Pass flies claimed rewards into it
 * (`plateRef`); `pop` changes on every landing and replays the bounce.
 */
export function ProfilePlate({
  nick,
  level,
  equipped,
  founder,
  plateRef,
  pop,
  className,
  children,
}: {
  nick: string;
  level: number | null;
  equipped: {
    title?: string | null;
    color?: string | null;
    frame?: string | null;
  } | null;
  founder?: boolean;
  plateRef?: React.Ref<HTMLDivElement>;
  pop?: number;
  className?: string;
  children?: React.ReactNode;
}) {
  const color = equipped?.color ? cosmeticDef(equipped.color) : null;
  const title = equipped?.title ? cosmeticDef(equipped.title) : null;
  return (
    <div
      ref={plateRef}
      key={pop}
      className={clsx(
        "relative flex min-w-0 items-center gap-3 rounded-2xl border-[3px] border-black bg-[linear-gradient(180deg,#2c3758,#1b2239)] p-3 shadow-[0_4px_0_#000,inset_0_3px_0_rgba(255,255,255,0.1)] short:gap-2 short:p-2",
        pop ? "rw-pop" : undefined,
        className,
      )}
    >
      <LevelBadge level={level} size="lg" frame={equipped?.frame} className="short:-mx-1.5 short:-my-2 short:scale-[0.8]" />
      <div className="min-w-0 flex-1">
        <p className="short:hidden font-body text-xs font-bold uppercase tracking-wider text-white/75">Your plate</p>
        <p
          className="toon-text-thin truncate text-2xl leading-tight short:text-xl"
          style={{
            color: color?.kind === "color" && color.hex ? color.hex : "#fff",
          }}
        >
          {nick}
        </p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          {title?.kind === "title" ? (
            <TitlePlate name={title.name} tone={title.grant === "pass" ? "mint" : "amber"} size="sm" />
          ) : (
            <span className="font-body text-xs font-semibold text-white/75">No title worn</span>
          )}
          {founder && <Img src="/lobby/reward_founder.png" alt="Founder badge" className="h-7 w-7 object-contain" />}
        </div>
        {children}
      </div>
    </div>
  );
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * One step of a reward road's rail: the node centred over its cards, a half-rail on each side. The
 * way from one node to the next is split over the right half of one step and the left half of the
 * next, so `progIn` (0..1, from the previous node to this one) fills this step's left half and
 * `progOut` (from this node to the next) its right half. `you` puts the YOU chip where the player is.
 */
export function RailStep({
  progIn,
  progOut,
  node,
  you,
  first,
  last,
  fill = "linear-gradient(180deg,#e9ff7a,#ccff00)",
  chip = "#ccff00",
  float,
}: {
  progIn: number;
  progOut: number;
  node: React.ReactNode;
  you?: string | null;
  first?: boolean;
  last?: boolean;
  fill?: string;
  chip?: string;
  float?: boolean;
}) {
  const l = clamp01(progIn * 2 - 1);
  const r = clamp01(progOut * 2);
  // Where the chip goes: on the left half (second half of the way in) or the right half (first half of the way out).
  let at: { side: "l" | "r"; x: number; before: boolean } | null = null;
  if (you) {
    if (progIn < 1 && (progIn >= 0.5 || first)) at = { side: "l", x: l, before: !(first && l < 0.6) };
    else if (progIn >= 1 && !last && progOut < 0.5) at = { side: "r", x: Math.min(0.6, r), before: false };
  }
  const bar = (w: number, side: "l" | "r", hidden?: boolean) => (
    <span className={clsx("relative h-3 flex-1 border-y-2 border-black bg-black/60", side === "l" ? "-mr-1" : "-ml-1", hidden && "invisible")} aria-hidden>
      <span className="absolute inset-y-0 left-0" style={{ width: `${w * 100}%`, background: fill }} />
      {at?.side === side && (
        <span
          className={clsx(
            "absolute top-1/2 z-[2] -translate-y-1/2 whitespace-nowrap rounded-full border-[3px] border-black px-2 py-0.5 text-xs text-black shadow-[0_3px_0_#000]",
            // Beside the fill's end, on the side away from the node, so it never covers it.
            at.before ? "-translate-x-full" : "translate-x-1",
          )}
          style={{ left: `${at.x * 100}%`, background: chip }}
        >
          <span className="optical-center">{you}</span>
        </span>
      )}
    </span>
  );
  return (
    <div className="relative flex h-14 items-center">
      {bar(l, "l")}
      <span className={clsx("relative z-[1] shrink-0", float && "rw-float")}>{node}</span>
      {bar(r, "r", last)}
    </div>
  );
}
