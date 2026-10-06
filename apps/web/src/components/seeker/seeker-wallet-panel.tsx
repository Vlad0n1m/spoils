"use client";

import { useEffect } from "react";
import clsx from "clsx";
import { cosmeticDef } from "@extract/shared";
import { shortAddress } from "@/lib/wallet/siws";
import { SeekerBadge } from "./seeker-badge";
import { claimSeeker, loadSeeker, refreshSeeker, useSeeker } from "./seeker-store";

const ghostBtn =
  "inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-5 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime motion-reduce:transition-none";
const claimBtn =
  "font-display inline-flex min-h-11 items-center justify-center rounded-full px-6 text-sm tracking-wide text-white shadow-[0_3px_0_#000] transition hover:brightness-110 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#19fb9b]/50 motion-reduce:transition-none";

function checkedAgo(iso: string | null): string {
  if (!iso) return "";
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "Checked just now";
  if (m < 60) return `Checked ${m} min ago`;
  return `Checked ${Math.round(m / 60)} h ago`;
}

/**
 * The Seeker part of the wallet card (lib/seeker): "Seeker verified" with the one-time frame claim
 * when the linked wallet holds a Seeker Genesis Token on mainnet; otherwise the hint to link the
 * Seeker's wallet, with "Check again" once a wallet is linked. `linkedAddress` reloads the status
 * when the player links or unlinks.
 */
export function SeekerWalletPanel({ userId, linkedAddress }: { userId: string; linkedAddress: string | null }) {
  const s = useSeeker();

  useEffect(() => {
    void loadSeeker(userId, true);
  }, [userId, linkedAddress]);

  const d = s.data;
  const frameName = cosmeticDef(d?.reward ?? "")?.name ?? "Seeker Genesis";

  if (s.status === "idle" || (s.status === "loading" && !d)) {
    return <span className="mt-5 block h-16 w-full max-w-xl animate-pulse rounded-2xl bg-white/10 motion-reduce:animate-none" aria-hidden />;
  }

  const verified = d?.verified === true && !!linkedAddress;
  return (
    <div
      className={clsx(
        "mt-5 max-w-xl rounded-2xl border p-4",
        verified ? "border-[#19fb9b]/40 bg-[linear-gradient(135deg,rgba(153,69,255,0.16),rgba(25,251,155,0.10))]" : "border-white/10 bg-white/[0.03]",
      )}
      aria-live="polite"
    >
      {verified ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SeekerBadge />
            <p className="font-display text-base tracking-wide text-white">Seeker verified</p>
          </div>
          <p className="font-body mt-1.5 text-sm leading-relaxed text-white/75">
            This wallet holds a Seeker Genesis Token{d?.mint ? <span className="font-mono text-white/60"> ({shortAddress(d.mint)})</span> : null}. Your
            nickname shows the Seeker badge in the lobby, your party and the leaderboards. Cosmetic only.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {d?.claimed ? (
              <p className="font-body text-sm font-semibold text-[#8dffc9]">{frameName} frame claimed · wear it in Rewards</p>
            ) : d?.claimable ? (
              <button
                type="button"
                className={claimBtn}
                style={{ background: "linear-gradient(135deg, #9945ff, #19fb9b)" }}
                disabled={s.busy !== null}
                onClick={() => void claimSeeker()}
              >
                {s.busy === "claim" ? "Claiming…" : `Claim the ${frameName} frame`}
              </button>
            ) : (
              <p className="font-body text-sm text-white/70">This Seeker&apos;s frame was already claimed on another account.</p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SeekerBadge className="opacity-60 grayscale" />
            <p className="font-body text-sm font-semibold text-white/85">Own a Seeker? Link your wallet to get the Seeker badge</p>
          </div>
          <p className="font-body mt-1.5 text-sm leading-relaxed text-white/65">
            {linkedAddress
              ? "No Seeker Genesis Token in this wallet. It lives in your Seed Vault Wallet's primary account: link that one."
              : "Link the Seed Vault Wallet account that holds your Seeker Genesis Token. A badge and a one-time frame, cosmetic only."}
          </p>
          {linkedAddress && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button type="button" className={ghostBtn} disabled={s.busy !== null} onClick={() => void refreshSeeker()}>
                {s.busy === "refresh" ? "Checking…" : "Check again"}
              </button>
              <span className="font-body text-xs text-white/55">{checkedAgo(d?.checkedAt ?? null)}</span>
            </div>
          )}
        </>
      )}
      {(s.error || d?.unavailable) && (
        <p role="alert" className="font-body mt-2 text-sm font-semibold text-amber-300/90">
          {s.error ?? "Couldn't reach Solana to check right now. Try again in a minute."}
        </p>
      )}
    </div>
  );
}
