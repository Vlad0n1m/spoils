/**
 * Wallet link (Sign-In with Solana): a signed-in, registered user proves they own a Solana address and
 * it is stored as users.wallet_pubkey (one account per wallet). Identity only: nothing is transferred
 * and no transaction is ever signed. Separate from the custodial deposit address (market balance).
 *
 *  1. issueLinkChallenge: a random nonce bound to the user, valid LINK_NONCE_TTL_MS, stored with the
 *     domain / URI / chain the message must carry.
 *  2. The wallet signs the SIWS message (solana:signIn, or signMessage of buildSiwsMessage).
 *  3. linkWallet: claims the nonce (single use, whatever the outcome), verifies the proof
 *     (verify.ts), then stores the address unless another account holds it.
 *
 * Services take the database as a parameter (tests use extract_test).
 */
import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { users, walletLinkNonces } from "../../db/schema";
import type { Db } from "../inventory/db";
import type { SiwsChainId } from "./cluster";
import { SIWS_NONCE_RE, SIWS_STATEMENT, SIWS_VERSION, type SiwsChallenge } from "./siws";
import type { LinkedWallet } from "./types";
import { decodeSiwsBytes, verifyLinkProof, type LinkProof, type ProofError } from "./verify";

export const LINK_NONCE_TTL_MS = 10 * 60_000;
/** Issued nonces are deleted this long after they expire (used ones included). */
const NONCE_PRUNE_AFTER_MS = 60 * 60_000;

export type { LinkedWallet };

export interface ChallengeContext {
  /** SIWS domain: the Host the page was served from (RFC 3986 authority, port included). */
  domain: string;
  /** SIWS URI: the page origin. */
  uri: string;
  chainId: SiwsChainId;
}

export type LinkError = ProofError | "nonce_used" | "address_taken" | "already_linked" | "unknown_user";

export type LinkResult = { ok: true; wallet: LinkedWallet } | { ok: false; error: LinkError };

export async function getLinkedWallet(db: Db, userId: string): Promise<LinkedWallet | null> {
  const [u] = await db
    .select({ address: users.walletPubkey, linkedAt: users.walletLinkedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u?.address) return null;
  return { address: u.address, linkedAt: (u.linkedAt ?? new Date(0)).toISOString() };
}

export async function issueLinkChallenge(
  db: Db,
  userId: string,
  ctx: ChallengeContext,
  now = new Date(),
): Promise<{ ok: true; challenge: SiwsChallenge } | { ok: false; error: "unknown_user" }> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return { ok: false, error: "unknown_user" };

  await db.delete(walletLinkNonces).where(lt(walletLinkNonces.expiresAt, new Date(now.getTime() - NONCE_PRUNE_AFTER_MS)));
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = new Date(now.getTime() + LINK_NONCE_TTL_MS);
  await db.insert(walletLinkNonces).values({
    nonce,
    userId,
    domain: ctx.domain,
    uri: ctx.uri,
    chainId: ctx.chainId,
    issuedAt: now,
    expiresAt,
  });
  return {
    ok: true,
    challenge: {
      domain: ctx.domain,
      statement: SIWS_STATEMENT,
      uri: ctx.uri,
      version: SIWS_VERSION,
      chainId: ctx.chainId,
      nonce,
      issuedAt: now.toISOString(),
      expirationTime: expiresAt.toISOString(),
    },
  };
}

function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x && typeof x === "object" && "code" in x ? (x as { code?: unknown }).code : undefined);
  return code(e) === "23505" || code((e as { cause?: unknown } | null)?.cause) === "23505";
}

export async function linkWallet(db: Db, userId: string, proof: LinkProof, now = new Date()): Promise<LinkResult> {
  const fields = decodeSiwsBytes(proof.message);
  if (!fields) return { ok: false, error: "bad_message" };
  const nonce = fields.nonce;
  if (!nonce || !SIWS_NONCE_RE.test(nonce)) return { ok: false, error: "wrong_nonce" };

  // Claim first: a nonce answers exactly one verify attempt, even a failing one.
  const [challenge] = await db
    .update(walletLinkNonces)
    .set({ usedAt: now })
    .where(and(eq(walletLinkNonces.nonce, nonce), eq(walletLinkNonces.userId, userId), isNull(walletLinkNonces.usedAt)))
    .returning();
  if (!challenge) {
    const [seen] = await db
      .select({ nonce: walletLinkNonces.nonce })
      .from(walletLinkNonces)
      .where(and(eq(walletLinkNonces.nonce, nonce), eq(walletLinkNonces.userId, userId)))
      .limit(1);
    return { ok: false, error: seen ? "nonce_used" : "wrong_nonce" };
  }

  const checked = verifyLinkProof(proof, challenge, now);
  if (!checked.ok) return checked;

  try {
    return await db.transaction(async (tx): Promise<LinkResult> => {
      const [u] = await tx
        .select({ address: users.walletPubkey, linkedAt: users.walletLinkedAt })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");
      if (!u) return { ok: false, error: "unknown_user" };
      if (u.address === proof.address) {
        return { ok: true, wallet: { address: u.address, linkedAt: (u.linkedAt ?? now).toISOString() } };
      }
      if (u.address) return { ok: false, error: "already_linked" };
      const [other] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.walletPubkey, proof.address), ne(users.id, userId)))
        .limit(1);
      if (other) return { ok: false, error: "address_taken" };
      await tx.update(users).set({ walletPubkey: proof.address, walletLinkedAt: now }).where(eq(users.id, userId));
      return { ok: true, wallet: { address: proof.address, linkedAt: now.toISOString() } };
    });
  } catch (e) {
    // Two accounts linking the same wallet at once: the unique index decides.
    if (isUniqueViolation(e)) return { ok: false, error: "address_taken" };
    throw e;
  }
}

/** Clears the link; `unlinked` is false when nothing was linked. */
export async function unlinkWallet(db: Db, userId: string): Promise<{ unlinked: boolean }> {
  const rows = await db
    .update(users)
    .set({ walletPubkey: null, walletLinkedAt: null })
    .where(and(eq(users.id, userId), isNotNull(users.walletPubkey)))
    .returning({ id: users.id });
  return { unlinked: rows.length > 0 };
}
