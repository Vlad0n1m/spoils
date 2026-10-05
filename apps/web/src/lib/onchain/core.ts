import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { CORE_PROGRAM_ID } from "./config";

/**
 * Metaplex Core CreateV1 / CreateCollectionV1, hand-built like the rest of lib/onchain (the mpl-core
 * JS SDK does not load with this web3.js / @noble/hashes set). Layout from mpl-core 1.10's generated
 * serializers: u8 discriminator, Borsh strings (u32 length + UTF-8), plugins as Option<Vec<…>> =
 * Some([]). Absent optional accounts are passed as the Core program id. core.test.ts pins the bytes.
 */

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

/** Option<Vec<PluginAuthorityPair>> = Some(empty). */
const NO_PLUGINS = Buffer.from([1, 0, 0, 0, 0]);
const ro = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });

export function createV1Data(name: string, uri: string): Buffer {
  // discriminator 0, dataState 0 = AccountState
  return Buffer.concat([Buffer.from([0, 0]), borshString(name), borshString(uri), NO_PLUGINS]);
}

export function createCollectionV1Data(name: string, uri: string): Buffer {
  return Buffer.concat([Buffer.from([1]), borshString(name), borshString(uri), NO_PLUGINS]);
}

/** CreateV1 of one SPOILS item into the collection, owned by `owner`; the authority signs and pays. */
export function mintItemIxs(a: {
  authority: Keypair;
  collection: PublicKey;
  owner: PublicKey;
  name: string;
  uri: string;
}): { asset: Keypair; ixs: TransactionInstruction[] } {
  const asset = Keypair.generate();
  const ix = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: asset.publicKey, isSigner: true, isWritable: true },
      { pubkey: a.collection, isSigner: false, isWritable: true },
      { pubkey: a.authority.publicKey, isSigner: true, isWritable: false },
      { pubkey: a.authority.publicKey, isSigner: true, isWritable: true },
      ro(a.owner),
      ro(CORE_PROGRAM_ID), // update authority: None (the collection is the authority)
      ro(SystemProgram.programId),
      ro(CORE_PROGRAM_ID), // log wrapper: None
    ],
    data: createV1Data(a.name.slice(0, 32), a.uri),
  });
  return { asset, ixs: [ix] };
}

/** CreateCollectionV1 (one-time setup, programs/scripts/onchain-admin.ts). */
export function createCollectionIxs(a: { authority: Keypair; name: string; uri: string }): {
  collection: Keypair;
  ixs: TransactionInstruction[];
} {
  const collection = Keypair.generate();
  const ix = new TransactionInstruction({
    programId: CORE_PROGRAM_ID,
    keys: [
      { pubkey: collection.publicKey, isSigner: true, isWritable: true },
      ro(a.authority.publicKey),
      { pubkey: a.authority.publicKey, isSigner: true, isWritable: true },
      ro(SystemProgram.programId),
    ],
    data: createCollectionV1Data(a.name, a.uri),
  });
  return { collection, ixs: [ix] };
}
