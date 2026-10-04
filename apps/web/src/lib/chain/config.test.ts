/**
 * Chain settings: the signer key sources, the salt, the RPC fallbacks and error redaction.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/config.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  DEFAULT_RPC_URL,
  DEVNET_PROGRAM_ID,
  chainHashSalt,
  chainProgramId,
  chainRpcUrl,
  devKeyCandidates,
  explorerUrl,
  loadChainAuthority,
  parseSecretKey,
} from "./config";
import { cleanError } from "./worker";
import { FEE_LAMPORTS, readinessProblem } from "./run";

const kp = Keypair.generate();
const asJson = JSON.stringify([...kp.secretKey]);
const asB58 = bs58.encode(kp.secretKey);
const quiet = <T>(f: () => T): T => {
  const orig = console.error;
  console.error = () => undefined;
  try {
    return f();
  } finally {
    console.error = orig;
  }
};

describe("parseSecretKey", () => {
  test("base58 and solana-keygen JSON give the same key", () => {
    assert.ok(parseSecretKey(asB58)!.publicKey.equals(kp.publicKey));
    assert.ok(parseSecretKey(` ${asJson}\n`)!.publicKey.equals(kp.publicKey));
  });
  test("anything else is null", () => {
    for (const bad of ["", "not-a-key", "[1,2,3]", "[oops", bs58.encode(Buffer.alloc(40))]) assert.equal(parseSecretKey(bad), null, bad);
  });
});

describe("loadChainAuthority", () => {
  const noFile = () => null;
  test("CHAIN_AUTHORITY_SECRET wins", () => {
    const r = loadChainAuthority({ CHAIN_AUTHORITY_SECRET: asB58, NODE_ENV: "production" }, noFile);
    assert.equal(r?.source, "env");
    assert.ok(r!.keypair.publicKey.equals(kp.publicKey));
  });
  test("a malformed secret is null (reported by name only), never the dev file", () => {
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      assert.equal(loadChainAuthority({ CHAIN_AUTHORITY_SECRET: "garbage-value" }, () => asJson), null);
    } finally {
      console.error = orig;
    }
    assert.equal(logs.length, 1);
    assert.ok(!logs[0]!.includes("garbage-value"));
  });
  test("outside production the gitignored dev key file is the fallback", () => {
    const seen: string[] = [];
    const repoKey = path.join("/repo", "programs", ".keys", "authority.json");
    const r = loadChainAuthority({ NODE_ENV: "development" }, (p) => (seen.push(p), p === repoKey ? asJson : null), "/repo/apps/web");
    assert.equal(r?.source, "dev-file");
    assert.ok(r!.keypair.publicKey.equals(kp.publicKey));
    assert.deepEqual(seen, devKeyCandidates("/repo/apps/web"));
    assert.deepEqual(seen, [path.join("/repo/apps/web", "programs", ".keys", "authority.json"), repoKey]);
  });
  test("production never reads the dev file", () => {
    let read = false;
    const r = quiet(() => loadChainAuthority({ NODE_ENV: "production" }, () => ((read = true), asJson)));
    assert.equal(r, null);
    assert.equal(read, false);
  });
});

describe("other settings", () => {
  test("salt: env, else a dev salt outside production, else none", () => {
    assert.equal(chainHashSalt({ CHAIN_HASH_SALT: " s3 " }), "s3");
    assert.ok(chainHashSalt({ NODE_ENV: "development" }));
    assert.equal(chainHashSalt({ NODE_ENV: "production" }), null);
  });
  test("RPC: CHAIN_RPC_URL, then SOLANA_RPC_URL, then devnet; program id default", () => {
    assert.equal(chainRpcUrl({ CHAIN_RPC_URL: "https://a.example", SOLANA_RPC_URL: "https://b.example" }), "https://a.example");
    assert.equal(chainRpcUrl({ SOLANA_RPC_URL: "https://b.example" }), "https://b.example");
    assert.equal(chainRpcUrl({ SOLANA_RPC_URL: "  " }), DEFAULT_RPC_URL);
    assert.equal(chainProgramId({}).toBase58(), DEVNET_PROGRAM_ID);
  });
  test("explorer links carry the cluster except on mainnet", () => {
    assert.equal(explorerUrl("tx", "abc", "devnet"), "https://explorer.solana.com/tx/abc?cluster=devnet");
    assert.equal(explorerUrl("address", "P", "mainnet-beta"), "https://explorer.solana.com/address/P");
  });
  test("stored errors keep only URL origins and redact key-like query values", () => {
    const e = new Error("failed to fetch https://rpc.example.com/v2/SECRETKEY123?api-key=abc: 429  Too   Many");
    const s = cleanError(e);
    assert.equal(s, "Error: failed to fetch https://rpc.example.com: 429 Too Many");
    assert.ok(!cleanError("token=xyz&b=1").includes("xyz"));
    assert.ok(cleanError("x".repeat(1000)).length <= 300);
  });
});

describe("readinessProblem", () => {
  const signer = kp.publicKey;
  const config = { authority: signer, matches: 0n, bossKills: 0n, rareExtracts: 0n, bump: 255 };
  const ok = { programDeployed: true, config, signer, lamports: FEE_LAMPORTS * 10, batch: 10 };
  test("ready when deployed, initialized for this signer and able to pay a batch", () => {
    assert.equal(readinessProblem(ok), null);
  });
  test("operator problems keep events queued, each with a reason", () => {
    assert.match(readinessProblem({ ...ok, programDeployed: false })!, /not deployed/);
    assert.match(readinessProblem({ ...ok, config: null })!, /not initialized/);
    assert.match(readinessProblem({ ...ok, config: { ...config, authority: Keypair.generate().publicKey } })!, /not this signer/);
    assert.match(readinessProblem({ ...ok, lamports: FEE_LAMPORTS * 10 - 1 })!, /needs 50000/);
  });
});
