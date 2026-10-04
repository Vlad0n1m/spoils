import { Connection, Keypair, PublicKey, SendTransactionError, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { recordIx, type RecordArgs } from "./program";
import { cleanError, type ChainSender, type PreparedTx, type SendOutcome, type SigStatus } from "./worker";

/**
 * ChainSender over @solana/web3.js: the server authority signs and pays every record transaction
 * (one instruction, no new accounts). Confirmation is polled with getSignatureStatuses against the
 * blockhash's last valid block height (no websocket), every RPC call is time-limited, and 429s are
 * not retried inside web3.js, so a dead or slow RPC costs at most the worker's time budget.
 */

export interface Web3SenderOptions {
  rpcUrl: string;
  /** Reuse a connection (else one is made from rpcUrl). */
  connection?: Connection;
  authority: Keypair;
  programId: PublicKey;
  /** Per RPC request (default 8 s). */
  requestTimeoutMs?: number;
  /** Wait for confirmation after sending (default 12 s), polling every pollMs (default 800 ms). */
  confirmTimeoutMs?: number;
  pollMs?: number;
}

export function chainConnection(rpcUrl: string, requestTimeoutMs = 8_000): Connection {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true,
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) }),
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The fee payer or the program cannot take a transaction (TransactionError texts of the runtime):
 * InsufficientFundsForFee, InsufficientFundsForRent (a fee that would leave the payer below its
 * rent-exempt minimum), AccountNotFound (payer never funded), InvalidAccountForFee and
 * ProgramAccountNotFound. Operator problems: they say nothing about the event itself.
 */
const BLOCKED_RE =
  /insufficient funds for fee|insufficient funds for rent|found no record of a prior credit|may not be used to pay transaction fees|load a program that does not exist/i;
/** The program (an instruction) refused the transaction: InstructionError / custom program error. */
const PROGRAM_RE = /error processing instruction \d+|custom program error|InstructionError/i;

/**
 * What a sendRawTransaction error means for the event. web3.js throws SendTransactionError for every
 * JSON-RPC error of sendTransaction, not only for a failed simulation: a node that is behind
 * (-32005 "Node is behind by N slots"), a min-context-slot miss and the like are transient. Only an
 * instruction error is a rejection of the event; a fee payer that cannot pay is "blocked" (the
 * operator must top it up); "already processed" means an earlier copy landed; anything else is
 * "unknown", so the next pass checks the signature and, once its blockhash expired, signs again.
 */
export function classifySendError(e: unknown): SendOutcome {
  const msg = cleanError(e);
  const raw = e instanceof Error ? e.message : String(e);
  if (/blockhash not found/i.test(raw)) return { status: "expired" };
  if (!(e instanceof SendTransactionError)) return { status: "unknown", error: msg };
  if (/already been processed/i.test(raw)) return { status: "unknown", error: msg };
  if (BLOCKED_RE.test(raw)) return { status: "blocked", error: msg };
  if (PROGRAM_RE.test(raw)) return { status: "rejected", error: msg };
  return { status: "unknown", error: msg };
}

export function createWeb3Sender(o: Web3SenderOptions): ChainSender {
  const connection = o.connection ?? chainConnection(o.rpcUrl, o.requestTimeoutMs);
  const confirmTimeoutMs = o.confirmTimeoutMs ?? 12_000;
  const pollMs = o.pollMs ?? 800;

  async function lookup(sig: string): Promise<SigStatus | null> {
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = value[0];
    if (!s) return null;
    if (s.err) return { status: "failed", error: `on-chain error ${JSON.stringify(s.err)}` };
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? { status: "confirmed" } : { status: "pending" };
  }

  async function status(sig: string, validUntil: number | null): Promise<SigStatus> {
    const first = await lookup(sig);
    if (first) return first;
    if (validUntil === null) return { status: "expired" };
    const height = await connection.getBlockHeight("confirmed");
    if (height <= validUntil) return { status: "pending" };
    // The height was read after the first lookup: a transaction that landed in between would be
    // called expired and recorded twice. Once the height is past, it can no longer land, so one
    // more lookup settles it.
    return (await lookup(sig)) ?? { status: "expired" };
  }

  async function prepare(args: RecordArgs): Promise<PreparedTx> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: o.authority.publicKey, blockhash, lastValidBlockHeight }).add(
      recordIx(o.programId, o.authority.publicKey, args),
    );
    tx.sign(o.authority);
    const sig = bs58.encode(tx.signature!);
    const raw = tx.serialize();
    return {
      sig,
      validUntil: lastValidBlockHeight,
      async send(): Promise<SendOutcome> {
        try {
          await connection.sendRawTransaction(raw, { preflightCommitment: "confirmed", maxRetries: 3 });
        } catch (e) {
          return classifySendError(e);
        }
        const deadline = Date.now() + confirmTimeoutMs;
        let last = "not confirmed in time";
        while (Date.now() < deadline) {
          await sleep(pollMs);
          try {
            const st = await status(sig, lastValidBlockHeight);
            if (st.status === "confirmed") return { status: "confirmed" };
            if (st.status === "failed") return { status: "rejected", error: st.error };
            if (st.status === "expired") return { status: "expired" };
          } catch (e) {
            last = cleanError(e);
          }
        }
        return { status: "unknown", error: last };
      },
    };
  }

  return { prepare, status };
}
