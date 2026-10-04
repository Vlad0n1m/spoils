import { useId } from "react";
import clsx from "clsx";
import { cosmeticDef } from "@extract/shared";
import { levelColor } from "@/lib/lobby/levels";

const SHIELD = "M20 2 L37 8 V22 C37 32 29.5 38.5 20 42 C10.5 38.5 3 32 3 22 V8 Z";

/** The shield scaled by `s` about its centre (20, 22). */
const scaled = (s: number) => `matrix(${s} 0 0 ${s} ${20 - 20 * s} ${22 - 22 * s})`;

/**
 * Earn-only badge frame (economy.ts COSMETICS, kind "frame"): a rim around the shield drawn in SVG —
 * rope, rivets, stitches, solid, double or a glow (the animated ones pulse unless reduced motion).
 */
function FrameRim({ id }: { id: string }) {
  const uid = useId().replace(/:/g, "");
  const d = cosmeticDef(id);
  if (!d || d.kind !== "frame" || !d.hex) return null;
  const hex = d.hex;
  const style = d.style ?? "solid";
  const base = style === "stitch" ? "#4a3426" : hex;
  const mid = scaled(1.1);
  return (
    <g aria-hidden>
      {style === "glow" && (
        <>
          <defs>
            <filter id={`g${uid}`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="2.2" />
            </filter>
          </defs>
          <path
            d={SHIELD}
            transform={scaled(1.26)}
            fill={hex}
            filter={`url(#g${uid})`}
            className={clsx(d.animated && "motion-safe:animate-pulse")}
          />
        </>
      )}
      <path d={SHIELD} transform={scaled(1.2)} fill={base} stroke="#000" strokeWidth={2.5 / 1.2} strokeLinejoin="round" />
      {style === "rope" && (
        <path d={SHIELD} transform={mid} fill="none" stroke="#5b4426" strokeWidth={1.7 / 1.1} strokeDasharray="2.4 1.6" strokeLinecap="round" />
      )}
      {style === "rivets" && (
        <path d={SHIELD} transform={mid} fill="none" stroke="#1f2937" strokeWidth={2 / 1.1} strokeDasharray="0.01 4.6" strokeLinecap="round" />
      )}
      {style === "stitch" && (
        <path d={SHIELD} transform={mid} fill="none" stroke={hex} strokeWidth={0.9 / 1.1} strokeDasharray="2 1.8" strokeLinecap="round" />
      )}
      {style === "double" && <path d={SHIELD} transform={mid} fill="none" stroke="#000" strokeWidth={0.9 / 1.1} />}
    </g>
  );
}

/**
 * Level shield (WORLD v6 spec §6.2): thick black outline, the level number inside, colour by band
 * (1–4 grey, 5–9 lime, 10–14 blue, 15–19 violet, 20+ gold). `level` null = loading skeleton.
 * `frame` = an equipped badge-frame cosmetic id (the shield shrinks a little to make room).
 */
export function LevelBadge({
  level,
  size = "md",
  frame,
  className,
}: {
  level: number | null;
  size?: "sm" | "md" | "lg";
  frame?: string | null;
  className?: string;
}) {
  const box = size === "lg" ? "h-[4.5rem] w-16" : size === "md" ? "h-11 w-10" : "h-8 w-7";
  const text = size === "lg" ? "text-3xl" : size === "md" ? "text-lg" : "text-sm";
  if (level === null) {
    return <span className={clsx("inline-block animate-pulse rounded-lg bg-white/15 motion-reduce:animate-none", box, className)} aria-hidden />;
  }
  const framed = Boolean(frame && cosmeticDef(frame)?.kind === "frame");
  const name = framed ? cosmeticDef(frame)!.name : null;
  return (
    <span
      className={clsx("relative inline-grid shrink-0 place-items-center", box, className)}
      role="img"
      aria-label={name ? `Level ${level}, ${name} frame` : `Level ${level}`}
    >
      <svg viewBox={framed ? "-4 -4 48 52" : "0 0 40 44"} className="absolute inset-0 h-full w-full drop-shadow-[0_3px_0_#000]" aria-hidden>
        {framed && <FrameRim id={frame!} />}
        <path d={SHIELD} fill={levelColor(level)} stroke="#000" strokeWidth="3" strokeLinejoin="round" />
        <path d="M20 6 L33 10.5 V16 C26 14 14 14 7 16 V10.5 Z" fill="#fff" opacity="0.28" />
      </svg>
      <span className={clsx("toon-text-thin relative tabular-nums text-white", framed && size === "sm" ? "text-xs lg:text-[0.8125rem]" : text)} aria-hidden>
        <span className="optical-center">{level}</span>
      </span>
    </span>
  );
}
