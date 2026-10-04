"use client";

/**
 * One inventory tile: rarity frame, sprite, stack badge, durability bar, magazine, FREE ribbon,
 * BROKEN crack, dog-tag label, "?" placeholder with a reveal ring, pending spinner and drop-target
 * highlight. Pure presentation driven by props; shared by the raid overlay, the search panel, the
 * outcome receipt and (later) the lobby board.
 */

import { memo, useRef, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { WEAPONS, itemDef } from "@extract/shared";
import { isTouchContextMenu } from "@/hooks/use-item-drag";
import { describeItem, durInfo, isBroken, isFree, isWeaponId, slotLabel } from "@/lib/items-ui";

export interface InvSlotItem {
  def: string;
  qty: number;
  rarity: number;
  dur?: number;
  mag?: number;
  flags?: number;
  label?: string;
  lvl?: number;
  uid?: string;
}

export type InvSlotState = "item" | "empty" | "hidden" | "revealing" | "taken";

export interface InvSlotProps {
  item?: InvSlotItem | null;
  /** Default: "item" when an item is given, else "empty". */
  state?: InvSlotState;
  /** Slot key for the empty-slot caption ("Primary", "Pocket 2"). */
  slotKey?: string;
  /** Override caption shown on empty slots. */
  caption?: string;
  /** 0..1 for state "revealing" (and an open-delay ring if needed). */
  progress?: number;
  size?: "sm" | "md" | "lg";
  pending?: boolean;
  /** Valid drop target under a dragged item. */
  dropOk?: boolean;
  /** Invalid drop target under a dragged item. */
  dropBad?: boolean;
  /** The source tile of the current drag (rendered faded). */
  dragging?: boolean;
  /** The active weapon slot. */
  active?: boolean;
  /** Small keycap in the corner (e.g. "1", "2"). */
  hotkey?: string;
  /** `data-drop` value so the drag hook can find this tile as a target. */
  dropId?: string;
  /** Extra line under the tile (outcome receipt). */
  footer?: ReactNode;
  showName?: boolean;
  title?: string;
  className?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
  /** Right-click (mouse or pen); never a touch long press, which starts a drag instead. */
  onContextMenu?: () => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onClickCapture?: (e: React.MouseEvent<HTMLElement>) => void;
}

const SIZE = {
  sm: { box: "h-12 w-12 rounded-lg", img: "h-9 w-9", text: "text-[0.6rem]" },
  md: { box: "h-[4.25rem] w-[4.25rem] rounded-xl", img: "h-12 w-12", text: "text-[0.7rem]" },
  lg: { box: "h-20 w-20 rounded-2xl", img: "h-16 w-16", text: "text-xs" },
} as const;

export const InvSlot = memo(function InvSlot(props: InvSlotProps) {
  const { item, size = "md", pending, dropOk, dropBad, dragging, active, hotkey, dropId, footer, showName } = props;
  const state: InvSlotState = props.state ?? (item ? "item" : "empty");
  const sz = SIZE[size];
  const interactive = !!(props.onClick || props.onPointerDown);
  /** pointerType of the last press on this tile: a touch long press must not run onContextMenu. */
  const lastDown = useRef<string | null>(null);

  const desc = item ? describeItem(item) : null;
  const broken = item ? isBroken(item) : false;
  const free = item ? isFree(item) : false;
  const dur = item && item.dur !== undefined ? durInfo({ def: item.def, dur: item.dur }) : null;
  const def = item ? itemDef(item.def) : undefined;
  const magSize = def?.weapon && isWeaponId(def.weapon) ? WEAPONS[def.weapon].magSize : 0;

  let frameStyle: CSSProperties | undefined;
  if (state === "item" && desc) {
    frameStyle = broken
      ? { background: "repeating-linear-gradient(135deg,#2a2d36 0 6px,#23262e 6px 12px)" }
      : { background: `radial-gradient(circle at 50% 35%, ${desc.color}d9, ${desc.color}4d 72%)` };
  }

  const tooltip =
    props.title ??
    (desc
      ? [
          desc.name,
          desc.cat === "junk" || desc.cat === "weapon" || desc.cat === "armor" || desc.cat === "backpack" ? desc.rarityName : "",
          item && item.qty > 1 ? `×${item.qty}` : "",
          dur?.text ?? "",
          broken ? "BROKEN" : "",
          free ? "Free kit — never extracts" : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : state === "hidden" || state === "revealing"
        ? "Searching…"
        : state === "taken"
          ? "Taken"
          : (props.caption ?? (props.slotKey ? slotLabel(props.slotKey) : "Empty")));

  const Tag = interactive ? "button" : "div";
  return (
    <div className={clsx("flex flex-col items-center gap-1", props.className)}>
      <Tag
        {...(interactive ? { type: "button" as const } : {})}
        data-drop={dropId}
        title={tooltip}
        aria-label={tooltip}
        onClick={props.onClick}
        onDoubleClick={props.onDoubleClick}
        onContextMenu={
          props.onContextMenu
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                if (isTouchContextMenu(e.nativeEvent as { pointerType?: unknown }, lastDown.current)) return;
                props.onContextMenu!();
              }
            : undefined
        }
        onPointerDown={
          props.onContextMenu
            ? (e: React.PointerEvent<HTMLElement>) => {
                lastDown.current = e.pointerType;
                props.onPointerDown?.(e);
              }
            : props.onPointerDown
        }
        onClickCapture={props.onClickCapture}
        className={clsx(
          "relative grid shrink-0 touch-none select-none place-items-center border-[3px] border-black shadow-[0_3px_0_#000] outline-none transition-[transform,filter,box-shadow] duration-100",
          sz.box,
          state === "empty" && "border-dashed border-white/25 bg-black/35 shadow-none",
          state === "taken" && "border-dashed border-white/15 bg-black/20 shadow-none",
          (state === "hidden" || state === "revealing") && "bg-[#2b3142]",
          interactive && state === "item" && "cursor-grab hover:-translate-y-0.5 hover:brightness-110 focus-visible:ring-4 focus-visible:ring-zooa-lime active:cursor-grabbing",
          interactive && state !== "item" && "focus-visible:ring-4 focus-visible:ring-zooa-lime",
          active && "ring-4 ring-zooa-lime",
          dropOk && "scale-105 !border-solid !border-zooa-lime ring-4 ring-zooa-lime/70",
          dropBad && "!border-rose-500 opacity-70",
          dragging && "opacity-35",
          broken && "grayscale",
        )}
        style={frameStyle}
      >
        {state === "item" && desc && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- tiny static sprites */}
            <img
              src={desc.icon}
              alt=""
              draggable={false}
              className={clsx(
                "pointer-events-none select-none object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]",
                sz.img,
                broken && "opacity-60",
              )}
            />
            {item!.qty > 1 && (
              <span className="toon-text-thin absolute bottom-0.5 right-1 text-sm tabular-nums text-white">
                ×{item!.qty}
              </span>
            )}
            {magSize > 0 && !broken && item!.mag !== undefined && (
              <span className="font-body absolute left-1 top-0.5 rounded bg-black/60 px-1 text-[0.6rem] font-bold tabular-nums text-white/90">
                {item!.mag}/{magSize}
              </span>
            )}
            {dur && !broken && (
              <span className="absolute inset-x-1.5 bottom-1 h-1.5 overflow-hidden rounded-full border border-black bg-black/60" aria-hidden>
                <span
                  className={clsx(
                    "block h-full",
                    dur.tone === "ok" ? "bg-emerald-400" : dur.tone === "mid" ? "bg-amber-300" : "bg-rose-500",
                  )}
                  style={{ width: `${Math.round(dur.frac * 100)}%` }}
                />
              </span>
            )}
            {free && (
              <span className="absolute -left-1 -top-1 rotate-[-12deg] rounded-md border-2 border-black bg-sky-300 px-1 text-[0.55rem] text-black shadow-[0_2px_0_#000]">
                FREE
              </span>
            )}
            {broken && <BrokenCrack />}
          </>
        )}
        {(state === "hidden" || state === "revealing") && (
          <>
            {state === "revealing" && <Ring progress={props.progress ?? 0} />}
            <span className={clsx("toon-text-thin text-2xl text-white/70", state === "revealing" && "animate-pulse")}>?</span>
          </>
        )}
        {state === "empty" && !showName && (
          <span className={clsx("font-body px-0.5 text-center font-semibold uppercase leading-tight text-white/35", size === "sm" ? "text-[0.5rem]" : "text-[0.58rem]")}>
            {props.caption ?? (props.slotKey ? slotLabel(props.slotKey) : "")}
          </span>
        )}
        {pending && (
          <span className="absolute inset-0 grid place-items-center rounded-[inherit] bg-black/45" aria-hidden>
            <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-black border-t-zooa-lime" />
          </span>
        )}
        {hotkey && (
          <span className="toon-key absolute -right-1.5 -top-1.5 h-5 min-w-5 text-[0.6rem]">{hotkey}</span>
        )}
      </Tag>
      {showName && (
        <div className={clsx("max-w-[6.5rem] text-center leading-tight", sz.text)}>
          <div className="truncate tracking-wide text-white">
            {desc?.name ?? props.caption ?? (props.slotKey ? slotLabel(props.slotKey) : "")}
          </div>
          {desc && (
            <div className="text-[0.6rem] uppercase tracking-wider" style={{ color: broken ? "#9ca3af" : desc.color }}>
              {broken ? "broken" : desc.rarityName}
            </div>
          )}
        </div>
      )}
      {footer}
    </div>
  );
});

/** SVG progress ring around the "?" while an item is being revealed. */
function Ring({ progress }: { progress: number }) {
  const p = Math.max(0, Math.min(1, progress));
  const r = 40;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-1" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(0,0,0,0.5)" strokeWidth="10" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="#CCFF00"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${c * p} ${c}`}
        transform="rotate(-90 50 50)"
      />
    </svg>
  );
}

function BrokenCrack() {
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0" aria-hidden>
      <path
        d="M58 0 L48 30 L62 44 L40 64 L52 78 L44 100"
        fill="none"
        stroke="#000"
        strokeWidth="7"
        strokeLinejoin="round"
      />
      <path d="M58 0 L48 30 L62 44 L40 64 L52 78 L44 100" fill="none" stroke="#f43f5e" strokeWidth="3" strokeLinejoin="round" />
      <text x="50" y="58" textAnchor="middle" fontSize="15" fill="#fff" stroke="#000" strokeWidth="4" paintOrder="stroke" fontFamily="inherit">
        BROKEN
      </text>
    </svg>
  );
}
