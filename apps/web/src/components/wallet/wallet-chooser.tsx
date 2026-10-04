"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { Wallet } from "@wallet-standard/base";
import { useWalletRegistry } from "./wallet-registry";
import { useWalletLink } from "./wallet-link-store";

type Env = "insecure" | "android" | "desktop";

function useEnv(): Env {
  const [env, setEnv] = useState<Env>("desktop");
  useEffect(() => {
    if (!window.isSecureContext) setEnv("insecure");
    else if (/android/i.test(navigator.userAgent)) setEnv("android");
  }, []);
  return env;
}

function NoWallet({ compact }: { compact?: boolean }) {
  const env = useEnv();
  const text =
    env === "insecure"
      ? "Wallets only connect on a secure (https) page."
      : env === "android"
        ? "No Solana wallet found. Install Phantom or Solflare, then try again."
        : "No Solana wallet found in this browser. Install Phantom (or another Solana wallet), then reload the page.";
  return (
    <div className={clsx("font-body text-sm leading-relaxed text-white/70", compact ? "px-3 py-2" : "")}>
      <p>{text}</p>
      {env !== "insecure" && (
        <a
          href="https://phantom.com/download"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex min-h-11 items-center font-semibold text-zooa-lime underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime"
        >
          Get Phantom
        </a>
      )}
    </div>
  );
}

/**
 * Detected Solana wallets as ≥ 48 px rows. A tap starts the link flow for that wallet; rows are
 * disabled while a flow runs.
 */
export function WalletChooser({ onPick, compact }: { onPick: (w: Wallet) => void; compact?: boolean }) {
  const { wallets, ready } = useWalletRegistry();
  const { phase } = useWalletLink();
  const busy = phase !== "idle";

  if (!ready) {
    return (
      <div className={clsx("space-y-2", compact && "px-1")} aria-busy="true">
        <span className="block h-12 animate-pulse rounded-xl bg-white/10 motion-reduce:animate-none" />
      </div>
    );
  }
  if (wallets.length === 0) return <NoWallet compact={compact} />;

  return (
    <ul className={clsx("flex flex-col gap-1.5", compact && "px-1")} aria-label="Solana wallets">
      {wallets.map((w) => (
        <li key={w.name}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onPick(w)}
            className="font-body flex min-h-12 w-full items-center gap-3 rounded-xl border-2 border-white/10 bg-white/[0.06] px-3 text-left text-sm font-semibold text-white transition hover:border-zooa-lime/50 hover:bg-white/10 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime motion-reduce:transition-none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- wallet icons are data: URIs from the wallet */}
            <img src={w.icon} alt="" width={28} height={28} className="h-7 w-7 shrink-0 rounded-lg" />
            <span className="min-w-0 flex-1 truncate">{w.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Progress, result and error of the current link flow (polite live region). */
export function WalletLinkStatus({ className }: { className?: string }) {
  const { phase, walletName, error, justLinked } = useWalletLink();
  let text: string | null = null;
  if (phase === "signing") text = `Approve the sign-in request in ${walletName ?? "your wallet"}…`;
  else if (phase === "verifying") text = "Checking the signature…";
  else if (phase === "unlinking") text = "Unlinking…";
  else if (justLinked) text = "Wallet linked.";

  return (
    <div className={clsx("font-body text-sm", className)}>
      <p aria-live="polite" className={clsx(text ? "text-white/75" : "sr-only", justLinked && phase === "idle" && "text-zooa-lime")}>
        {text}
      </p>
      {error && (
        <p role="alert" className="mt-1 font-semibold text-rose-300/90">
          {error}
        </p>
      )}
    </div>
  );
}
