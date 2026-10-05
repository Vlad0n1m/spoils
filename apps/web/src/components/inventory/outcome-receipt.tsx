"use client";

/**
 * Outcome receipt pieces: item strips (extracted / broken / left in the body), the auto-sell
 * receipt that counts up line by line with a coin tick, and the dog-tag badge row.
 */

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { SettledItem } from "@extract/shared";
import { fmtCr, rarityHex, type Receipt } from "@/lib/items-ui";
import { SOL_ECONOMY } from "@/lib/edition";
import { InvSlot } from "./inv-slot";

export function ItemStrip({
  title,
  items,
  empty,
  tone = "normal",
  note,
}: {
  title: string;
  items: readonly SettledItem[];
  empty: string;
  /** "broken": greyed with the crack overlay; "dim": just faded. */
  tone?: "normal" | "broken" | "dim";
  note?: string;
}) {
  return (
    <div>
      <h3 className="text-sm uppercase tracking-[0.18em] text-white/55">
        {title}
        {items.length > 0 && <span className="ml-2 tabular-nums text-white/35">{items.length}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="font-body mt-2 text-sm leading-relaxed text-white/60">{empty}</p>
      ) : (
        <ul className={clsx("mt-3 flex flex-wrap gap-3", tone === "dim" && "opacity-60")}>
          {items.map((it, i) => (
            <li key={`${it.uid || it.def}:${i}`}>
              <InvSlot item={{ ...it, flags: tone === "broken" ? 2 : 0 }} size="sm" showName />
            </li>
          ))}
        </ul>
      )}
      {note && <p className="font-body mt-2 text-xs leading-relaxed text-white/50">{note}</p>}
    </div>
  );
}

/** Lines appear one by one (stagger) and the total counts up; `onCoin` plays per line. */
export const RECEIPT_STAGGER_MS = 260;

export function SellReceipt({
  receipt,
  guest,
  onCoin,
}: {
  receipt: Receipt;
  guest: boolean;
  onCoin?: () => void;
}) {
  const [shown, setShown] = useState(0);
  const coinRef = useRef(onCoin);
  coinRef.current = onCoin;
  const n = receipt.lines.length;
  // Restart the count-up only when the numbers change, not on every parent render.
  const sig = `${receipt.total}:${receipt.lines.map((l) => l.cr).join(",")}`;

  useEffect(() => {
    setShown(0);
    if (n === 0) return;
    let i = 0;
    const iv = window.setInterval(() => {
      i++;
      setShown(i);
      // A coin per line, capped so a 16-line receipt doesn't machine-gun the speaker.
      if (i <= 8 || i === n) coinRef.current?.();
      if (i >= n) window.clearInterval(iv);
    }, RECEIPT_STAGGER_MS);
    return () => window.clearInterval(iv);
  }, [n, sig]);

  const running = receipt.lines.slice(0, shown).reduce((a, l) => a + l.cr, 0);
  const done = shown >= n;
  const total = done ? receipt.total : running;

  return (
    <div className="rounded-2xl border-[3px] border-black bg-[#fff8e1] p-4 text-black shadow-[0_4px_0_#000]">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm uppercase tracking-[0.18em] text-black/60">{guest ? "Would sell for" : "Junk sold"}</h3>
        {receipt.mult !== 1 && (
          <span className="font-body text-xs font-semibold text-black/55">{SOL_ECONOMY ? "market" : "junker"} ×{receipt.mult.toFixed(2)}</span>
        )}
      </div>
      {n === 0 ? (
        <p className="font-body mt-2 text-sm text-black/60">No junk this time — loot crates and bodies for valuables.</p>
      ) : (
        <ul className="font-body mt-2 divide-y divide-dashed divide-black/20 text-sm">
          {receipt.lines.map((l, i) => (
            <li
              key={`${l.def}:${l.label ?? ""}:${i}`}
              className={clsx(
                "flex items-center gap-2 py-1.5 transition-[opacity,transform] duration-200",
                i < shown ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0",
              )}
            >
              {l.icon ? (
                // eslint-disable-next-line @next/next/no-img-element -- static sprite
                <img src={l.icon} alt="" className="h-7 w-7 object-contain" draggable={false} />
              ) : (
                <span className="h-7 w-7" />
              )}
              <span className="min-w-0 flex-1 truncate font-semibold" style={{ color: l.icon ? darken(rarityHex(l.rarity)) : undefined }}>
                {l.name}
                {l.qty > 1 && <span className="ml-1 text-black/50">×{l.qty}</span>}
              </span>
              <span className={clsx("tabular-nums font-bold", l.cr === 0 && "text-black/40 line-through")}>{fmtCr(l.cr)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-between border-t-[3px] border-black pt-2">
        <span className="text-base uppercase tracking-wider">Total</span>
        <span className="toon-text-thin text-3xl tabular-nums text-amber-400">+{fmtCr(total)}</span>
      </div>
      {guest && n > 0 && (
        <p className="font-body mt-2 rounded-lg bg-black/10 px-2 py-1.5 text-xs font-semibold leading-snug text-black/70">
          Guests don&apos;t keep loot — register to bank these credits next time.
        </p>
      )}
      {!guest && !receipt.final && n > 0 && (
        <p className="font-body mt-1.5 text-[0.7rem] text-black/45">Estimate at base prices; your balance updates in the lobby.</p>
      )}
    </div>
  );
}

/** Rarity colours are tuned for dark UI; on the paper receipt common grey must be darker. */
function darken(hex: string): string {
  return hex === "#b8c0c8" ? "#3f4650" : hex;
}

export function DogTagRow({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm uppercase tracking-[0.18em] text-white/55">Dog tags</h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {names.map((n, i) => (
          <li key={`${n}:${i}`} className="toon-chip flex items-center gap-1.5 py-1 pl-1.5 pr-3 text-sm text-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- static sprite */}
            <img src="/sprites/junk_dogtag.png" alt="" className="h-6 w-6 object-contain" draggable={false} />
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}
