import clsx from "clsx";

/** Seeker colours: the Solana violet → green of the Seeker Genesis Token. */
const FROM = "#9945ff";
const TO = "#19fb9b";

function PhoneGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 16" className={className} aria-hidden>
      <rect x="1.5" y="1" width="9" height="14" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4.6 12.4h2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Seeker badge next to a nickname (lobby nick, party sheet, leaderboards): the player's linked
 * wallet holds a Seeker Genesis Token (lib/seeker). Shown, never worn; cosmetic only.
 * `compact` = a round phone chip for tight rows, otherwise a "SEEKER" pill.
 */
export function SeekerBadge({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex shrink-0 items-center justify-center border-2 border-black text-black shadow-[0_2px_0_#000]",
        compact ? "h-5 w-5 rounded-full" : "h-5 gap-1 rounded-md px-1.5",
        className,
      )}
      style={{ background: `linear-gradient(135deg, ${FROM}, ${TO})` }}
      title="Seeker verified · holds a Seeker Genesis Token"
      aria-label="Seeker verified"
      role="img"
    >
      <PhoneGlyph className={compact ? "h-3 w-3 text-white" : "h-3 w-2.5 text-white"} />
      {!compact && <span className="font-body text-[0.625rem] font-extrabold uppercase leading-none tracking-wider text-white [text-shadow:0_1px_0_#000]">Seeker</span>}
    </span>
  );
}
