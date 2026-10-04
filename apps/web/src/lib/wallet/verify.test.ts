/**
 * Sign-In with Solana proof verifier (pure: no DB). The DB side (single use, address taken) is in
 * link.test.ts.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/wallet/verify.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import bs58 from "bs58";
import { SIWS_STATEMENT, SIWS_VERSION, buildSiwsMessage, type SiwsFields } from "./siws";
import { decodeSolanaAddress, verifyEd25519, verifyLinkProof, type ChallengeRecord, type LinkProof } from "./verify";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { address: bs58.encode(raw), sign: (m: Uint8Array) => new Uint8Array(sign(null, m, privateKey)) };
}

const ISSUED = new Date("2026-10-04T06:00:00.000Z");
const EXPIRES = new Date("2026-10-04T06:10:00.000Z");
const NOW = new Date("2026-10-04T06:01:00.000Z");

const CHALLENGE: ChallengeRecord = {
  nonce: "0123456789abcdef0123456789abcdef",
  domain: "spoils.example",
  uri: "https://spoils.example",
  chainId: "devnet",
  issuedAt: ISSUED,
  expiresAt: EXPIRES,
};

function fieldsFor(address: string, over: Partial<SiwsFields> = {}): SiwsFields {
  return {
    domain: CHALLENGE.domain,
    address,
    statement: SIWS_STATEMENT,
    uri: CHALLENGE.uri,
    version: SIWS_VERSION,
    chainId: CHALLENGE.chainId,
    nonce: CHALLENGE.nonce,
    issuedAt: ISSUED.toISOString(),
    expirationTime: EXPIRES.toISOString(),
    ...over,
  };
}

function proof(kp = keypair(), over: Partial<SiwsFields> = {}): LinkProof {
  const message = new TextEncoder().encode(buildSiwsMessage(fieldsFor(kp.address, over)));
  return { address: kp.address, message, signature: kp.sign(message) };
}

describe("verifyLinkProof", () => {
  it("accepts the issued challenge signed by the address's key", () => {
    const r = verifyLinkProof(proof(), CHALLENGE, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.fields.nonce, CHALLENGE.nonce);
  });

  it("accepts the same instant written without milliseconds (wallet reformatting)", () => {
    const r = verifyLinkProof(proof(keypair(), { issuedAt: "2026-10-04T06:00:00Z", expirationTime: "2026-10-04T06:10:00Z" }), CHALLENGE, NOW);
    assert.equal(r.ok, true);
  });

  it("wrong nonce", () => {
    assert.deepEqual(verifyLinkProof(proof(keypair(), { nonce: "ffffffffffffffffffffffffffffffff" }), CHALLENGE, NOW), {
      ok: false,
      error: "wrong_nonce",
    });
    assert.deepEqual(verifyLinkProof(proof(keypair(), { nonce: undefined }), CHALLENGE, NOW), { ok: false, error: "wrong_nonce" });
  });

  it("expired: at and after the expiry", () => {
    assert.deepEqual(verifyLinkProof(proof(), CHALLENGE, EXPIRES), { ok: false, error: "expired" });
    assert.deepEqual(verifyLinkProof(proof(), CHALLENGE, new Date(EXPIRES.getTime() + 60_000)), { ok: false, error: "expired" });
    assert.equal(verifyLinkProof(proof(), CHALLENGE, new Date(EXPIRES.getTime() - 1)).ok, true);
  });

  it("wrong domain (another site, or the same host on another port)", () => {
    assert.deepEqual(verifyLinkProof(proof(keypair(), { domain: "evil.example" }), CHALLENGE, NOW), { ok: false, error: "wrong_domain" });
    assert.deepEqual(verifyLinkProof(proof(keypair(), { domain: "spoils.example:8443" }), CHALLENGE, NOW), {
      ok: false,
      error: "wrong_domain",
    });
  });

  it("wrong URI, chain, statement; times and extra fields must be the issued ones", () => {
    const kp = keypair();
    assert.deepEqual(verifyLinkProof(proof(kp, { uri: "https://evil.example" }), CHALLENGE, NOW), { ok: false, error: "wrong_uri" });
    assert.deepEqual(verifyLinkProof(proof(kp, { chainId: "mainnet" }), CHALLENGE, NOW), { ok: false, error: "wrong_chain" });
    assert.deepEqual(verifyLinkProof(proof(kp, { statement: "Approve" }), CHALLENGE, NOW), { ok: false, error: "wrong_statement" });
    assert.deepEqual(verifyLinkProof(proof(kp, { statement: undefined }), CHALLENGE, NOW), { ok: false, error: "wrong_statement" });
    assert.deepEqual(verifyLinkProof(proof(kp, { version: "2" }), CHALLENGE, NOW), { ok: false, error: "bad_message" });
    assert.deepEqual(verifyLinkProof(proof(kp, { expirationTime: "2027-01-01T00:00:00.000Z" }), CHALLENGE, NOW), {
      ok: false,
      error: "bad_message",
    });
    assert.deepEqual(verifyLinkProof(proof(kp, { issuedAt: undefined }), CHALLENGE, NOW), { ok: false, error: "bad_message" });
    assert.deepEqual(verifyLinkProof(proof(kp, { resources: ["https://x.example"] }), CHALLENGE, NOW), { ok: false, error: "bad_message" });
  });

  it("signature: another key, a tampered message, garbage bytes", () => {
    const kp = keypair();
    const p = proof(kp);
    const other = keypair();
    assert.deepEqual(verifyLinkProof({ ...p, signature: other.sign(p.message) }, CHALLENGE, NOW), { ok: false, error: "bad_signature" });
    const tampered = new TextEncoder().encode(buildSiwsMessage(fieldsFor(kp.address)) + "\n");
    assert.deepEqual(verifyLinkProof({ ...p, message: tampered }, CHALLENGE, NOW), { ok: false, error: "bad_signature" });
    assert.deepEqual(verifyLinkProof({ ...p, signature: new Uint8Array(63) }, CHALLENGE, NOW), { ok: false, error: "bad_signature" });
  });

  it("address: the message must name the posted address, which must be a 32-byte key", () => {
    const kp = keypair();
    const p = proof(kp);
    const other = keypair();
    // The other key signs a message that names kp's address.
    assert.deepEqual(verifyLinkProof({ ...p, address: other.address, signature: other.sign(p.message) }, CHALLENGE, NOW), {
      ok: false,
      error: "address_mismatch",
    });
    assert.deepEqual(verifyLinkProof({ ...p, address: "not-base58-0OIl" }, CHALLENGE, NOW), { ok: false, error: "bad_address" });
    assert.deepEqual(verifyLinkProof({ ...p, address: bs58.encode(new Uint8Array(31).fill(7)) }, CHALLENGE, NOW), {
      ok: false,
      error: "bad_address",
    });
  });

  it("bad message bytes: not UTF-8, not SIWS, empty", () => {
    const kp = keypair();
    const p = proof(kp);
    for (const message of [new Uint8Array([0xff, 0xfe, 0x00]), new TextEncoder().encode("Sign this"), new Uint8Array(0)]) {
      assert.deepEqual(verifyLinkProof({ ...p, message, signature: kp.sign(message) }, CHALLENGE, NOW), { ok: false, error: "bad_message" });
    }
  });
});

describe("primitives", () => {
  it("decodeSolanaAddress / verifyEd25519", () => {
    const kp = keypair();
    const key = decodeSolanaAddress(kp.address);
    assert.equal(key?.length, 32);
    assert.equal(decodeSolanaAddress(""), null);
    const msg = new TextEncoder().encode("hi");
    assert.equal(verifyEd25519(msg, kp.sign(msg), key!), true);
    assert.equal(verifyEd25519(new TextEncoder().encode("ho"), kp.sign(msg), key!), false);
    assert.equal(verifyEd25519(msg, kp.sign(msg), new Uint8Array(32)), false);
  });
});
