"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/session-context";
import { BRAND } from "@/lib/brand";
import { SOLANA_CLUSTER, explorerAddressUrl } from "@/lib/wallet/cluster";
import { shortAddress } from "@/lib/wallet/siws";
import { useIdosFramed } from "@/components/menu/use-idos-frame";
import { SeekerWalletPanel } from "@/components/seeker/seeker-wallet-panel";
import { CopyAddressButton } from "./copy-address-button";
import { WalletChooser, WalletLinkStatus } from "./wallet-chooser";
import {
  clearWalletLinkError,
  linkWallet,
  loadWalletLink,
  prefetchChallenge,
  unlinkWallet,
  useWalletLink,
} from "./wallet-link-store";

const card =
  "rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8";
const primaryBtn =
  "font-display inline-flex min-h-11 items-center justify-center rounded-full bg-zooa-lime px-6 text-sm tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-zooa-lime/50 motion-reduce:transition-none";
const ghostBtn =
  "inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/15 bg-white/5 px-5 text-sm tracking-wide text-white/90 transition hover:border-zooa-lime/40 hover:bg-white/10 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime motion-reduce:transition-none";
const dangerBtn =
  "inline-flex min-h-11 items-center justify-center rounded-2xl border border-rose-400/40 bg-rose-500/10 px-5 text-sm tracking-wide text-rose-200 transition hover:bg-rose-500/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 motion-reduce:transition-none";

const clusterLabel = SOLANA_CLUSTER === "mainnet-beta" ? null : SOLANA_CLUSTER === "devnet" ? "Devnet" : "Testnet";

function linkedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
}

/**
 * /wallet: the self-custody Solana wallet linked to the account (registered users only). Hidden in
 * the iDos Games edition inside the iDos frame: idosgames.com blocks wallet access there and runs its
 * own wallet card, so our chooser and its "Get Phantom" link would only lead nowhere.
 */
export function WalletLinkSection() {
  const { user, loading } = useSession();
  const idosFramed = useIdosFramed();
  if (loading || !user || user.isGuest || idosFramed) return null;
  return (
    <div className="relative mx-auto w-full max-w-7xl px-4 pb-10 md:px-6 md:pb-14">
      <WalletLinkCard userId={user.id} />
    </div>
  );
}

export function WalletLinkCard({ userId }: { userId: string }) {
  const link = useWalletLink();
  const [choosing, setChoosing] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  useEffect(() => {
    void loadWalletLink(userId);
  }, [userId]);

  useEffect(() => {
    if (link.linked) setChoosing(false);
    else setConfirmUnlink(false);
  }, [link.linked]);

  const busy = link.phase !== "idle";

  return (
    <section className={card} aria-labelledby="wallet-link-title">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="wallet-link-title" className="font-display text-base tracking-wide text-[#c4f07a] md:text-lg">
          Solana wallet
        </h2>
        {clusterLabel && (
          <span className="font-body rounded-full border border-white/15 bg-white/5 px-2.5 py-0.5 text-xs lg:text-[0.8125rem] font-semibold text-white/70">
            {clusterLabel}
          </span>
        )}
      </div>
      <p className="font-body mt-2 max-w-[65ch] text-sm leading-relaxed text-white/70">
        Link a wallet you own to your {BRAND.name} account. Linking signs one message that proves the address is
        yours. It never moves funds, and {BRAND.name} never asks this wallet to approve a transaction. Your market
        balance above is separate.
      </p>

      <div className="mt-5">
        {link.status === "idle" || link.status === "loading" ? (
          <span className="block h-11 w-full max-w-md animate-pulse rounded-2xl bg-white/10 motion-reduce:animate-none" aria-hidden />
        ) : link.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="font-body text-sm font-semibold text-rose-300/90">
              {link.error}
            </p>
            <button type="button" className={ghostBtn} onClick={() => void loadWalletLink(userId, true)}>
              Retry
            </button>
          </div>
        ) : link.linked ? (
          <div className="max-w-xl">
            <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.04] p-2 pl-4">
              <div className="min-w-0 flex-1">
                <p className="font-mono text-base tracking-tight text-white" title={link.linked.address}>
                  <span className="md:hidden">{shortAddress(link.linked.address)}</span>
                  <span className="hidden break-all md:inline">{link.linked.address}</span>
                </p>
                <p className="font-body text-xs lg:text-[0.8125rem] text-white/70">Linked {linkedOn(link.linked.linkedAt)}</p>
              </div>
              <CopyAddressButton address={link.linked.address} />
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <a
                href={explorerAddressUrl(link.linked.address)}
                target="_blank"
                rel="noopener noreferrer"
                className={ghostBtn}
              >
                View on Explorer
              </a>
              {!confirmUnlink ? (
                <button type="button" className={dangerBtn} disabled={busy} onClick={() => setConfirmUnlink(true)}>
                  Unlink
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm unlink">
                  <span className="font-body text-sm text-white/75">Unlink this wallet?</span>
                  <button
                    type="button"
                    className={dangerBtn}
                    disabled={busy}
                    onClick={() => void unlinkWallet().then((ok) => ok && setConfirmUnlink(false))}
                  >
                    Yes, unlink
                  </button>
                  <button type="button" className={ghostBtn} disabled={busy} onClick={() => setConfirmUnlink(false)}>
                    Keep
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : !choosing ? (
          <button
            type="button"
            className={primaryBtn}
            disabled={busy}
            onClick={() => {
              clearWalletLinkError();
              prefetchChallenge();
              setChoosing(true);
            }}
          >
            Connect wallet
          </button>
        ) : (
          <div className="max-w-md">
            <p className="font-body mb-3 text-sm font-semibold text-white/80">Choose a wallet</p>
            <WalletChooser onPick={(w) => void linkWallet(w)} />
            <button
              type="button"
              className={`${ghostBtn} mt-3`}
              disabled={busy}
              onClick={() => {
                clearWalletLinkError();
                setChoosing(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {link.status === "ready" && <WalletLinkStatus className="mt-3" />}
        {link.status === "ready" && <SeekerWalletPanel userId={userId} linkedAddress={link.linked?.address ?? null} />}
      </div>
    </section>
  );
}
