"use client";

import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignTransaction, type SolanaSignTransactionFeature } from "@solana/wallet-standard-features";
import { startWalletRegistry } from "@/components/wallet/wallet-registry";
import { describeWalletError } from "@/components/wallet/wallet-link-store";
import { walletChain } from "@/lib/wallet/cluster";

/**
 * Signing for /onchain: the server prepares a transaction (lib/onchain/ops.ts), the player's linked
 * wallet signs it here with solana:signTransaction (Phantom, Solflare, Backpack, and Seed Vault or any
 * wallet app through the Mobile Wallet Adapter), and the server relays it. The wallet must sign with
 * the linked address; nothing is sent from the browser.
 */

type ConnectMethod = StandardConnectFeature[typeof StandardConnect];
type SignTxMethod = SolanaSignTransactionFeature[typeof SolanaSignTransaction];

/** Wallets on this device that can sign transactions on Solana. */
export function signingWallets(): Wallet[] {
  startWalletRegistry();
  return getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c.startsWith("solana:")) && SolanaSignTransaction in w.features && StandardConnect in w.features);
}

export class SignError extends Error {}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s);
}

/** Signs a base64 transaction with `wallet`, which must expose the linked address. Returns base64. */
export async function signPrepared(wallet: Wallet, linked: string, txB64: string): Promise<string> {
  try {
    let account: WalletAccount | undefined = wallet.accounts.find((a) => a.address === linked);
    if (!account) {
      const { accounts } = await (wallet.features[StandardConnect] as ConnectMethod).connect();
      account = accounts.find((a) => a.address === linked);
    }
    if (!account) {
      throw new SignError(`Switch ${wallet.name} to your linked address ${linked.slice(0, 4)}…${linked.slice(-4)} and try again.`);
    }
    const sign = wallet.features[SolanaSignTransaction] as SignTxMethod;
    const [out] = await sign.signTransaction({ account, transaction: fromB64(txB64), chain: walletChain() });
    if (!out) throw new SignError("The wallet didn't return a signed transaction.");
    return toB64(out.signedTransaction);
  } catch (e) {
    if (e instanceof SignError) throw e;
    throw new SignError(describeWalletError(e));
  }
}
