/**
 * On-chain items and the SOL market: instruction layouts (against the committed spoils_market IDL)
 * and the prepare → sign → submit → effect flow against the isolated `extract_test` database with
 * a fake RPC. Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/onchain/onchain.test.ts
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { Keypair, PublicKey, Transaction, type Connection } from "@solana/web3.js";
import bs58 from "bs58";
import { STARTER_KIT } from "@extract/shared";
import { itemEvents, items, users } from "../../db/schema";
import { closeTestDb, lockTestDb, makeItem, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { discriminator } from "../chain/program";
import { CORE_PROGRAM_ID, type OnchainConfig } from "./config";
import { createCollectionV1Data, createV1Data } from "./core";
import {
  LISTING_SIZE,
  buyIx,
  cancelIx,
  coreTransferIx,
  decodeCoreAsset,
  decodeListing,
  listIx,
  listingPda,
  marketPda,
} from "./instructions";
import { OpError, exportItem, prepareOp, settlePendingOps, submitOp, type ChainDeps } from "./ops";
import { formatSol, parseSol } from "./sol";

const IDL = JSON.parse(readFileSync(new URL("../../../../../programs/idl/spoils_market.json", import.meta.url), "utf8")) as {
  instructions: Array<{ name: string; discriminator: number[]; accounts: Array<{ name: string; writable?: boolean; signer?: boolean }> }>;
};

// ------------------------------------------------------------------ pure layouts

test("market instructions match the IDL: discriminators, account order, writable and signer flags", () => {
  const program = Keypair.generate().publicKey;
  const asset = Keypair.generate().publicKey;
  const k = () => Keypair.generate().publicKey;
  const built = {
    list: listIx({ program, asset, collection: k(), seller: k(), priceLamports: 5n }),
    buy: buyIx({ program, asset, collection: k(), seller: k(), treasury: k(), buyer: k() }),
    cancel: cancelIx({ program, asset, collection: k(), seller: k() }),
  };
  for (const [name, ix] of Object.entries(built)) {
    const spec = IDL.instructions.find((i) => i.name === name)!;
    assert.deepEqual([...ix.data.subarray(0, 8)], spec.discriminator, name);
    assert.equal(ix.keys.length, spec.accounts.length, name);
    spec.accounts.forEach((a, i) => {
      assert.equal(ix.keys[i]!.isWritable, Boolean(a.writable), `${name}.${a.name} writable`);
      assert.equal(ix.keys[i]!.isSigner, Boolean(a.signer), `${name}.${a.name} signer`);
    });
    assert.ok(ix.keys[0]!.pubkey.equals(marketPda(program)));
    assert.ok(ix.keys[1]!.pubkey.equals(listingPda(program, asset)));
  }
  assert.equal(built.list.data.readBigUInt64LE(8), 5n, "price follows the discriminator");
});

test("Core layouts: TransferV1 = [14, 0]; CreateV1 / CreateCollectionV1 data is discriminator, strings, Some([])", () => {
  const t = coreTransferIx({ asset: Keypair.generate().publicKey, collection: Keypair.generate().publicKey, payer: Keypair.generate().publicKey, authority: Keypair.generate().publicKey, newOwner: Keypair.generate().publicKey });
  assert.ok(t.programId.equals(CORE_PROGRAM_ID));
  assert.deepEqual([...t.data], [14, 0]);
  assert.equal(t.keys.length, 7);
  assert.deepEqual([...createV1Data("ab", "u")], [0, 0, 2, 0, 0, 0, 97, 98, 1, 0, 0, 0, 117, 1, 0, 0, 0, 0]);
  assert.deepEqual([...createCollectionV1Data("a", "")], [1, 1, 0, 0, 0, 97, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
});

test("decoders read Core assets and listings", () => {
  const owner = Keypair.generate().publicKey;
  const col = Keypair.generate().publicKey;
  const name = Buffer.from("Epic Rifle");
  const uri = Buffer.from("https://x/m");
  const len = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32LE(b.length);
    return l;
  };
  const asset = Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([2]), col.toBuffer(), len(name), name, len(uri), uri, Buffer.from([0])]);
  const a = decodeCoreAsset(asset)!;
  assert.ok(a.owner.equals(owner) && a.collection!.equals(col));
  assert.equal(a.name, "Epic Rifle");
  assert.equal(a.uri, "https://x/m");
  assert.equal(decodeCoreAsset(Buffer.from([5, 1, 2])), null);

  const seller = Keypair.generate().publicKey;
  const l = Buffer.alloc(LISTING_SIZE);
  discriminator("account", "Listing").copy(l, 0);
  seller.toBuffer().copy(l, 8);
  col.toBuffer().copy(l, 40);
  l.writeBigUInt64LE(250_000_000n, 72);
  l.writeBigInt64LE(1_700_000_000n, 80);
  const d = decodeListing(l)!;
  assert.ok(d.seller.equals(seller));
  assert.equal(d.priceLamports, 250_000_000n);
  assert.equal(d.createdAt, 1_700_000_000);
});

test("SOL amounts parse and format", () => {
  assert.equal(parseSol("0.25"), 250_000_000n);
  assert.equal(parseSol("1"), 1_000_000_000n);
  assert.equal(parseSol("0,5"), 500_000_000n);
  assert.equal(parseSol("0"), null);
  assert.equal(parseSol("1.0000000001"), null);
  assert.equal(parseSol("abc"), null);
  assert.equal(formatSol(50_000_000n), "0.05 SOL");
  assert.equal(formatSol(2_000_000_000n), "2 SOL");
});

// ------------------------------------------------------------------ flow against the test DB

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

/** In-memory RPC: accounts by address, transactions land unless `fail` says otherwise. */
class FakeConn {
  accounts = new Map<string, Buffer>();
  sent: Transaction[] = [];
  statuses = new Map<string, { err: unknown; confirmationStatus: string } | null>();
  mode: "land" | "fail" | "silent" = "land";
  height = 100;
  async getLatestBlockhash() {
    return { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 150 };
  }
  async sendRawTransaction(raw: Buffer) {
    const tx = Transaction.from(raw);
    this.sent.push(tx);
    const sig = bs58.encode(tx.signature!);
    if (this.mode === "fail") throw new Error("Simulation failed: custom program error: 0x1771");
    if (this.mode === "land") this.statuses.set(sig, { err: null, confirmationStatus: "confirmed" });
    return sig;
  }
  async getSignatureStatuses(sigs: string[]) {
    return { value: sigs.map((s) => this.statuses.get(s) ?? null) };
  }
  async getBlockHeight() {
    return this.height;
  }
  async getAccountInfo(k: PublicKey) {
    const d = this.accounts.get(k.toBase58());
    return d ? { data: d } : null;
  }
}

const authority = Keypair.generate();
const collection = Keypair.generate().publicKey;
const program = Keypair.generate().publicKey;
const cfg: OnchainConfig = {
  rpcUrl: "fake",
  cluster: "devnet",
  collection,
  marketProgram: program,
  vault: authority.publicKey,
  treasury: authority.publicKey,
  minRarity: 2,
  kitLamports: 50_000_000n,
};

function deps(conn: FakeConn): ChainDeps {
  return { connection: conn as unknown as Connection, cfg, authority, origin: "https://spoils.test" };
}

function assetBytes(owner: PublicKey): Buffer {
  return Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([2]), collection.toBuffer(), Buffer.alloc(8)]);
}

async function playerWithWallet() {
  const userId = await makeUser(db);
  const wallet = Keypair.generate();
  await db.update(users).set({ walletPubkey: wallet.publicKey.toBase58() }).where(eq(users.id, userId));
  return { userId, wallet };
}

const signB64 = (b64: string, kp: Keypair) => {
  const t = Transaction.from(Buffer.from(b64, "base64"));
  t.partialSign(kp);
  return t.serialize().toString("base64");
};

async function itemState(id: string) {
  const [r] = await db.select().from(items).where(eq(items.id, id));
  return r!;
}

test("export: epic item → minted to the linked wallet, item 'onchain' with its asset; common items and bound items refused", async () => {
  const conn = new FakeConn();
  const { userId, wallet } = await playerWithWallet();
  const epic = await makeItem(db, { def: "rifle", rarity: 2, ownerId: userId });
  const r = await exportItem(db, deps(conn), userId, epic);
  assert.equal(r.status, "done");
  const it = await itemState(epic);
  assert.equal(it.state, "onchain");
  assert.ok(it.chainAsset);
  const tx = conn.sent[0]!;
  assert.ok(tx.instructions[0]!.programId.equals(CORE_PROGRAM_ID));
  assert.equal(tx.instructions[0]!.data[0], 0, "CreateV1");
  assert.ok(tx.instructions[0]!.keys[4]!.pubkey.equals(wallet.publicKey), "owner = linked wallet");
  assert.ok(tx.instructions[0]!.keys[0]!.pubkey.equals(new PublicKey(it.chainAsset!)));

  const common = await makeItem(db, { def: "pistol", rarity: 0, ownerId: userId });
  await assert.rejects(exportItem(db, deps(conn), userId, common), (e) => e instanceof OpError && e.code === "not_eligible");
  const bound = await makeItem(db, { def: "rifle", rarity: 3, ownerId: userId, bound: true });
  await assert.rejects(exportItem(db, deps(conn), userId, bound), (e) => e instanceof OpError && e.code === "not_eligible");
  const other = await makeUser(db);
  await assert.rejects(exportItem(db, deps(conn), other, epic), (e) => e instanceof OpError && e.code === "no_wallet");
});

test("export that never lands: item returns to the stash and forgets the never-minted asset", async () => {
  const conn = new FakeConn();
  conn.mode = "silent";
  const { userId } = await playerWithWallet();
  const epic = await makeItem(db, { def: "rifle", rarity: 3, ownerId: userId });
  const r = await exportItem(db, { ...deps(conn), confirmTimeoutMs: 1_500 }, userId, epic);
  assert.equal(r.status, "sent");
  assert.equal((await itemState(epic)).state, "onchain");
  await db.execute(sql`update onchain_ops set created_at = now() - interval '5 minutes'`);
  conn.height = 151;
  assert.equal(await settlePendingOps(db, conn as unknown as Connection, userId), 1);
  const it = await itemState(epic);
  assert.equal(it.state, "in_stash");
  assert.equal(it.chainAsset, null);
});

test("import: wallet signs a transfer into the vault; the server accepts only its own message, then the item is back in the stash of the importer", async () => {
  const conn = new FakeConn();
  const seller = await playerWithWallet();
  const epic = await makeItem(db, { def: "shotgun", rarity: 2, ownerId: seller.userId });
  await exportItem(db, deps(conn), seller.userId, epic);
  const asset = (await itemState(epic)).chainAsset!;

  // Another player bought it on the SOL market: it is in their wallet now.
  const buyer = await playerWithWallet();
  conn.accounts.set(asset, assetBytes(buyer.wallet.publicKey));
  await assert.rejects(prepareOp(db, deps(conn), seller.userId, "import", { asset }), (e) => e instanceof OpError && e.code === "not_owner");

  const p = await prepareOp(db, deps(conn), buyer.userId, "import", { asset });
  // A tampered transaction (other recipient) is refused even when properly signed.
  const evil = Transaction.from(Buffer.from(p.tx, "base64"));
  evil.instructions[0]!.keys[4]!.pubkey = buyer.wallet.publicKey;
  evil.partialSign(buyer.wallet);
  await assert.rejects(submitOp(db, deps(conn), buyer.userId, p.opId, evil.serialize().toString("base64")), (e) => e instanceof OpError && e.code === "bad_signature");
  // Unsigned is refused too.
  await assert.rejects(submitOp(db, deps(conn), buyer.userId, p.opId, p.tx), (e) => e instanceof OpError && e.code === "bad_signature");

  const r = await submitOp(db, deps(conn), buyer.userId, p.opId, signB64(p.tx, buyer.wallet));
  assert.equal(r.status, "done");
  const it = await itemState(epic);
  assert.equal(it.state, "in_stash");
  assert.equal(it.ownerId, buyer.userId);
  assert.equal(it.chainAsset, asset, "the asset is kept for the next send");
  const ix = conn.sent.at(-1)!.instructions[0]!;
  assert.ok(ix.keys[4]!.pubkey.equals(authority.publicKey), "new owner = the game vault");
  // Submitting twice does nothing.
  await assert.rejects(submitOp(db, deps(conn), buyer.userId, p.opId, signB64(p.tx, buyer.wallet)), (e) => e instanceof OpError && e.code === "gone");
  const ev = await db.select().from(itemEvents).where(eq(itemEvents.itemId, epic));
  assert.deepEqual(ev.map((e) => e.reason), ["export", "import"]);

  // Sending it out again moves the existing asset out of the vault instead of minting.
  await exportItem(db, deps(conn), buyer.userId, epic);
  const again = conn.sent.at(-1)!.instructions[0]!;
  assert.deepEqual([...again.data], [14, 0]);
  assert.ok(again.keys[4]!.pubkey.equals(buyer.wallet.publicKey));
});

test("kit: SOL transfer to the treasury with a memo; the kit is granted once, after confirmation", async () => {
  const conn = new FakeConn();
  const { userId, wallet } = await playerWithWallet();
  const p = await prepareOp(db, deps(conn), userId, "kit", {});
  const t = Transaction.from(Buffer.from(p.tx, "base64"));
  assert.ok(t.feePayer!.equals(wallet.publicKey));
  assert.equal(t.instructions[0]!.data.readBigUInt64LE(4), 50_000_000n, "0.05 SOL");
  assert.ok(t.instructions[0]!.keys[1]!.pubkey.equals(authority.publicKey), "to the treasury");
  assert.equal(t.instructions[1]!.data.toString(), `spoils:kit:${p.opId}`);
  const before = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${userId}`);
  assert.equal(before.rows[0]!.n, 0);
  const r = await submitOp(db, deps(conn), userId, p.opId, signB64(p.tx, wallet));
  assert.equal(r.status, "done");
  const after = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${userId}`);
  assert.equal(after.rows[0]!.n, STARTER_KIT.weapons.length + 1);
});

test("kit: a transaction Solana refuses grants nothing", async () => {
  const conn = new FakeConn();
  conn.mode = "fail";
  const { userId, wallet } = await playerWithWallet();
  const p = await prepareOp(db, deps(conn), userId, "kit", {});
  const r = await submitOp(db, deps(conn), userId, p.opId, signB64(p.tx, wallet));
  assert.equal(r.status, "failed");
  const n = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${userId}`);
  assert.equal(n.rows[0]!.n, 0);
});

test("market prepare: list needs the asset in the wallet and a price; buy refuses your own lot; cancel only by the seller", async () => {
  const conn = new FakeConn();
  const a = await playerWithWallet();
  const b = await playerWithWallet();
  const epic = await makeItem(db, { def: "rifle", rarity: 2, ownerId: a.userId });
  await exportItem(db, deps(conn), a.userId, epic);
  const asset = (await itemState(epic)).chainAsset!;
  conn.accounts.set(asset, assetBytes(a.wallet.publicKey));
  await assert.rejects(prepareOp(db, deps(conn), a.userId, "list", { asset, price: "0" }), (e) => e instanceof OpError && e.code === "bad_price");
  await assert.rejects(prepareOp(db, deps(conn), b.userId, "list", { asset, price: "1" }), (e) => e instanceof OpError && e.code === "not_owner");
  const p = await prepareOp(db, deps(conn), a.userId, "list", { asset, price: "0.25" });
  const ix = Transaction.from(Buffer.from(p.tx, "base64")).instructions[0]!;
  assert.ok(ix.programId.equals(program));
  assert.equal(ix.data.readBigUInt64LE(8), 250_000_000n);

  // The listing exists on chain now.
  const l = Buffer.alloc(LISTING_SIZE);
  discriminator("account", "Listing").copy(l, 0);
  a.wallet.publicKey.toBuffer().copy(l, 8);
  new PublicKey(asset).toBuffer().copy(l, 40);
  l.writeBigUInt64LE(250_000_000n, 72);
  conn.accounts.set(listingPda(program, new PublicKey(asset)).toBase58(), l);
  await assert.rejects(prepareOp(db, deps(conn), a.userId, "buy", { asset }), (e) => e instanceof OpError && e.code === "own_listing");
  const buy = await prepareOp(db, deps(conn), b.userId, "buy", { asset });
  const bix = Transaction.from(Buffer.from(buy.tx, "base64")).instructions[0]!;
  assert.ok(bix.keys[4]!.pubkey.equals(a.wallet.publicKey), "seller from the listing");
  assert.ok(bix.keys[5]!.pubkey.equals(authority.publicKey), "treasury from the config");
  assert.ok(bix.keys[6]!.pubkey.equals(b.wallet.publicKey), "buyer");
  await assert.rejects(prepareOp(db, deps(conn), b.userId, "cancel", { asset }), (e) => e instanceof OpError && e.code === "not_owner");
  await prepareOp(db, deps(conn), a.userId, "cancel", { asset });
  // Assets the game never minted are refused.
  await assert.rejects(prepareOp(db, deps(conn), b.userId, "buy", { asset: Keypair.generate().publicKey.toBase58() }), (e) => e instanceof OpError && e.code === "not_spoils");
});
