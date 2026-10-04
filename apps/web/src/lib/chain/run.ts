import type { PublicKey } from "@solana/web3.js";
import type { Db } from "../inventory/db";
import { chainHashSalt, chainProgramId, chainRpcUrl, loadChainAuthority } from "./config";
import { configPda, decodeConfig, type ConfigAccount } from "./program";
import { chainConnection, createWeb3Sender } from "./sender";
import { DEFAULT_BATCH, cleanError, runChainWorker, type WorkerResult } from "./worker";

export type ChainCronResult =
  | ({ configured: true; ready: true; authority: string } & WorkerResult)
  | { configured: true; ready: false; authority: string; reason: string }
  | { configured: false; reason: string };

/** Lamports one record transaction costs the signer (one signature, no priority fee). */
export const FEE_LAMPORTS = 5_000;

/**
 * Why the cluster cannot take records right now (null = ready): program not deployed, Config not
 * initialized or owned by another key, or the signer cannot pay a full batch of fees. These are
 * operator problems, so the worker claims nothing and every event stays queued.
 */
export function readinessProblem(s: {
  programDeployed: boolean;
  config: ConfigAccount | null;
  signer: PublicKey;
  lamports: number;
  batch: number;
}): string | null {
  if (!s.programDeployed) return "program is not deployed on this cluster";
  if (!s.config) return "program Config is not initialized";
  if (!s.config.authority.equals(s.signer)) return `Config authority is ${s.config.authority.toBase58()}, not this signer`;
  const need = FEE_LAMPORTS * Math.max(1, s.batch);
  if (s.lamports < need) return `signer holds ${s.lamports} lamports, needs ${need} for a batch of fees`;
  return null;
}

/**
 * One worker pass with the configured signer and RPC (cron /api/cron/chain-events). Without a
 * signer key or a hash salt, or while the cluster is not ready (readinessProblem), nothing is
 * claimed: events stay queued until the operator fixes it.
 */
export async function runChainEventsCron(
  db: Db,
  o: { limit?: number; env?: Record<string, string | undefined> } = {},
): Promise<ChainCronResult> {
  const env = o.env ?? process.env;
  const auth = loadChainAuthority(env);
  if (!auth) return { configured: false, reason: "CHAIN_AUTHORITY_SECRET is not set" };
  const salt = chainHashSalt(env);
  if (!salt) return { configured: false, reason: "CHAIN_HASH_SALT is not set" };
  const signer = auth.keypair.publicKey;
  const authority = signer.toBase58();
  const limit = o.limit ?? DEFAULT_BATCH;
  const programId = chainProgramId(env);
  const connection = chainConnection(chainRpcUrl(env));
  let problem: string | null;
  try {
    const [prog, cfg, payer] = await connection.getMultipleAccountsInfo([programId, configPda(programId), signer]);
    problem = readinessProblem({
      programDeployed: !!prog?.executable,
      config: cfg && cfg.owner.equals(programId) ? decodeConfig(cfg.data) : null,
      signer,
      lamports: payer?.lamports ?? 0,
      batch: limit,
    });
  } catch (e) {
    problem = `RPC unavailable: ${cleanError(e)}`;
  }
  if (problem) return { configured: true, ready: false, authority, reason: problem };
  const sender = createWeb3Sender({ rpcUrl: chainRpcUrl(env), connection, authority: auth.keypair, programId });
  const r = await runChainWorker(db, sender, { salt, limit });
  return { configured: true, ready: true, authority, ...r };
}
