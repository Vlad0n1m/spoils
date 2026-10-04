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

export function createWeb3Sender(o: Web3SenderOptions): ChainSender {
  const connection = o.connection ?? chainConnection(o.rpcUrl, o.requestTimeoutMs);
  const confirmTimeoutMs = o.confirmTimeoutMs ?? 12_000;
  const pollMs = o.pollMs ?? 800;

  async function status(sig: string, validUntil: number | null): Promise<SigStatus> {
    const { value } = await connection.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = value[0];
    if (s) {
      if (s.err) return { status: "failed", error: `on-chain error ${JSON.stringify(s.err)}` };
      return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? { status: "confirmed" } : { status: "pending" };
    }
    if (validUntil === null) return { status: "expired" };
    const height = await connection.getBlockHeight("confirmed");
    return height > validUntil ? { status: "expired" } : { status: "pending" };
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
          const msg = cleanError(e);
          if (/blockhash not found/i.test(msg)) return { status: "expired" };
          // A failed simulation never reaches the cluster: the program (or the runtime) refused it.
          if (e instanceof SendTransactionError) return { status: "rejected", error: msg };
          return { status: "unknown", error: msg };
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
