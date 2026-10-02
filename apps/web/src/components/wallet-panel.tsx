"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/lib/session-context";
import { formatUsdCents } from "@/lib/format-money";
import { isWalletDevTopupEnabled } from "@/lib/wallet-dev-topup";
import { Reveal } from "@/components/reveal";

const glass =
  "rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8";

const glassMuted =
  "rounded-[2rem] border border-dashed border-white/15 bg-zooa-dark/50 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_12px_32px_-12px_rgba(0,0,0,0.4)] backdrop-blur md:p-7";

function PageIntro() {
  return (
    <Reveal as="div" delay={0} className="mb-8 md:mb-10">
      <h1 className="font-display text-2xl tracking-wide text-[#c4f07a] md:text-3xl">Wallet</h1>
      <p className="mt-2 max-w-[65ch] text-sm leading-relaxed text-white/55">
        In-game balance in US dollar cents. On-chain top-ups and cash-out will connect here as custody goes live.
      </p>
    </Reveal>
  );
}

export function WalletPanel() {
  const { user, refresh } = useSession();
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [topUpError, setTopUpError] = useState<string | null>(null);
  const devTopupEnabled = isWalletDevTopupEnabled();

  const addDevHundredDollars = async () => {
    setTopUpBusy(true);
    setTopUpError(null);
    try {
      const r = await fetch("/api/wallet/dev-topup", {
        method: "POST",
        credentials: "include",
      });
      const data = (await r.json()) as { error?: string };
      if (!r.ok) {
        setTopUpError(data.error ?? "topup_failed");
        return;
      }
      await refresh();
    } catch {
      setTopUpError("network_error");
    } finally {
      setTopUpBusy(false);
    }
  };

  if (!user) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-10">
        <PageIntro />
        <Reveal as="div" delay={100}>
          <div className={`${glass} max-w-xl`}>
            <p className="text-base leading-relaxed text-white/70">
              Sign in with email to see your balance and future top-ups.
            </p>
            <p className="mt-4 text-sm text-white/45">Use &quot;Sign in&quot; in the header to continue.</p>
          </div>
        </Reveal>
      </div>
    );
  }

  if (user.isGuest) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-10">
        <PageIntro />
        <Reveal as="div" delay={100}>
          <div className={`${glass} max-w-xl`}>
            <p className="text-base leading-relaxed text-white/70">
              Wallet and on-chain balance require a registered account. Sign out and create an account with email, or
              sign in if you already have one.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link
                href="/auth/register?next=/wallet"
                className="font-display inline-flex min-h-11 items-center justify-center rounded-full bg-zooa-lime px-6 text-sm tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98]"
              >
                Register
              </Link>
              <Link
                href="/auth/login?next=/wallet"
                className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-6 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 active:scale-[0.98]"
              >
                Sign in
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-10">
      <PageIntro />
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12 lg:gap-8">
        <Reveal as="section" delay={80} className={`${glass} lg:col-span-7`}>
          <h2 className="font-display text-base tracking-wide text-white/90 md:text-lg">In-game balance</h2>
          <p className="mt-2 font-mono text-3xl tabular-nums tracking-tight text-zooa-lime md:text-4xl">
            {formatUsdCents(user.balanceCents)}
          </p>
          <p className="mt-2 text-xs text-white/40">Settled to USD cents in the database</p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={refresh}
              className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-5 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98]"
            >
              Refresh
            </button>
            {devTopupEnabled && (
              <button
                type="button"
                onClick={addDevHundredDollars}
                disabled={topUpBusy}
                className="font-display inline-flex min-h-11 min-w-[10rem] items-center justify-center rounded-full bg-zooa-lime px-6 text-sm tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {topUpBusy ? "Adding…" : "Add $100"}
              </button>
            )}
          </div>
          {devTopupEnabled && (
            <p className="mt-2 text-xs text-white/35">
              Test credit: adds $100.00 to your in-game balance (not available in production unless enabled).
            </p>
          )}
          {topUpError && (
            <p className="mt-2 text-sm text-rose-300/90" role="alert">
              {topUpError}
            </p>
          )}
        </Reveal>

        <div className="grid grid-cols-1 gap-6 lg:col-span-5">
          <Reveal as="section" delay={140} className={glassMuted}>
            <h2 className="font-display text-base tracking-wide text-[#c4f07a] md:text-lg">Add funds</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              Deposits are not live yet. Planned: send crypto from any wallet, credit your in-game balance in US dollars
              (cents in the database).
            </p>
            <p className="mt-4 rounded-xl border border-white/5 bg-white/[0.04] p-3 font-mono text-xs break-all text-white/45">
              {user.depositAddress}
            </p>
            <p className="mt-2 text-xs text-white/35">Legacy deposit address (read-only for now)</p>
          </Reveal>

          <Reveal as="section" delay={200} className={glassMuted}>
            <h2 className="font-display text-base tracking-wide text-[#c4f07a] md:text-lg">Withdraw</h2>
            <p className="mt-2 text-sm leading-relaxed text-white/60">
              Withdrawals to a wallet will ship with the updated custody model. For now, the balance is in-game only (USD
              cents).
            </p>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
