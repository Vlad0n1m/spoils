/**
 * The web3.js sender against a stubbed Connection: how send errors are classified (a lagging node is
 * not a program rejection, a fee payer below its rent floor is an operator problem) and how a
 * signature is judged expired.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/sender.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, SendTransactionError, type Connection } from "@solana/web3.js";
import { DEVNET_PROGRAM_ID } from "./config";
import type { RecordArgs } from "./program";
import { classifySendError, createWeb3Sender } from "./sender";

const programId = new PublicKey(DEVNET_PROGRAM_ID);
const args: RecordArgs = { kind: "boss_kill", cycleId: 1n, bossKind: 0, killerHash: new Uint8Array(32) };
const simFail = (transactionMessage: string, logs?: string[]) =>
  new SendTransactionError({ action: "simulate", signature: "", transactionMessage, logs });

function sender(conn: Partial<Record<keyof Connection, unknown>>) {
  return createWeb3Sender({ rpcUrl: "http://stub", connection: conn as unknown as Connection, authority: Keypair.generate(), programId, pollMs: 1, confirmTimeoutMs: 20 });
}

describe("classifySendError", () => {
  test("transient JSON-RPC errors are unknown (checked again later), never a rejection", () => {
    for (const m of ["Node is behind by 150 slots", "Node is unhealthy", "Minimum context slot has not been reached", "Transaction simulation failed: Account in use"]) {
      assert.equal(classifySendError(simFail(m)).status, "unknown", m);
    }
    assert.equal(classifySendError(new Error("fetch failed")).status, "unknown");
    assert.equal(classifySendError(simFail("Transaction simulation failed: This transaction has already been processed")).status, "unknown");
  });

  test("a fee payer the runtime refuses is blocked (operator problem), not a rejection", () => {
    for (const m of [
      "Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent",
      "Transaction simulation failed: Insufficient funds for fee",
      "Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.",
      "Transaction simulation failed: This account may not be used to pay transaction fees",
      "Transaction simulation failed: Attempt to load a program that does not exist",
    ]) {
      assert.equal(classifySendError(simFail(m)).status, "blocked", m);
    }
  });

  test("only an instruction error is a rejection", () => {
    const r = classifySendError(simFail("Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770", ["Program log: AnchorError"]));
    assert.equal(r.status, "rejected");
    assert.equal(classifySendError(simFail("Transaction simulation failed: Error processing Instruction 0: invalid account data for instruction")).status, "rejected");
  });

  test("an unknown blockhash is expired", () => {
    assert.equal(classifySendError(simFail("Transaction simulation failed: Blockhash not found")).status, "expired");
  });
});

describe("web3 sender", () => {
  const latest = async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 });

  test("send() passes the classification through: a lagging node is unknown, low rent is blocked", async () => {
    for (const [m, want] of [
      ["Node is behind by 150 slots", "unknown"],
      ["Transaction simulation failed: Transaction results in an account (0) with insufficient funds for rent", "blocked"],
    ] as const) {
      const s = sender({ getLatestBlockhash: latest, sendRawTransaction: async () => Promise.reject(simFail(m)) });
      const out = await (await s.prepare(args)).send();
      assert.equal(out.status, want, m);
    }
  });

  test("status(): a signature that landed while the height was read is confirmed, not expired", async () => {
    const calls: string[] = [];
    let lookups = 0;
    const s = sender({
      getSignatureStatuses: async () => {
        calls.push("sigs");
        return { value: [lookups++ === 0 ? null : { err: null, confirmationStatus: "confirmed" }] };
      },
      getBlockHeight: async () => (calls.push("height"), 101),
    });
    assert.deepEqual(await s.status("sig", 100), { status: "confirmed" });
    assert.deepEqual(calls, ["sigs", "height", "sigs"]);
  });

  test("status(): not found and past its block height is expired; within it, pending", async () => {
    const none = { getSignatureStatuses: async () => ({ value: [null] }) };
    assert.deepEqual(await sender({ ...none, getBlockHeight: async () => 101 }).status("sig", 100), { status: "expired" });
    assert.deepEqual(await sender({ ...none, getBlockHeight: async () => 100 }).status("sig", 100), { status: "pending" });
    assert.deepEqual(await sender(none).status("sig", null), { status: "expired" });
  });
});
