import Link from "next/link";
import clsx from "clsx";

/**
 * Brawl Stars style money pill: a dark bevelled bar with the currency's coin bulging out of its left
 * end, the value in display type and a chunky green "+" on the right. 44 px tall (40 px on a
 * landscape phone).
 */
const pill =
  "menu-chip h-11 gap-2 whitespace-nowrap bg-[#141a29] pl-1 pr-1 text-white tabular-nums focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70 short:h-10";

const plus =
  "grid h-8 w-8 shrink-0 place-items-center rounded-xl border-[3px] border-black bg-[linear-gradient(180deg,#8dff6a,#3fd63a)] text-xl leading-none text-black shadow-[inset_0_2px_0_rgba(255,255,255,0.5)] short:h-7 short:w-7";

/** Coin glyph (CR). */
function Coin() {
  return (
    <svg viewBox="0 0 32 32" className="-ml-3 h-10 w-10 shrink-0 drop-shadow-[0_2px_0_#000] short:h-9 short:w-9" aria-hidden>
      <circle cx="16" cy="16" r="13" fill="#fbbf24" stroke="#000" strokeWidth="3" />
      <circle cx="16" cy="16" r="8" fill="#fcd34d" stroke="#b45309" strokeWidth="2" />
      <path d="M10 10.5a8 8 0 0 1 6-3" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" fill="none" opacity="0.8" />
    </svg>
  );
}

/** Diamond glyph (market currency). */
function Gem() {
  return (
    <svg viewBox="0 0 32 32" className="-ml-3 h-10 w-10 shrink-0 drop-shadow-[0_2px_0_#000] short:h-9 short:w-9" aria-hidden>
      <path d="M16 3 L28 13 L16 29 L4 13 Z" fill="#14f195" stroke="#000" strokeWidth="3" strokeLinejoin="round" />
      <path d="M4 13 H28 M11 13 L16 4 L21 13 L16 29" fill="none" stroke="#0b8f5a" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 11 L13 6" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.8" />
    </svg>
  );
}

/** CR: opens Shop · Traders. `value` null = loading. */
export function CreditsPill({ value, onClick, className }: { value: string | null; onClick: () => void; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={clsx(pill, className)} aria-label={value ? `${value}. Open the traders` : "Credits loading"}>
      <Coin />
      <span className="min-w-[3.5rem] text-base tracking-wide port:min-w-0 short:text-sm">
        <span className="optical-center">{value ?? "—"}</span>
      </span>
      <span className={plus} aria-hidden>
        <span className="optical-center">+</span>
      </span>
    </button>
  );
}

/** The market wallet (SOL): links to /wallet to top up. */
export function WalletPill({ value, className }: { value: string | null; className?: string }) {
  return (
    <Link href="/wallet" className={clsx(pill, "text-sol-400", className)} aria-label={value ? `Wallet ${value}. Top up` : "Wallet"}>
      <Gem />
      <span className="min-w-[3.5rem] text-base tracking-wide port:min-w-0 short:text-sm">
        <span className="optical-center">{value ?? "—"}</span>
      </span>
      <span className={plus} aria-hidden>
        <span className="optical-center">+</span>
      </span>
    </Link>
  );
}
