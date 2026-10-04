import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../db/schema";
import { configPda, decodeConfig, initializeIx, programDataAddress, setAuthorityIx, type ConfigAccount } from "./program";
import { requeueFailed } from "./queue";

/**
 * Operator helpers for programs/scripts/chain-admin.ts (devnet setup): never imported by the app.
 * Every transaction here is signed by a key the operator passes in; nothing reads env secrets.
 */

export interface ChainStatus {
  programId: string;
  programDeployed: boolean;
  programData: string;
  config: string;
  state: ConfigAccount | null;
}

export async function chainStatus(conn: Connection, programId: PublicKey): Promise<ChainStatus> {
  const [prog, cfg] = await conn.getMultipleAccountsInfo([programId, configPda(programId)]);
  return {
    programId: programId.toBase58(),
    programDeployed: !!prog?.executable,
    programData: programDataAddress(programId).toBase58(),
    config: configPda(programId).toBase58(),
    state: cfg ? decodeConfig(cfg.data) : null,
  };
}

/** initialize(authority), paid and signed by the program's upgrade authority. Returns the signature. */
export function initializeConfig(conn: Connection, upgradeAuthority: Keypair, programId: PublicKey, authority: PublicKey): Promise<string> {
  const tx = new Transaction().add(initializeIx(programId, upgradeAuthority.publicKey, authority));
  return sendAndConfirmTransaction(conn, tx, [upgradeAuthority], { commitment: "confirmed" });
}

/** set_authority(new), signed by the current authority or the upgrade authority. */
export function rotateAuthority(conn: Connection, signer: Keypair, programId: PublicKey, next: PublicKey): Promise<string> {
  const tx = new Transaction().add(setAuthorityIx(programId, signer.publicKey, next));
  return sendAndConfirmTransaction(conn, tx, [signer], { commitment: "confirmed" });
}

/** Devnet test SOL from one operator key to another (the record signer pays its own fees). */
export function topUp(conn: Connection, from: Keypair, to: PublicKey, sol: number): Promise<string> {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports }));
  return sendAndConfirmTransaction(conn, tx, [from], { commitment: "confirmed" });
}

export async function balanceSol(conn: Connection, key: PublicKey): Promise<number> {
  return (await conn.getBalance(key, "confirmed")) / LAMPORTS_PER_SOL;
}

/**
 * chain-admin requeue-failed: failed chain_events rows (all, or these ids) of the database at `url`
 * back in the queue. The URL is passed explicitly; the app's own pool is never used.
 */
export async function requeueFailedAt(url: string, ids: readonly number[] = []): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    return await requeueFailed(drizzle(pool, { schema }), ids.length ? { ids } : {});
  } finally {
    await pool.end();
  }
}
