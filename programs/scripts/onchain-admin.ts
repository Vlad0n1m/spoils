/**
 * Devnet operator script for on-chain items and the spoils_market program (README "On-chain").
 * Keys come from the gitignored programs/.keys/ folder; only public keys and signatures are printed.
 *
 *   T=apps/game-server/node_modules/.bin/tsx
 *   $T programs/scripts/onchain-admin.ts create-collection <origin>
 *        SPOILS Core collection owned by authority.json; prints the ONCHAIN_COLLECTION value
 *   $T programs/scripts/onchain-admin.ts init-market <collection> [fee_bps=500]
 *        initialize(collection, treasury = authority.json, fee) as the program's upgrade authority
 *   $T programs/scripts/onchain-admin.ts status [collection]
 *   $T programs/scripts/onchain-admin.ts smoke <collection>
 *        end-to-end on devnet with two throwaway wallets: mint → list → buy → list → cancel → into
 *        the game vault, checking the asset owner after every step
 *   $T programs/scripts/onchain-admin.ts e2e <collection>
 *        the web server's own code (lib/onchain/ops.ts) against devnet and the TEST database
 *        (extract_test): export → list → buy → import → kit, two throwaway player wallets
 * Options: --url <rpc> (default https://api.devnet.solana.com).
 */
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { explorerUrl, parseSecretKey } from "../../apps/web/src/lib/chain/config";
import { discriminator, programDataAddress } from "../../apps/web/src/lib/chain/program";
import { chainConnection } from "../../apps/web/src/lib/chain/sender";
import { createCollectionIxs, mintItemIxs } from "../../apps/web/src/lib/onchain/core";
import { eq, sql } from "drizzle-orm";
import { users } from "../../apps/web/src/db/schema";
import { closeTestDb, makeItem, makeUser, openTestDb } from "../../apps/web/src/lib/inventory/test-db";
import type { OnchainConfig } from "../../apps/web/src/lib/onchain/config";
import { exportItem, prepareOp, submitOp, type ChainDeps } from "../../apps/web/src/lib/onchain/ops";
import {
  buyIx,
  cancelIx,
  coreTransferIx,
  decodeCoreAsset,
  decodeMarket,
  listIx,
  marketPda,
} from "../../apps/web/src/lib/onchain/instructions";

const args = process.argv.slice(2);
const urlFlag = args.indexOf("--url");
const RPC = urlFlag >= 0 ? args[urlFlag + 1]! : "https://api.devnet.solana.com";
const [cmd, arg, arg2] = args.filter((_, i) => urlFlag < 0 || (i !== urlFlag && i !== urlFlag + 1));

function key(name: "deploy" | "authority" | "market-program") {
  const kp = parseSecretKey(readFileSync(new URL(`../.keys/${name}.json`, import.meta.url), "utf8"));
  if (!kp) throw new Error(`programs/.keys/${name}.json is not a keypair file`);
  return kp;
}

const conn = chainConnection(RPC, 30_000);
const program = () => key("market-program").publicKey;
const show = (sig: string) => `${sig}\n    ${explorerUrl("tx", sig)}`;

async function send(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const t = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed" });
}

async function createCollection() {
  const origin = (arg ?? "").replace(/\/$/, "");
  if (!/^https:\/\//.test(origin)) throw new Error("usage: create-collection https://spoils.gg");
  const auth = key("authority");
  const c = createCollectionIxs({ authority: auth, name: "SPOILS Items", uri: `${origin}/api/onchain/collection` });
  console.log(`create collection: ${show(await send(c.ixs, [auth, c.collection]))}`);
  console.log(`ONCHAIN_COLLECTION=${c.collection.publicKey.toBase58()}`);
  console.log(`    ${explorerUrl("address", c.collection.publicKey.toBase58())}`);
}

async function initMarket() {
  const collection = new PublicKey(arg ?? "");
  const fee = Number(arg2 ?? 500);
  const deploy = key("deploy");
  const p = program();
  if (await conn.getAccountInfo(marketPda(p))) return console.log(`already initialized: market ${marketPda(p).toBase58()}`);
  const data = Buffer.alloc(8 + 32 + 32 + 2);
  discriminator("global", "initialize").copy(data, 0);
  collection.toBuffer().copy(data, 8);
  key("authority").publicKey.toBuffer().copy(data, 40);
  data.writeUInt16LE(fee, 72);
  const ix = {
    programId: p,
    keys: [
      { pubkey: marketPda(p), isSigner: false, isWritable: true },
      { pubkey: deploy.publicKey, isSigner: true, isWritable: true },
      { pubkey: p, isSigner: false, isWritable: false },
      { pubkey: programDataAddress(p), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  };
  console.log(`initialize market: ${show(await send([ix as TransactionInstruction], [deploy]))}`);
}

async function status() {
  const p = program();
  const acc = await conn.getAccountInfo(marketPda(p));
  const m = acc ? decodeMarket(Buffer.from(acc.data)) : null;
  console.log(`program    ${p.toBase58()} deployed=${Boolean(await conn.getAccountInfo(p))}\n    ${explorerUrl("address", p.toBase58())}`);
  if (m) {
    console.log(`market     ${marketPda(p).toBase58()} collection=${m.collection.toBase58()} treasury=${m.treasury.toBase58()} fee=${m.feeBps}bps`);
    console.log(`  counters listed=${m.listed} sold=${m.sold} volume=${Number(m.volumeLamports) / 1e9} SOL`);
  } else console.log("market     not initialized");
  for (const k of ["deploy", "authority"] as const) {
    const pk = key(k).publicKey;
    console.log(`${k.padEnd(10)} ${pk.toBase58()} ${(await conn.getBalance(pk)) / 1e9} SOL`);
  }
}

async function ownerOf(asset: PublicKey): Promise<string> {
  const acc = await conn.getAccountInfo(asset, "confirmed");
  return acc ? (decodeCoreAsset(Buffer.from(acc.data))?.owner.toBase58() ?? "?") : "missing";
}

async function smoke() {
  if (!/devnet|localhost|127\.0\.0\.1/.test(RPC)) throw new Error("smoke is for devnet only");
  const collection = new PublicKey(arg ?? "");
  const auth = key("authority");
  const deploy = key("deploy");
  const p = program();
  const a = Keypair.generate();
  const b = Keypair.generate();
  const expect = async (asset: PublicKey, who: PublicKey, label: string) => {
    const o = await ownerOf(asset);
    if (o !== who.toBase58()) throw new Error(`${label}: owner ${o}, expected ${who.toBase58()}`);
    console.log(`  ✓ ${label}: owner ${o}`);
  };
  console.log(`fund A ${a.publicKey.toBase58()} and B ${b.publicKey.toBase58()}: ${show(
    await send(
      [
        SystemProgram.transfer({ fromPubkey: deploy.publicKey, toPubkey: a.publicKey, lamports: 30_000_000 }),
        SystemProgram.transfer({ fromPubkey: deploy.publicKey, toPubkey: b.publicKey, lamports: 60_000_000 }),
      ],
      [deploy],
    ),
  )}`);
  const m = mintItemIxs({ authority: auth, collection, owner: a.publicKey, name: "Smoke Epic Rifle", uri: "https://spoils.gg/api/onchain/meta/smoke" });
  const asset = m.asset.publicKey;
  console.log(`mint to A: ${show(await send(m.ixs, [auth, m.asset]))}`);
  await expect(asset, a.publicKey, "minted to A");
  console.log(`A lists for 0.02 SOL: ${show(await send([listIx({ program: p, asset, collection, seller: a.publicKey, priceLamports: 20_000_000n })], [a]))}`);
  await expect(asset, PublicKey.findProgramAddressSync([Buffer.from("listing"), asset.toBuffer()], p)[0], "in escrow");
  const aBefore = await conn.getBalance(a.publicKey);
  console.log(`B buys: ${show(await send([buyIx({ program: p, asset, collection, seller: a.publicKey, treasury: auth.publicKey, buyer: b.publicKey })], [b]))}`);
  await expect(asset, b.publicKey, "bought by B");
  console.log(`  ✓ A received ${(await conn.getBalance(a.publicKey)) - aBefore} lamports (0.019 SOL + listing rent back)`);
  console.log(`B lists: ${show(await send([listIx({ program: p, asset, collection, seller: b.publicKey, priceLamports: 50_000_000n })], [b]))}`);
  console.log(`B cancels: ${show(await send([cancelIx({ program: p, asset, collection, seller: b.publicKey })], [b]))}`);
  await expect(asset, b.publicKey, "back to B after cancel");
  console.log(`B sends it into the game vault: ${show(
    await send([coreTransferIx({ asset, collection, payer: b.publicKey, authority: b.publicKey, newOwner: auth.publicKey })], [b]),
  )}`);
  await expect(asset, auth.publicKey, "in the game vault");
  console.log(`vault sends it back out to A: ${show(
    await send([coreTransferIx({ asset, collection, payer: auth.publicKey, authority: auth.publicKey, newOwner: a.publicKey })], [auth]),
  )}`);
  await expect(asset, a.publicKey, "out of the vault to A");
  console.log(`asset ${explorerUrl("address", asset.toBase58())}`);
}

async function e2e() {
  if (!/devnet|localhost|127\.0\.0\.1/.test(RPC)) throw new Error("e2e is for devnet only");
  const collection = new PublicKey(arg ?? "");
  const auth = key("authority");
  const deploy = key("deploy");
  const cfg: OnchainConfig = {
    rpcUrl: RPC,
    cluster: "devnet",
    collection,
    marketProgram: program(),
    vault: auth.publicKey,
    treasury: auth.publicKey,
    minRarity: 2,
    kitLamports: 5_000_000n,
  };
  const deps: ChainDeps = { connection: conn, cfg, authority: auth, origin: "https://spoils.gg" };
  const { db, pool } = openTestDb();
  try {
    const a = Keypair.generate();
    const b = Keypair.generate();
    await send(
      [
        SystemProgram.transfer({ fromPubkey: deploy.publicKey, toPubkey: a.publicKey, lamports: 30_000_000 }),
        SystemProgram.transfer({ fromPubkey: deploy.publicKey, toPubkey: b.publicKey, lamports: 60_000_000 }),
      ],
      [deploy],
    );
    const ua = await makeUser(db);
    const ub = await makeUser(db);
    await db.update(users).set({ walletPubkey: a.publicKey.toBase58() }).where(eq(users.id, ua));
    await db.update(users).set({ walletPubkey: b.publicKey.toBase58() }).where(eq(users.id, ub));
    const item = await makeItem(db, { def: "rifle", rarity: 2, ownerId: ua });
    const sign = (txB64: string, kp: Keypair) => {
      const t = Transaction.from(Buffer.from(txB64, "base64"));
      t.partialSign(kp);
      return t.serialize().toString("base64");
    };
    const state = async () => (await db.execute<{ state: string; owner_id: string; chain_asset: string }>(sql`select state, owner_id, chain_asset from items where id = ${item}`)).rows[0]!;
    const step = async (label: string, r: { status: string; signature: string; error?: string }) => {
      if (r.status !== "done") throw new Error(`${label}: ${r.status} ${r.error ?? ""}`);
      console.log(`✓ ${label}: ${show(r.signature)}`);
    };

    await step("export (mint into A's wallet)", await exportItem(db, deps, ua, item));
    const asset = (await state()).chain_asset;
    if ((await ownerOf(new PublicKey(asset))) !== a.publicKey.toBase58()) throw new Error("asset not in A's wallet");
    let p = await prepareOp(db, deps, ua, "list", { asset, price: "0.01" });
    await step("A lists for 0.01 SOL", await submitOp(db, deps, ua, p.opId, sign(p.tx, a)));
    p = await prepareOp(db, deps, ub, "buy", { asset });
    await step("B buys", await submitOp(db, deps, ub, p.opId, sign(p.tx, b)));
    if ((await ownerOf(new PublicKey(asset))) !== b.publicKey.toBase58()) throw new Error("asset not in B's wallet");
    p = await prepareOp(db, deps, ub, "import", { asset });
    await step("B brings it into the game", await submitOp(db, deps, ub, p.opId, sign(p.tx, b)));
    const s = await state();
    if (s.state !== "in_stash" || s.owner_id !== ub) throw new Error(`item not in B's stash: ${JSON.stringify(s)}`);
    console.log("  ✓ item is in B's stash in the game");
    await step("B sends it out again (vault → wallet)", await exportItem(db, deps, ub, item));
    p = await prepareOp(db, deps, ub, "kit", {});
    await step("B pays 0.005 SOL for a starter kit", await submitOp(db, deps, ub, p.opId, sign(p.tx, b)));
    const kit = await db.execute<{ n: number }>(sql`select count(*)::int as n from items where owner_id = ${ub} and origin = 'giveaway'`);
    console.log(`  ✓ kit granted: ${kit.rows[0]!.n} items`);
    console.log(`asset ${explorerUrl("address", asset)}`);
  } finally {
    await closeTestDb(pool);
  }
}

const run: Record<string, () => Promise<void>> = {
  "create-collection": createCollection,
  "init-market": initMarket,
  status,
  smoke,
  e2e,
};
const f = cmd ? run[cmd] : undefined;
if (!f) {
  console.error("usage: onchain-admin.ts create-collection <origin> | init-market <collection> [fee_bps] | status | smoke <collection>");
  process.exit(2);
}
f().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
