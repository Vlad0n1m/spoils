import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  type Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { STARTER_KIT } from "@extract/shared";
import { onchainOps } from "../../db/schema";
import type { Db, Tx } from "../inventory/db";
import { applyMove, isUuid, lockItem } from "../inventory/transition";
import { grantStarterKit, kitsBoughtToday } from "../inventory/starter";
import { PARAM, pausedParam } from "../economy/params";
import type { OnchainConfig } from "./config";
import { mintItemIxs } from "./core";
import { buyIx, cancelIx, coreTransferIx, decodeCoreAsset, decodeListing, listIx, listingPda, memoIx } from "./instructions";
import { parseSol } from "./sol";

/**
 * Every on-chain action of a player, in two steps that never trust the client:
 *
 *   prepare  the server checks the game rules, builds the transaction (fee payer = the player's
 *            linked wallet, a fresh blockhash) and stores its message in onchain_ops;
 *   submit   the client returns it signed by the wallet; the server accepts it only if the
 *            message is byte-for-byte the one it built and every signature verifies, sends it,
 *            waits for confirmation and only then applies the game effect, once.
 *
 * `export` is the exception: the server alone signs and pays (mint into the player's wallet, or a
 * transfer out of the game vault). Ops still unconfirmed when the request ends stay `sent` and are
 * settled later by settlePendingOps (signature landed → done, blockhash expired → expired).
 */

export type OnchainAction = "export" | "import" | "kit" | "list" | "buy" | "cancel";

export type OpErr =
  | "no_wallet"
  | "not_found"
  | "not_eligible"
  | "not_owner"
  | "not_spoils"
  | "not_listed"
  | "own_listing"
  | "bad_price"
  | "daily_limit"
  | "sale_paused"
  | "bad_signature"
  | "gone"
  | "chain_error";

export class OpError extends Error {
  constructor(readonly code: OpErr, message?: string) {
    super(message ?? code);
  }
}

export interface ChainDeps {
  connection: Connection;
  cfg: OnchainConfig;
  authority: Keypair;
  /** Public origin for metadata URIs (https://spoils.gg). */
  origin: string;
  now?: () => Date;
  /** How long a request waits for confirmation before leaving the op `sent` (default 25 s). */
  confirmTimeoutMs?: number;
}

const CONFIRM_TIMEOUT_MS = 25_000;
const POLL_MS = 900;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function walletOf(db: Db | Tx, userId: string): Promise<PublicKey> {
  const r = await db.execute<{ wallet_pubkey: string | null }>(sql`select wallet_pubkey from users where id = ${userId}`);
  const w = r.rows[0]?.wallet_pubkey;
  if (!w) throw new OpError("no_wallet", "Link a Solana wallet first.");
  return new PublicKey(w);
}

async function freshTx(conn: Connection, feePayer: PublicKey, ixs: TransactionInstruction[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(...ixs);
  return { tx, lastValidBlockHeight };
}

async function assetInfo(conn: Connection, asset: PublicKey) {
  const acc = await conn.getAccountInfo(asset, "confirmed");
  return acc ? decodeCoreAsset(Buffer.from(acc.data)) : null;
}

function itemName(def: string, rarity: number): string {
  const r = ["Common", "Rare", "Epic", "Legendary"][Math.max(0, Math.min(3, rarity))];
  const d = def.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${r} ${d}`.slice(0, 32);
}

// ------------------------------------------------------------------ export (server-signed)

/**
 * Sends a stash item to the player's linked wallet. First time: a new Core asset is minted into the
 * SPOILS collection; an item that was in a wallet before: its asset leaves the game vault. The
 * item turns `onchain` in the same DB transaction that records the signed transaction, so a crash
 * between the two cannot lose it; a transaction that never lands puts it back (settlePendingOps).
 */
export async function exportItem(db: Db, deps: ChainDeps, userId: string, itemId: string) {
  if (!isUuid(itemId)) throw new OpError("not_found", "That item is not in your stash.");
  const wallet = await walletOf(db, userId);
  const { cfg, connection: conn, authority } = deps;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");

  const op = await db.transaction(async (tx) => {
    const it = await lockItem(tx, itemId);
    if (!it || it.ownerId !== userId || it.state !== "in_stash") throw new OpError("not_found", "That item is not in your stash.");
    if (it.bound || it.lockRaids > 0 || it.durability <= 0 || it.rarity < cfg.minRarity) {
      throw new OpError("not_eligible", "Only tradable epic and legendary items in good repair can go on chain.");
    }
    const row = await tx.execute<{ chain_asset: string | null }>(sql`select chain_asset from items where id = ${itemId}`);
    const existing = row.rows[0]?.chain_asset ?? null;
    const t = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight });
    let asset: string;
    if (existing) {
      asset = existing;
      t.add(coreTransferIx({ asset: new PublicKey(existing), collection: cfg.collection, payer: authority.publicKey, authority: cfg.vault, newOwner: wallet }));
      t.sign(authority);
    } else {
      const m = mintItemIxs({
        authority,
        collection: cfg.collection,
        owner: wallet,
        name: itemName(it.defId, it.rarity),
        uri: `${deps.origin}/api/onchain/meta/${itemId}`,
      });
      asset = m.asset.publicKey.toBase58();
      t.add(...m.ixs);
      t.sign(authority, m.asset);
    }
    const signature = bs58.encode(t.signature!);
    const opId = randomUUID();
    await tx.execute(sql`update items set chain_asset = ${asset} where id = ${itemId}`);
    await applyMove(tx, it, { state: "onchain" }, { reason: "export", refId: opId });
    await tx.insert(onchainOps).values({
      id: opId,
      userId,
      wallet: wallet.toBase58(),
      action: "export",
      itemId,
      asset,
      message: t.serializeMessage().toString("base64"),
      status: "sent",
      signature,
      signedTx: t.serialize().toString("base64"),
      lastValidBlockHeight,
      // A fresh mint is reverted by clearing chain_asset; a vault transfer keeps it.
      error: existing ? null : "fresh_mint",
    });
    return { id: opId, signature, signedTx: t.serialize(), asset, fresh: !existing };
  });

  return sendAndSettle(db, deps, op.id, op.signedTx, op.signature);
}

// ------------------------------------------------------------------ prepare (player-signed)

export interface Prepared {
  opId: string;
  /** Unsigned transaction (base64) for the wallet to sign. */
  tx: string;
}

export async function prepareOp(
  db: Db,
  deps: ChainDeps,
  userId: string,
  action: Exclude<OnchainAction, "export">,
  p: { asset?: string; price?: string },
): Promise<Prepared> {
  const { cfg, connection: conn } = deps;
  const wallet = await walletOf(db, userId);
  let ixs: TransactionInstruction[] = [];
  let itemId: string | null = null;
  let lamports: bigint | null = null;
  const opId = randomUUID();
  const asset = p.asset ? safeKey(p.asset) : null;

  if (action === "kit") {
    if (await pausedParam(db, PARAM.KIT_SALE_PAUSED)) throw new OpError("sale_paused", "Starter kit sales are paused for a moment.");
    if ((await kitsBoughtToday(db, userId, deps.now?.() ?? new Date())) >= STARTER_KIT.DAILY_MAX) {
      throw new OpError("daily_limit", `You can buy up to ${STARTER_KIT.DAILY_MAX} starter kits a day.`);
    }
    lamports = cfg.kitLamports;
    ixs = [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: cfg.treasury, lamports }), memoIx(`spoils:kit:${opId}`)];
  } else {
    if (!asset) throw new OpError("not_found", "Unknown item.");
    const r = await db.execute<{ id: string }>(sql`select id from items where chain_asset = ${asset.toBase58()} and state = 'onchain'`);
    itemId = r.rows[0]?.id ?? null;
    if (!itemId) throw new OpError("not_spoils", "That is not a SPOILS item.");

    if (action === "import" || action === "list") {
      const info = await assetInfo(conn, asset);
      if (!info || !info.collection?.equals(cfg.collection)) throw new OpError("not_spoils", "That is not a SPOILS item.");
      if (!info.owner.equals(wallet)) throw new OpError("not_owner", "That item is not in your wallet.");
      if (action === "import") {
        ixs = [coreTransferIx({ asset, collection: cfg.collection, payer: wallet, authority: wallet, newOwner: cfg.vault })];
      } else {
        lamports = p.price ? parseSol(p.price) : null;
        if (!lamports) throw new OpError("bad_price", "Enter a price in SOL, like 0.25.");
        ixs = [listIx({ program: cfg.marketProgram, asset, collection: cfg.collection, seller: wallet, priceLamports: lamports })];
      }
    } else {
      const acc = await conn.getAccountInfo(listingPda(cfg.marketProgram, asset), "confirmed");
      const l = acc ? decodeListing(Buffer.from(acc.data)) : null;
      if (!l) throw new OpError("not_listed", "That lot is gone.");
      if (action === "buy") {
        if (l.seller.equals(wallet)) throw new OpError("own_listing", "That's your own lot.");
        lamports = l.priceLamports;
        ixs = [buyIx({ program: cfg.marketProgram, asset, collection: cfg.collection, seller: l.seller, treasury: cfg.treasury, buyer: wallet })];
      } else {
        if (!l.seller.equals(wallet)) throw new OpError("not_owner", "That lot is not yours.");
        ixs = [cancelIx({ program: cfg.marketProgram, asset, collection: cfg.collection, seller: wallet })];
      }
    }
  }

  const { tx, lastValidBlockHeight } = await freshTx(conn, wallet, ixs);
  await db.insert(onchainOps).values({
    id: opId,
    userId,
    wallet: wallet.toBase58(),
    action,
    itemId,
    asset: asset?.toBase58() ?? null,
    lamports: lamports?.toString() ?? null,
    message: tx.serializeMessage().toString("base64"),
    lastValidBlockHeight,
  });
  return { opId, tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") };
}

function safeKey(s: string): PublicKey | null {
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ submit

export type OpResult = { opId: string; status: "done" | "sent" | "failed" | "expired"; signature: string; error?: string };

/** Accepts the wallet-signed transaction of a prepared op, sends it and settles it. */
export async function submitOp(db: Db, deps: ChainDeps, userId: string, opId: string, signedB64: string): Promise<OpResult> {
  if (!isUuid(opId)) throw new OpError("not_found", "Unknown operation.");
  const r = await db.execute<{ user_id: string; status: string; message: string }>(
    sql`select user_id, status, message from onchain_ops where id = ${opId}`,
  );
  const op = r.rows[0];
  if (!op || op.user_id !== userId) throw new OpError("not_found", "Unknown operation.");
  if (op.status !== "prepared") throw new OpError("gone", "This operation was already sent.");

  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(signedB64, "base64"));
  } catch {
    throw new OpError("bad_signature", "The wallet returned an unreadable transaction.");
  }
  if (!tx.serializeMessage().equals(Buffer.from(op.message, "base64"))) {
    throw new OpError("bad_signature", "The signed transaction does not match the one the game prepared.");
  }
  if (!tx.signature || !tx.verifySignatures()) throw new OpError("bad_signature", "The wallet signature is missing or invalid.");
  const signature = bs58.encode(tx.signature);
  const raw = tx.serialize();
  const claimed = await db.execute(
    sql`update onchain_ops set status = 'sent', signature = ${signature}, signed_tx = ${raw.toString("base64")}
        where id = ${opId} and status = 'prepared'`,
  );
  if ((claimed.rowCount ?? 0) === 0) throw new OpError("gone", "This operation was already sent.");
  return sendAndSettle(db, deps, opId, raw, signature);
}

async function sendAndSettle(db: Db, deps: ChainDeps, opId: string, raw: Buffer, signature: string): Promise<OpResult> {
  const conn = deps.connection;
  try {
    await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Simulation failed: the transaction can never land as built.
    if (!/already been processed/i.test(msg)) {
      await finish(db, opId, "failed", shortError(msg));
      return { opId, status: "failed", signature, error: shortError(msg) };
    }
  }
  const deadline = Date.now() + (deps.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const s = await conn.getSignatureStatuses([signature]).catch(() => null);
    const st = s?.value[0];
    if (st?.err) {
      const err = JSON.stringify(st.err);
      await finish(db, opId, "failed", err);
      return { opId, status: "failed", signature, error: err };
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      await finish(db, opId, "done");
      return { opId, status: "done", signature };
    }
    await sleep(POLL_MS);
    try {
      await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
    } catch {
      // a resend is best effort
    }
  }
  return { opId, status: "sent", signature };
}

function shortError(m: string): string {
  if (/no record of a prior credit|insufficient (funds|lamports)/i.test(m)) return "not enough SOL to pay for it";
  if (/blockhash not found/i.test(m)) return "the transaction expired, try again";
  const custom = /custom program error: (0x[0-9a-f]+)/i.exec(m);
  return (custom ? `program error ${custom[1]}` : m).slice(0, 300);
}

/**
 * Final state of an op, with its game effect in the same DB transaction (exactly once: the status
 * guard lets one caller through). done: import → item back in the importer's stash; kit → kit
 * granted. failed / expired: export → item back in the stash (a fresh mint also forgets its asset).
 */
export async function finish(db: Db, opId: string, status: "done" | "failed" | "expired", error?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.execute<{ user_id: string; action: OnchainAction; item_id: string | null; asset: string | null; error: string | null }>(
      // An export keeps its "fresh_mint" marker in front of any error (read back below).
      sql`update onchain_ops set status = ${status}, done_at = now(),
            error = case when ${error ?? null}::text is null then error
                         when error like 'fresh_mint%' then 'fresh_mint: ' || ${error ?? null}::text
                         else ${error ?? null}::text end
          where id = ${opId} and status = 'sent'
          returning user_id, action, item_id, asset, error`,
    );
    const op = r.rows[0];
    if (!op) return;
    if (status === "done") {
      if (op.action === "import" && op.item_id) {
        const it = await lockItem(tx, op.item_id);
        if (it && it.state === "onchain") {
          await applyMove(tx, it, { state: "in_stash", ownerId: op.user_id, matchId: null, loadoutId: null }, { reason: "import", refId: opId });
        }
      } else if (op.action === "kit") {
        await grantStarterKit(tx, op.user_id, opId, new Date());
      }
    } else if (op.action === "export" && op.item_id) {
      const it = await lockItem(tx, op.item_id);
      if (it && it.state === "onchain") {
        await applyMove(tx, it, { state: "in_stash" }, { reason: "export_revert", refId: opId });
        // fresh_mint marks an op whose asset never existed before: forget it again.
        if ((op.error ?? "").startsWith("fresh_mint")) {
          await tx.execute(sql`update items set chain_asset = null where id = ${op.item_id} and chain_asset = ${op.asset}`);
        }
      }
    }
  });
}

/**
 * Settles ops left `sent` (request timed out, server restarted): a landed signature finishes them,
 * one whose blockhash expired without landing expires them. `userId` limits it to one player.
 */
export async function settlePendingOps(db: Db, conn: Connection, userId?: string, limit = 20): Promise<number> {
  const r = await db.execute<{ id: string; signature: string; last_valid_block_height: string }>(sql`
    select id, signature, last_valid_block_height from onchain_ops
    where status = 'sent' and signature is not null and created_at < now() - interval '20 seconds'
    ${userId ? sql`and user_id = ${userId}` : sql``}
    order by created_at limit ${limit}`);
  if (r.rows.length === 0) return 0;
  const st = await conn.getSignatureStatuses(r.rows.map((o) => o.signature), { searchTransactionHistory: true });
  const height = await conn.getBlockHeight("confirmed");
  let n = 0;
  for (const [i, o] of r.rows.entries()) {
    const s = st.value[i];
    if (s?.err) await finish(db, o.id, "failed", JSON.stringify(s.err));
    else if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) await finish(db, o.id, "done");
    else if (!s && height > Number(o.last_valid_block_height)) await finish(db, o.id, "expired");
    else continue;
    n++;
  }
  return n;
}
