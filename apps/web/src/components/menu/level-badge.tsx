import clsx from "clsx";
import { levelColor } from "@/lib/lobby/levels";

/**
 * Level shield (WORLD v6 spec §6.2): thick black outline, the level number inside, colour by band
 * (1–4 grey, 5–9 lime, 10–14 blue, 15–19 violet, 20+ gold). `level` null = loading skeleton.
 */
export function LevelBadge({ level, size = "md", className }: { level: number | null; size?: "sm" | "md" | "lg"; className?: string }) {
  const box = size === "lg" ? "h-[4.5rem] w-16" : size === "md" ? "h-11 w-10" : "h-8 w-7";
  const text = size === "lg" ? "text-3xl" : size === "md" ? "text-lg" : "text-sm";
  if (level === null) {
    return <span className={clsx("inline-block animate-pulse rounded-lg bg-white/15 motion-reduce:animate-none", box, className)} aria-hidden />;
  }
  return (
    <span className={clsx("relative inline-grid shrink-0 place-items-center", box, className)} role="img" aria-label={`Level ${level}`}>
      <svg viewBox="0 0 40 44" className="absolute inset-0 h-full w-full drop-shadow-[0_3px_0_#000]" aria-hidden>
        <path
          d="M20 2 L37 8 V22 C37 32 29.5 38.5 20 42 C10.5 38.5 3 32 3 22 V8 Z"
          fill={levelColor(level)}
          stroke="#000"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        <path d="M20 6 L33 10.5 V16 C26 14 14 14 7 16 V10.5 Z" fill="#fff" opacity="0.28" />
      </svg>
      <span className={clsx("toon-text-thin relative tabular-nums text-white", text)} aria-hidden>
        <span className="optical-center">{level}</span>
      </span>
    </span>
  );
}
