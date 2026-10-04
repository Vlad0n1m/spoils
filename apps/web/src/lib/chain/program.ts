import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";

/**
 * Hand-built instructions of the spoils_events Anchor program (programs/spoils-events, IDL in
 * programs/idl/spoils_events.json): an 8-byte discriminator (sha256("global:<name>")[0..8]) and the
 * Borsh-encoded arguments (little-endian integers, fixed arrays as raw bytes). No Anchor client
 * dependency; program.test.ts checks every layout against the committed IDL.
 */

export const CONFIG_SEED = "config";
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function discriminator(namespace: "global" | "account" | "event", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];
}

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBuffer()], BPF_LOADER_UPGRADEABLE_ID)[0];
}

/** On-chain arguments of the three record instructions (hashes are 32 raw bytes). */
export type RecordArgs =
  | { kind: "match"; cycleId: bigint; shard: number; matchHash: Uint8Array; humans: number; mia: number }
  | { kind: "boss_kill"; cycleId: bigint; bossKind: number; killerHash: Uint8Array }
  | { kind: "rare_extract"; cycleId: bigint; itemDefHash: Uint8Array; rarity: number; ownerHash: Uint8Array };

const IX_NAME: Record<RecordArgs["kind"], string> = {
  match: "record_match",
  boss_kill: "record_boss_kill",
  rare_extract: "record_rare_extract",
};

/** Little-endian Borsh writer for the few types the program takes. */
class Writer {
  private parts: Buffer[] = [];
  u8(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 0xff) throw new RangeError(`u8 out of range: ${n}`);
    this.parts.push(Buffer.from([n]));
    return this;
  }
  u16(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(`u16 out of range: ${n}`);
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    this.parts.push(b);
    return this;
  }
  u64(n: bigint) {
    if (n < 0n || n > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${n}`);
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    this.parts.push(b);
    return this;
  }
  bytes32(a: Uint8Array) {
    if (a.length !== 32) throw new RangeError(`expected 32 bytes, got ${a.length}`);
    this.parts.push(Buffer.from(a));
    return this;
  }
  pubkey(k: PublicKey) {
    this.parts.push(k.toBuffer());
    return this;
  }
  raw(b: Buffer) {
    this.parts.push(b);
    return this;
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export function encodeRecordData(a: RecordArgs): Buffer {
  const w = new Writer().raw(discriminator("global", IX_NAME[a.kind])).u64(a.cycleId);
  switch (a.kind) {
    case "match":
      return w.u8(a.shard).bytes32(a.matchHash).u16(a.humans).u16(a.mia).done();
    case "boss_kill":
      return w.u8(a.bossKind).bytes32(a.killerHash).done();
    case "rare_extract":
      return w.bytes32(a.itemDefHash).u8(a.rarity).bytes32(a.ownerHash).done();
  }
}

/** record_* with accounts [config (writable), authority (signer, also the fee payer)]. */
export function recordIx(programId: PublicKey, authority: PublicKey, a: RecordArgs): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: encodeRecordData(a),
  });
}

/** One-time initialize, signed by the upgrade authority (payer). */
export function initializeIx(programId: PublicKey, payer: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: programDataAddress(programId), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: new Writer().raw(discriminator("global", "initialize")).pubkey(authority).done(),
  });
}

/** Rotate the record signer; signed by the current authority or the upgrade authority. */
export function setAuthorityIx(programId: PublicKey, signer: PublicKey, newAuthority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: signer, isSigner: true, isWritable: false },
      { pubkey: programId, isSigner: false, isWritable: false },
      { pubkey: programDataAddress(programId), isSigner: false, isWritable: false },
    ],
    data: new Writer().raw(discriminator("global", "set_authority")).pubkey(newAuthority).done(),
  });
}

/** Decoded Config account (8-byte discriminator, authority, three u64 counters, bump). */
export interface ConfigAccount {
  authority: PublicKey;
  matches: bigint;
  bossKills: bigint;
  rareExtracts: bigint;
  bump: number;
}

export function decodeConfig(data: Uint8Array): ConfigAccount | null {
  const b = Buffer.from(data);
  if (b.length < 8 + 32 + 24 + 1 || !b.subarray(0, 8).equals(discriminator("account", "Config"))) return null;
  return {
    authority: new PublicKey(b.subarray(8, 40)),
    matches: b.readBigUInt64LE(40),
    bossKills: b.readBigUInt64LE(48),
    rareExtracts: b.readBigUInt64LE(56),
    bump: b.readUInt8(64),
  };
}
