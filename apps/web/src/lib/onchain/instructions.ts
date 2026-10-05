import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { discriminator } from "../chain/program";
import { CORE_PROGRAM_ID, MEMO_PROGRAM_ID } from "./config";

/**
 * Hand-built instructions of spoils_market (programs/spoils-market) and Metaplex Core TransferV1,
 * in the style of lib/chain/program.ts: Anchor discriminator + Borsh arguments, no client SDK.
 * instructions.test.ts pins the layouts against the program's IDL and Core's own serializer.
 */

export const MARKET_SEED = "market";
export const LISTING_SEED = "listing";
/** Core TransferV1: discriminator 14, compression_proof = None. */
const CORE_TRANSFER_V1 = Buffer.from([14, 0]);

export function marketPda(program: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED)], program)[0];
}

export function listingPda(program: PublicKey, asset: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(LISTING_SEED), asset.toBuffer()], program)[0];
}

function u64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

/** Core TransferV1 (asset, collection, payer, authority, new owner, system program; no log wrapper). */
export function coreTransferIx(a: {
  asset: PublicKey;
  collection: PublicKey;
  payer: PublicKey;
  authority: PublicKey;
  newOwner: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: a.asset, isSigner: false, isWritable: true },
      { pubkey: a.collection, isSigner: false, isWritable: false },
      { pubkey: a.payer, isSigner: true, isWritable: true },
      { pubkey: a.authority, isSigner: true, isWritable: false },
      { pubkey: a.newOwner, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CORE_TRANSFER_V1,
  });
}

export function listIx(a: { program: PublicKey; asset: PublicKey; collection: PublicKey; seller: PublicKey; priceLamports: bigint }) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      { pubkey: marketPda(a.program), isSigner: false, isWritable: true },
      { pubkey: listingPda(a.program, a.asset), isSigner: false, isWritable: true },
      { pubkey: a.asset, isSigner: false, isWritable: true },
      { pubkey: a.collection, isSigner: false, isWritable: false },
      { pubkey: a.seller, isSigner: true, isWritable: true },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([discriminator("global", "list"), u64(a.priceLamports)]),
  });
}

export function buyIx(a: {
  program: PublicKey;
  asset: PublicKey;
  collection: PublicKey;
  seller: PublicKey;
  treasury: PublicKey;
  buyer: PublicKey;
}) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      { pubkey: marketPda(a.program), isSigner: false, isWritable: true },
      { pubkey: listingPda(a.program, a.asset), isSigner: false, isWritable: true },
      { pubkey: a.asset, isSigner: false, isWritable: true },
      { pubkey: a.collection, isSigner: false, isWritable: false },
      { pubkey: a.seller, isSigner: false, isWritable: true },
      { pubkey: a.treasury, isSigner: false, isWritable: true },
      { pubkey: a.buyer, isSigner: true, isWritable: true },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator("global", "buy"),
  });
}

export function cancelIx(a: { program: PublicKey; asset: PublicKey; collection: PublicKey; seller: PublicKey }) {
  return new TransactionInstruction({
    programId: a.program,
    keys: [
      { pubkey: marketPda(a.program), isSigner: false, isWritable: false },
      { pubkey: listingPda(a.program, a.asset), isSigner: false, isWritable: true },
      { pubkey: a.asset, isSigner: false, isWritable: true },
      { pubkey: a.collection, isSigner: false, isWritable: false },
      { pubkey: a.seller, isSigner: true, isWritable: true },
      { pubkey: CORE_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator("global", "cancel"),
  });
}

export function memoIx(text: string): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, keys: [], data: Buffer.from(text, "utf8") });
}

// ------------------------------------------------------------------ account decoders

export interface CoreAssetInfo {
  owner: PublicKey;
  /** Collection address when the update authority is a collection, else null. */
  collection: PublicKey | null;
  name: string;
  uri: string;
}

/** Core AssetV1: key u8 (1) | owner [32] | update authority (tag u8, 2 = Collection + [32]) | name | uri | … */
export function decodeCoreAsset(data: Buffer): CoreAssetInfo | null {
  if (data.length < 34 || data[0] !== 1) return null;
  const owner = new PublicKey(data.subarray(1, 33));
  const tag = data[33];
  let o = 34;
  let collection: PublicKey | null = null;
  if (tag === 1 || tag === 2) {
    if (data.length < o + 32) return null;
    if (tag === 2) collection = new PublicKey(data.subarray(o, o + 32));
    o += 32;
  }
  const str = (): string | null => {
    if (data.length < o + 4) return null;
    const n = data.readUInt32LE(o);
    if (data.length < o + 4 + n) return null;
    const s = data.subarray(o + 4, o + 4 + n).toString("utf8");
    o += 4 + n;
    return s;
  };
  const name = str();
  const uri = str();
  if (name === null || uri === null) return null;
  return { owner, collection, name, uri };
}

export interface ListingInfo {
  seller: PublicKey;
  asset: PublicKey;
  priceLamports: bigint;
  createdAt: number;
}

/** Number of bytes of a Listing account (discriminator + seller + asset + price + created_at + bump). */
export const LISTING_SIZE = 8 + 32 + 32 + 8 + 8 + 1;

export function decodeListing(data: Buffer): ListingInfo | null {
  if (data.length < LISTING_SIZE || !data.subarray(0, 8).equals(discriminator("account", "Listing"))) return null;
  return {
    seller: new PublicKey(data.subarray(8, 40)),
    asset: new PublicKey(data.subarray(40, 72)),
    priceLamports: data.readBigUInt64LE(72),
    createdAt: Number(data.readBigInt64LE(80)),
  };
}

export interface MarketInfo {
  admin: PublicKey;
  collection: PublicKey;
  treasury: PublicKey;
  feeBps: number;
  listed: bigint;
  sold: bigint;
  volumeLamports: bigint;
}

export function decodeMarket(data: Buffer): MarketInfo | null {
  if (data.length < 8 + 96 + 2 + 24 || !data.subarray(0, 8).equals(discriminator("account", "Market"))) return null;
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    collection: new PublicKey(data.subarray(40, 72)),
    treasury: new PublicKey(data.subarray(72, 104)),
    feeBps: data.readUInt16LE(104),
    listed: data.readBigUInt64LE(106),
    sold: data.readBigUInt64LE(114),
    volumeLamports: data.readBigUInt64LE(122),
  };
}
