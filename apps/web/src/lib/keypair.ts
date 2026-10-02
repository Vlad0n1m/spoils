import { createHash, createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";

export function deriveDepositKeypair(userId: string): Keypair {
  const master = process.env.MASTER_SEED_HEX?.trim();
  if (master && master.length >= 32) {
    const seed = Buffer.from(master, "hex");
    if (seed.length < 32) {
      throw new Error("MASTER_SEED_HEX must decode to at least 32 bytes");
    }
    const hmac = createHmac("sha512", seed).update(userId).digest();
    return Keypair.fromSeed(hmac.subarray(0, 32));
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MASTER_SEED_HEX is required in production for per-user deposit keys",
    );
  }
  const h = createHash("sha256")
    .update("extract-dev-deposit-v1")
    .update(userId)
    .digest();
  return Keypair.fromSeed(h.subarray(0, 32));
}

export function deriveDepositPubkey(userId: string): string {
  return deriveDepositKeypair(userId).publicKey.toBase58();
}
