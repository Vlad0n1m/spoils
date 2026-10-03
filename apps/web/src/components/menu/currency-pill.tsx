import Link from "next/link";
import clsx from "clsx";

const pill =
  "inline-flex min-h-10 items-center gap-1.5 whitespace-nowrap rounded-full border-[3px] border-black px-3 text-sm tabular-nums shadow-[0_3px_0_#000] transition-[transform,box-shadow] hover:-translate-y-px active:translate-y-[2px] active:shadow-[0_1px_0_#000] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/70";

/** Coin glyph (CR). */
function Coin() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" aria-hidden>
      <circle cx="10" cy="10" r="8" fill="#fbbf24" stroke="#000" strokeWidth="2.5" />
      <circle cx="10" cy="10" r="4" fill="none" stroke="#000" strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}

/** Diamond glyph (market currency). */
function Gem() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" aria-hidden>
      <path d="M10 2 L18 9 L10 18 L2 9 Z" fill="#14f195" stroke="#000" strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Top-bar money pills (WORLD v6 spec §6.2): CR (amber, opens Shop · Traders) and the market wallet
 * (SOL green, links to /wallet with a "+"). `value` null = loading.
 */
export function CreditsPill({ value, onClick }: { value: string | null; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={clsx(pill, "bg-amber-300 text-black")} aria-label={value ? `${value}. Open the traders` : "Credits loading"}>
      <Coin />
      <span className="optical-center">{value ?? "—"}</span>
    </button>
  );
}

export function WalletPill({ value, className }: { value: string | null; className?: string }) {
  return (
    <Link href="/wallet" className={clsx(pill, "bg-[#0f2a1f] text-sol-400", className)} aria-label={value ? `Wallet ${value}. Top up` : "Wallet"}>
      <Gem />
      <span className="optical-center">{value ?? "—"}</span>
      <span className="ml-0.5 grid h-5 w-5 place-items-center rounded-full border-2 border-black bg-sol-400 text-xs text-black" aria-hidden>
        +
      </span>
    </Link>
  );
}
