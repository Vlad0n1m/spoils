/**
 * Server-side check of a Sign-In with Solana proof against the challenge the server issued
 * (lib/wallet/link.ts). Pure apart from node:crypto: the DB part (nonce lookup, single use, the
 * unique wallet) lives in link.ts. Ed25519 via node:crypto, so no extra crypto dependency.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import bs58 from "bs58";
import { SIWS_STATEMENT, SIWS_VERSION, parseSiwsMessage, type SiwsFields } from "./siws";

export type ProofError =
  | "bad_address"
  | "bad_message"
  | "bad_signature"
  | "address_mismatch"
  | "wrong_nonce"
  | "wrong_domain"
  | "wrong_uri"
  | "wrong_chain"
  | "wrong_statement"
  | "expired";

/** What the client posts: the wallet's address, the exact bytes it signed and the signature. */
export interface LinkProof {
  address: string;
  message: Uint8Array;
  signature: Uint8Array;
}

/** The stored challenge the message must match (a wallet_link_nonces row). */
export interface ChallengeRecord {
  nonce: string;
  domain: string;
  uri: string;
  chainId: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** 32-byte ed25519 public key of a base58 Solana address, or null. */
export function decodeSolanaAddress(address: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  try {
    const bytes = bs58.decode(address);
    return bytes.length === 32 ? bytes : null;
  } catch {
    return null;
  }
}

export function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey).toString("base64url") },
      format: "jwk",
    });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/** Strict UTF-8 decode + SIWS parse of the signed bytes. */
export function decodeSiwsBytes(message: Uint8Array): SiwsFields | null {
  if (message.length === 0 || message.length > 4096) return null;
  try {
    return parseSiwsMessage(new TextDecoder("utf-8", { fatal: true }).decode(message));
  } catch {
    return null;
  }
}

function sameInstant(text: string | undefined, at: Date): boolean {
  if (!text) return false;
  const t = Date.parse(text);
  return Number.isFinite(t) && t === at.getTime();
}

/**
 * Every check except nonce single-use and the unique wallet (both need the DB): the signed text is a
 * SIWS message for this address, carrying exactly the issued nonce, domain, URI, chain, statement,
 * version and times, the challenge has not expired, and the ed25519 signature over the signed bytes
 * verifies with the address's key.
 */
export function verifyLinkProof(
  proof: LinkProof,
  challenge: ChallengeRecord,
  now: Date,
): { ok: true; fields: SiwsFields } | { ok: false; error: ProofError } {
  const publicKey = decodeSolanaAddress(proof.address);
  if (!publicKey) return { ok: false, error: "bad_address" };
  const f = decodeSiwsBytes(proof.message);
  if (!f) return { ok: false, error: "bad_message" };
  if (f.address !== proof.address) return { ok: false, error: "address_mismatch" };
  if (f.nonce !== challenge.nonce) return { ok: false, error: "wrong_nonce" };
  if (f.domain !== challenge.domain) return { ok: false, error: "wrong_domain" };
  if (f.uri !== challenge.uri) return { ok: false, error: "wrong_uri" };
  if (f.chainId !== challenge.chainId) return { ok: false, error: "wrong_chain" };
  if (f.statement !== SIWS_STATEMENT) return { ok: false, error: "wrong_statement" };
  if (
    f.version !== SIWS_VERSION ||
    !sameInstant(f.issuedAt, challenge.issuedAt) ||
    !sameInstant(f.expirationTime, challenge.expiresAt) ||
    f.notBefore !== undefined ||
    f.requestId !== undefined ||
    f.resources !== undefined
  ) {
    return { ok: false, error: "bad_message" };
  }
  if (now.getTime() >= challenge.expiresAt.getTime()) return { ok: false, error: "expired" };
  if (!verifyEd25519(proof.message, proof.signature, publicKey)) return { ok: false, error: "bad_signature" };
  return { ok: true, fields: f };
}
