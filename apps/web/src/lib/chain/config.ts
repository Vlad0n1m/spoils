import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Settings of the on-chain event recorder (README "On-chain"). Everything is optional: without a
 * signer key the worker sends nothing and events simply stay queued.
 *
 *   CHAIN_AUTHORITY_SECRET  server record signer, base58 secret key or a solana-keygen JSON array.
 *                           Outside production the gitignored programs/.keys/authority.json is used
 *                           when the variable is unset.
 *   CHAIN_HASH_SALT         secret salt of the user hashes put on chain (dev: a fixed dev salt).
 *   CHAIN_PROGRAM_ID        spoils_events program id (default: the devnet deployment below).
 *   CHAIN_RPC_URL           RPC of the program's cluster; falls back to SOLANA_RPC_URL, then devnet.
 *   CHAIN_CLUSTER           explorer cluster label (default devnet).
 */

/** spoils_events on devnet (programs/Anchor.toml). */
export const DEVNET_PROGRAM_ID = "8Jc6sbbLY7PoJ2wms33k9MzYmMBdidH96vX4nLFbqf9B";
export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEV_HASH_SALT = "spoils-dev-chain-salt-v1";

type EnvSource = Record<string, string | undefined>;

const isProd = (env: EnvSource) => env.NODE_ENV === "production";
const val = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function chainProgramId(env: EnvSource = process.env): PublicKey {
  return new PublicKey(val(env.CHAIN_PROGRAM_ID) ?? DEVNET_PROGRAM_ID);
}

export function chainRpcUrl(env: EnvSource = process.env): string {
  return val(env.CHAIN_RPC_URL) ?? val(env.SOLANA_RPC_URL) ?? DEFAULT_RPC_URL;
}

export function chainCluster(env: EnvSource = process.env): string {
  return val(env.CHAIN_CLUSTER) ?? "devnet";
}

/** Salt of the on-chain user hashes; null in production when CHAIN_HASH_SALT is unset. */
export function chainHashSalt(env: EnvSource = process.env): string | null {
  return val(env.CHAIN_HASH_SALT) ?? (isProd(env) ? null : DEV_HASH_SALT);
}

/** A base58 secret key or a JSON byte array (solana-keygen file content); null when malformed. */
export function parseSecretKey(raw: string): Keypair | null {
  const s = raw.trim();
  try {
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
    if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
    if (bytes.length === 32) return Keypair.fromSeed(bytes);
  } catch {
    // fall through: never echo the input
  }
  return null;
}

/** Where the dev fallback key may sit: the web runs from apps/web, scripts and tests from the repo root. */
export function devKeyCandidates(cwd = process.cwd()): string[] {
  const rel = path.join("programs", ".keys", "authority.json");
  return [path.join(cwd, rel), path.join(cwd, "..", "..", rel)];
}

export type AuthoritySource = "env" | "dev-file";

/**
 * The record signer: CHAIN_AUTHORITY_SECRET, else (not in production) the gitignored dev key file.
 * Returns null when nothing usable is configured; a malformed secret is reported by name only.
 */
export function loadChainAuthority(
  env: EnvSource = process.env,
  readFile: (p: string) => string | null = readIfExists,
  cwd = process.cwd(),
): { keypair: Keypair; source: AuthoritySource } | null {
  const raw = val(env.CHAIN_AUTHORITY_SECRET);
  if (raw) {
    const kp = parseSecretKey(raw);
    if (!kp) console.error("[chain] CHAIN_AUTHORITY_SECRET is not a base58 secret key or a JSON byte array");
    return kp ? { keypair: kp, source: "env" } : null;
  }
  if (isProd(env)) return null;
  for (const p of devKeyCandidates(cwd)) {
    const text = readFile(p);
    if (text === null) continue;
    const kp = parseSecretKey(text);
    if (kp) return { keypair: kp, source: "dev-file" };
  }
  return null;
}

function readIfExists(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}

export function explorerUrl(kind: "address" | "tx", id: string, cluster = chainCluster()): string {
  const q = cluster === "mainnet-beta" ? "" : `?cluster=${encodeURIComponent(cluster)}`;
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}
