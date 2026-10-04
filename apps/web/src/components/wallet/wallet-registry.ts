"use client";

import { useSyncExternalStore } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import { StandardConnect } from "@wallet-standard/features";
import { SolanaSignIn, SolanaSignMessage } from "@solana/wallet-standard-features";
import { BRAND } from "@/lib/brand";
import { walletChain } from "@/lib/wallet/cluster";

/**
 * Solana wallets the page can link (Wallet Standard): browser extensions such as Phantom, Solflare or
 * Backpack register themselves; on Android the Mobile Wallet Adapter (@solana-mobile/wallet-standard-mobile,
 * loaded lazily so desktop and the game never download it) registers one entry that opens whichever
 * wallet app is installed — Phantom, Solflare, Seed Vault on the Seeker — also inside the TWA.
 * Started on first use by the wallet UI, not at app boot.
 */

export interface WalletRegistrySnapshot {
  wallets: readonly Wallet[];
  /** False while the Android MWA module is still loading (avoid flashing "no wallet found"). */
  ready: boolean;
}

const EMPTY: WalletRegistrySnapshot = { wallets: [], ready: false };
let snapshot: WalletRegistrySnapshot = EMPTY;
let started = false;
const listeners = new Set<() => void>();

function emit(next: WalletRegistrySnapshot): void {
  snapshot = next;
  for (const l of listeners) l();
}

/** Can sign a SIWS message: `solana:signIn`, or connect + `solana:signMessage`. */
export function canLink(w: Wallet): boolean {
  if (!w.chains.some((c) => c.startsWith("solana:"))) return false;
  return SolanaSignIn in w.features || (StandardConnect in w.features && SolanaSignMessage in w.features);
}

function isAndroid(): boolean {
  return typeof navigator !== "undefined" && /android/i.test(navigator.userAgent);
}

/**
 * MWA keeps the wallet's authorization (including its last Sign-In result) in a cache and answers a
 * later signIn from it without opening the wallet, which would replay an old nonce. The link signs in
 * once per attempt, so nothing is cached.
 */
const NO_AUTH_CACHE = {
  clear: async () => undefined,
  get: async () => undefined,
  set: async () => undefined,
};

async function registerMobileWalletAdapter(): Promise<void> {
  try {
    const mwa = await import("@solana-mobile/wallet-standard-mobile");
    mwa.registerMwa({
      appIdentity: { name: BRAND.name, uri: `${window.location.origin}/`, icon: "icon-192.png" },
      authorizationCache: NO_AUTH_CACHE,
      chains: [walletChain()],
      chainSelector: mwa.createDefaultChainSelector(),
      onWalletNotFound: mwa.createDefaultWalletNotFoundHandler(),
    });
  } catch (e) {
    console.warn("[wallet] Mobile Wallet Adapter unavailable", e);
  }
}

export function startWalletRegistry(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  const api = getWallets();
  let ready = !isAndroid();
  const update = () => emit({ wallets: api.get().filter(canLink), ready });
  api.on("register", update);
  api.on("unregister", update);
  update();
  if (!ready) {
    void registerMobileWalletAdapter().finally(() => {
      ready = true;
      update();
    });
  }
}

function subscribe(listener: () => void): () => void {
  startWalletRegistry();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWalletRegistry(): WalletRegistrySnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
