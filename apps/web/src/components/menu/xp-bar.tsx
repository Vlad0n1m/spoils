"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { levelProgress } from "@extract/shared";

/** "1 240" (thin-space groups, like fmtCr). */
export function fmtInt(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return `${v < 0 ? "−" : ""}${Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")}`;
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

const FILL_MS = 900;

/**
 * XP progress inside the current level (WORLD v6 spec §6.2, §6.6): "1 240 / 1 300 XP", tooltip
 * "Level 7 · 60 XP to level 8". When `xp` grows (a reload after a raid) the bar fills from the old
 * value in 900 ms; across a level-up it runs to the end, flashes, and fills the new level from 0.
 */
export function XpBar({ xp, variant = "bar" }: { xp: number; variant?: "bar" | "thin" }) {
  const p = levelProgress(xp);
  const target = p.need > 0 ? Math.min(100, (p.into / p.need) * 100) : 0;
  const prev = useRef<{ level: number; xp: number } | null>(null);
  const [pct, setPct] = useState(target);
  const [anim, setAnim] = useState(false);
  const [flash, setFlash] = useState(0);

  useEffect(() => {
    const before = prev.current;
    prev.current = { level: p.level, xp };
    if (!before || xp <= before.xp || reducedMotion()) {
      setAnim(false);
      setPct(target);
      return;
    }
    if (p.level === before.level) {
      setAnim(true);
      setPct(target);
      return;
    }
    setAnim(true);
    setPct(100);
    let raf = 0;
    const t = window.setTimeout(() => {
      setFlash((f) => f + 1);
      setAnim(false);
      setPct(0);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          setAnim(true);
          setPct(target);
        });
      });
    }, FILL_MS);
    return () => {
      window.clearTimeout(t);
      cancelAnimationFrame(raf);
    };
    // Only a new xp value restarts the animation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xp]);

  const tip = `Level ${p.level} · ${fmtInt(p.need - p.into)} XP to level ${p.level + 1} · Total ${fmtInt(p.total)} XP`;
  const fill = (
    <span
      key={flash}
      className={clsx("block h-full rounded-full bg-zooa-lime", flash > 0 && "animate-xp-fill motion-reduce:animate-none")}
      style={{ width: `${pct}%`, transition: anim ? `width ${FILL_MS}ms cubic-bezier(0.16,1,0.3,1)` : "none" }}
    />
  );

  if (variant === "thin") {
    return (
      <span
        className="block h-1 w-full overflow-hidden bg-black/60"
        role="progressbar"
        aria-label="Experience"
        aria-valuemin={0}
        aria-valuemax={p.need}
        aria-valuenow={p.into}
        aria-valuetext={tip}
        title={tip}
      >
        {fill}
      </span>
    );
  }
  // Chunky bar with the numbers inside it (top bar profile).
  return (
    <span
      className="relative block h-5 w-full min-w-[7rem] overflow-hidden rounded-full border-[3px] border-black bg-black/70 short:h-[1.1rem]"
      role="progressbar"
      aria-label="Experience"
      aria-valuemin={0}
      aria-valuemax={p.need}
      aria-valuenow={p.into}
      aria-valuetext={tip}
      title={tip}
    >
      {fill}
      <span className="absolute inset-x-0 top-0 h-1/2 bg-white/15" aria-hidden />
      <span className="menu-label absolute inset-0 grid place-items-center text-[0.75rem] leading-none tabular-nums text-white [text-shadow:none] [-webkit-text-stroke:0.22em_#000] short:text-[0.72rem]" aria-hidden>
        <span className="optical-center">
          {fmtInt(p.into)} / {fmtInt(p.need)} XP
        </span>
      </span>
    </span>
  );
}
