"use client";

import { useSyncExternalStore } from "react";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import {
  SolanaSignIn,
  SolanaSignMessage,
  type SolanaSignInFeature,
  type SolanaSignMessageFeature,
} from "@solana/wallet-standard-features";
import { buildSiwsMessage, type SiwsChallenge } from "@/lib/wallet/siws";
import type { LinkedWallet } from "@/lib/wallet/types";

/**
 * Wallet link state shared by the account menu and /wallet (one module store, so a flow started in the
 * menu survives the menu closing — e.g. when a wallet's own dialog takes the click).
 *
 * Link flow: openChooser() prefetches the server nonce while the player picks a wallet, so the tap on
 * a wallet goes straight to the wallet (Android only launches the wallet app from a fresh tap). Then
 * solana:signIn when the wallet has it (one prompt; Phantom checks the domain), else connect +
 * signMessage of the same SIWS text (also on the next tap after a signIn without a result: older
 * Mobile Wallet Adapter wallets), then POST /api/wallet/link. Nothing else is ever asked of the
 * wallet: no transactions, no transfers.
 */

export type LinkPhase = "idle" | "signing" | "verifying" | "unlinking";

export interface WalletLinkState {
  /** Account whose link is loaded (a different sign-in reloads it). */
  userId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  linked: LinkedWallet | null;
  phase: LinkPhase;
  /** Wallet being asked to sign, for "Approve in Phantom…". */
  walletName: string | null;
  error: string | null;
  /** Set after a successful link until the next flow, for a short confirmation. */
  justLinked: boolean;
}

const INITIAL: WalletLinkState = {
  userId: null,
  status: "idle",
  linked: null,
  phase: "idle",
  walletName: null,
  error: null,
  justLinked: false,
};

let state: WalletLinkState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<WalletLinkState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useWalletLink(): WalletLinkState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

class FlowError extends Error {}

async function readError(res: Response, fallback: string): Promise<FlowError> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (res.status === 429) return new FlowError(body.message ?? "Too many attempts. Wait a minute and try again.");
    return new FlowError(body.message ?? fallback);
  } catch {
    return new FlowError(fallback);
  }
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/** fetch() whose network failure reads as a player message. */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { credentials: "include", cache: "no-store", ...init });
  } catch {
    throw new FlowError("Network error. Check your connection and try again.");
  }
}

/** Loads the link of this account once (again after another account signs in, or with force). */
export async function loadWalletLink(userId: string, force = false): Promise<void> {
  if (!force && state.userId === userId && (state.status === "loading" || state.status === "ready")) return;
  set({ ...INITIAL, userId, status: "loading" });
  try {
    const res = await request("/api/wallet/link");
    if (!res.ok) throw await readError(res, "Couldn't load your wallet.");
    const body = (await res.json()) as { wallet: LinkedWallet | null };
    if (state.userId !== userId) return;
    set({ status: "ready", linked: body.wallet });
  } catch (e) {
    if (state.userId !== userId) return;
    set({ status: "error", error: e instanceof FlowError ? e.message : "Couldn't load your wallet." });
  }
}

// ── challenge prefetch ──────────────────────────────────────────────────────────────────────────

/** Server nonces live 10 minutes; one older than this is fetched again before signing. */
const CHALLENGE_FRESH_MS = 8 * 60_000;
let prefetched: { at: number; userId: string | null; promise: Promise<SiwsChallenge> } | null = null;

function freshPrefetch(): Promise<SiwsChallenge> | null {
  return prefetched && prefetched.userId === state.userId && Date.now() - prefetched.at < CHALLENGE_FRESH_MS
    ? prefetched.promise
    : null;
}

async function fetchChallenge(): Promise<SiwsChallenge> {
  const res = await request("/api/wallet/link/nonce", {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}",
  });
  if (!res.ok) throw await readError(res, "Couldn't start the wallet sign-in. Try again.");
  return ((await res.json()) as { challenge: SiwsChallenge }).challenge;
}

/** Call when the wallet list opens: the nonce is ready by the time the player taps a wallet. */
export function prefetchChallenge(): void {
  if (freshPrefetch()) return;
  const promise = fetchChallenge();
  // A failed prefetch is dropped; the tap on a wallet then fetches again and shows that error.
  promise.catch(() => {
    if (prefetched?.promise === promise) prefetched = null;
  });
  prefetched = { at: Date.now(), userId: state.userId, promise };
}

function takeChallenge(): Promise<SiwsChallenge> {
  const p = freshPrefetch() ?? fetchChallenge();
  prefetched = null; // single use
  return p;
}

// ── signing ─────────────────────────────────────────────────────────────────────────────────────

interface SignedProof {
  address: string;
  signedMessage: Uint8Array;
  signature: Uint8Array;
}

type SignInMethod = SolanaSignInFeature[typeof SolanaSignIn];
type ConnectMethod = StandardConnectFeature[typeof StandardConnect];
type SignMessageMethod = SolanaSignMessageFeature[typeof SolanaSignMessage];

/**
 * Wallets (by name) whose solana:signIn came back without a sign-in result. The Mobile Wallet Adapter
 * always offers signIn, but MWA 1.x wallet apps authorize and ignore the sign-in payload, and
 * wallet-standard-mobile then throws. The next tap on such a wallet uses connect + signMessage of the
 * same SIWS text instead (not in the same tap: Android opens the wallet app only from a fresh tap).
 */
const signInWithoutResult = new Set<string>();

/** wallet-standard-mobile's error for an authorization that carried no sign_in_result. */
export function isMissingSignInResult(e: unknown): boolean {
  const err = e as { message?: unknown; cause?: { message?: unknown } } | null;
  return /no sign in result/i.test(`${String(err?.message ?? "")} ${String(err?.cause?.message ?? "")}`);
}

async function signChallenge(wallet: Wallet, ch: SiwsChallenge): Promise<SignedProof> {
  const signIn = signInWithoutResult.has(wallet.name) ? undefined : (wallet.features[SolanaSignIn] as SignInMethod | undefined);
  if (signIn) {
    let out: Awaited<ReturnType<SignInMethod["signIn"]>>[number] | undefined;
    try {
      [out] = await signIn.signIn({
        domain: ch.domain,
        statement: ch.statement,
        uri: ch.uri,
        version: ch.version,
        chainId: ch.chainId,
        nonce: ch.nonce,
        issuedAt: ch.issuedAt,
        expirationTime: ch.expirationTime,
      });
    } catch (e) {
      if (!isMissingSignInResult(e)) throw e;
      signInWithoutResult.add(wallet.name);
      throw new FlowError("This wallet needs one more step. Tap it again to sign the link message.");
    }
    if (!out) throw new FlowError("The wallet didn't return a signature. Try again.");
    return { address: out.account.address, signedMessage: out.signedMessage, signature: out.signature };
  }

  const connect = wallet.features[StandardConnect] as ConnectMethod | undefined;
  const signMessage = wallet.features[SolanaSignMessage] as SignMessageMethod | undefined;
  if (!connect || !signMessage) throw new FlowError("This wallet can't sign messages. Pick another one.");
  const { accounts } = await connect.connect();
  const account: WalletAccount | undefined =
    accounts.find((a) => a.chains.some((c) => c.startsWith("solana:")) && a.features.includes(SolanaSignMessage)) ??
    accounts[0];
  if (!account) throw new FlowError("The wallet didn't share an account. Try again.");
  const message = new TextEncoder().encode(buildSiwsMessage({ ...ch, address: account.address }));
  const [out] = await signMessage.signMessage({ account, message });
  if (!out) throw new FlowError("The wallet didn't return a signature. Try again.");
  return { address: account.address, signedMessage: out.signedMessage, signature: out.signature };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

/** Wallet-side failures (Wallet Standard wallets and the Mobile Wallet Adapter) in player words. */
export function describeWalletError(e: unknown): string {
  if (e instanceof FlowError) return e.message;
  const err = e as { message?: unknown; code?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
  const code = String(err?.cause?.code ?? err?.code ?? "");
  const text = `${String(err?.message ?? "")} ${String(err?.cause?.message ?? "")}`;
  if (code === "ERROR_WALLET_NOT_FOUND") return "No Solana wallet app found on this phone. Install one (Phantom, Solflare) and try again.";
  if (code === "ERROR_LOOPBACK_ACCESS_BLOCKED") return "The browser blocked the wallet connection. Allow local network access for this site and try again.";
  if (code === "ERROR_SESSION_TIMEOUT") return "The wallet took too long to answer. Try again.";
  if (
    code === "4001" ||
    code === "ERROR_AUTHORIZATION_FAILED" ||
    code === "ERROR_ASSOCIATION_CANCELLED" ||
    code === "ERROR_SESSION_CLOSED" ||
    /reject|declin|cancel|denied|closed/i.test(text)
  ) {
    return "Request cancelled in the wallet.";
  }
  return "The wallet didn't finish the request. Try again.";
}

// ── actions ─────────────────────────────────────────────────────────────────────────────────────

export function clearWalletLinkError(): void {
  if (state.error) set({ error: null });
}

export async function linkWallet(wallet: Wallet): Promise<boolean> {
  if (state.phase !== "idle") return false;
  set({ phase: "signing", walletName: wallet.name, error: null, justLinked: false });
  const userId = state.userId;
  try {
    const challenge = await takeChallenge();
    const proof = await signChallenge(wallet, challenge);
    set({ phase: "verifying" });
    const res = await request("/api/wallet/link", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        address: proof.address,
        message: toBase64(proof.signedMessage),
        signature: toBase64(proof.signature),
      }),
    });
    if (!res.ok) throw await readError(res, "Couldn't link the wallet. Try again.");
    const body = (await res.json()) as { wallet: LinkedWallet };
    if (state.userId !== userId) return false;
    set({ phase: "idle", walletName: null, linked: body.wallet, status: "ready", justLinked: true });
    return true;
  } catch (e) {
    set({ phase: "idle", walletName: null, error: describeWalletError(e) });
    // The nonce is spent; have the next one ready so a retry tap reaches the wallet at once.
    if (!state.linked && state.userId === userId) prefetchChallenge();
    return false;
  }
}

export async function unlinkWallet(): Promise<boolean> {
  if (state.phase !== "idle") return false;
  set({ phase: "unlinking", error: null, justLinked: false });
  try {
    const res = await request("/api/wallet/link", { method: "DELETE" });
    if (!res.ok) throw await readError(res, "Couldn't unlink the wallet. Try again.");
    set({ phase: "idle", linked: null });
    return true;
  } catch (e) {
    set({ phase: "idle", error: e instanceof FlowError ? e.message : "Couldn't unlink the wallet. Try again." });
    return false;
  }
}
