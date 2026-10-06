"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { shortAddress } from "@/lib/wallet/siws";
import { SeekerBadge } from "@/components/seeker/seeker-badge";
import { useSeekerVerified } from "@/components/seeker/seeker-store";
import { CopyAddressButton } from "./copy-address-button";
import { WalletChooser, WalletLinkStatus } from "./wallet-chooser";
import { clearWalletLinkError, linkWallet, loadWalletLink, prefetchChallenge, useWalletLink } from "./wallet-link-store";

/**
 * Account-menu entry of the wallet link (registered users): the linked short address with a copy
 * button (and the Seeker badge when it holds a Seeker Genesis Token), or "Connect wallet", which opens
 * the wallet list inline in the menu. Unlink lives on /wallet.
 */
export function AccountWalletEntry({ userId, itemClassName }: { userId: string; itemClassName: string }) {
  const link = useWalletLink();
  const [choosing, setChoosing] = useState(false);
  const seeker = useSeekerVerified();

  useEffect(() => {
    void loadWalletLink(userId);
  }, [userId]);

  useEffect(() => {
    if (link.linked) setChoosing(false);
  }, [link.linked]);

  if (link.status === "idle" || link.status === "loading") {
    return <span className="mx-3 my-1 block h-9 animate-pulse rounded-xl bg-white/10 motion-reduce:animate-none" aria-hidden />;
  }
  if (link.status === "error") return null; // the Wallet page shows the error and a retry

  if (link.linked) {
    return (
      <div className="flex min-h-11 items-center gap-2 pl-3">
        <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 text-zooa-lime" aria-hidden>
          <rect x="2.5" y="5" width="15" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13 10.5h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="font-body flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-white/50">
            Wallet
            {seeker && <SeekerBadge className="!h-4 !px-1 [&_span]:!text-[0.55rem]" />}
          </span>
          <span className="block truncate font-mono text-sm text-white" title={link.linked.address}>
            {shortAddress(link.linked.address)}
          </span>
        </span>
        <CopyAddressButton address={link.linked.address} />
      </div>
    );
  }

  if (!choosing) {
    return (
      <button
        type="button"
        className={clsx(itemClassName, "text-zooa-lime")}
        disabled={link.phase !== "idle"}
        onClick={() => {
          clearWalletLinkError();
          prefetchChallenge();
          setChoosing(true);
        }}
      >
        Connect wallet
      </button>
    );
  }

  return (
    <div className="rounded-xl bg-black/20 py-2">
      <p className="font-body px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-white/55">Choose a wallet</p>
      <WalletChooser compact onPick={(w) => void linkWallet(w)} />
      <WalletLinkStatus className="px-3 pt-2" />
      <button
        type="button"
        className={itemClassName}
        disabled={link.phase !== "idle"}
        onClick={() => {
          clearWalletLinkError();
          setChoosing(false);
        }}
      >
        Cancel
      </button>
    </div>
  );
}
