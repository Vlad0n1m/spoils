/**
 * Wallet link DB flow against the isolated `extract_test` database (see lib/inventory/test-db.ts):
 * nonce issue, single use, expiry, domain binding, one account per wallet, unlink.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/wallet/link.test.ts
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import bs58 from "bs58";
import { users, walletLinkNonces } from "../../db/schema";
import { closeTestDb, lockTestDb, makeUser, openTestDb, resetDb } from "../inventory/test-db";
import { LINK_NONCE_TTL_MS, getLinkedWallet, issueLinkChallenge, linkWallet, unlinkWallet, type ChallengeContext } from "./link";
import { buildSiwsMessage, type SiwsChallenge } from "./siws";
import type { LinkProof } from "./verify";

const { db, pool } = openTestDb();
before(() => lockTestDb(pool));
after(() => closeTestDb(pool));
beforeEach(() => resetDb(db));

const CTX: ChallengeContext = { domain: "spoils.example", uri: "https://spoils.example", chainId: "devnet" };
const T0 = new Date("2026-10-04T06:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { address: bs58.encode(raw), sign: (m: Uint8Array) => new Uint8Array(sign(null, m, privateKey)) };
}
type Keypair = ReturnType<typeof keypair>;

async function challenge(userId: string, ctx = CTX, now = T0): Promise<SiwsChallenge> {
  const r = await issueLinkChallenge(db, userId, ctx, now);
  assert.ok(r.ok);
  return r.challenge;
}

/** What the browser posts: the wallet signs the challenge text with its address filled in. */
function signed(kp: Keypair, ch: SiwsChallenge, over: Partial<SiwsChallenge> = {}): LinkProof {
  const message = new TextEncoder().encode(buildSiwsMessage({ ...ch, ...over, address: kp.address }));
  return { address: kp.address, message, signature: kp.sign(message) };
}

async function walletOf(userId: string) {
  const [u] = await db.select({ w: users.walletPubkey, at: users.walletLinkedAt }).from(users).where(eq(users.id, userId));
  return u!;
}

describe("issueLinkChallenge", () => {
  it("stores a fresh 10-minute nonce bound to the user with the request's domain, URI and chain", async () => {
    const uid = await makeUser(db);
    const ch = await challenge(uid);
    assert.match(ch.nonce, /^[0-9a-f]{32}$/);
    assert.equal(ch.statement, "Link this wallet to your SPOILS account");
    assert.equal(ch.version, "1");
    assert.equal(ch.chainId, "devnet");
    assert.equal(ch.issuedAt, T0.toISOString());
    assert.equal(ch.expirationTime, at(LINK_NONCE_TTL_MS).toISOString());
    const [row] = await db.select().from(walletLinkNonces).where(eq(walletLinkNonces.nonce, ch.nonce));
    assert.equal(row?.userId, uid);
    assert.equal(row?.domain, "spoils.example");
    assert.equal(row?.usedAt, null);
    assert.notEqual((await challenge(uid)).nonce, ch.nonce);
  });

  it("refuses an unknown user and prunes long-expired nonces", async () => {
    assert.deepEqual(await issueLinkChallenge(db, "00000000-0000-4000-8000-000000000000", CTX, T0), { ok: false, error: "unknown_user" });
    const uid = await makeUser(db);
    const old = await challenge(uid, CTX, T0);
    await challenge(uid, CTX, at(LINK_NONCE_TTL_MS + 61 * 60_000));
    assert.equal((await db.select().from(walletLinkNonces).where(eq(walletLinkNonces.nonce, old.nonce))).length, 0);
  });
});

describe("linkWallet", () => {
  it("valid: links the address with linked_at and reports it", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    const ch = await challenge(uid);
    const r = await linkWallet(db, uid, signed(kp, ch), at(60_000));
    assert.deepEqual(r, { ok: true, wallet: { address: kp.address, linkedAt: at(60_000).toISOString() } });
    const w = await walletOf(uid);
    assert.equal(w.w, kp.address);
    assert.equal(w.at?.toISOString(), at(60_000).toISOString());
    assert.deepEqual(await getLinkedWallet(db, uid), { address: kp.address, linkedAt: at(60_000).toISOString() });
  });

  it("wrong nonce: an unknown nonce, or another user's nonce", async () => {
    const uid = await makeUser(db);
    const other = await makeUser(db);
    const kp = keypair();
    const ch = await challenge(uid);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch, { nonce: "ffffffffffffffffffffffffffffffff" }), at(1000)), {
      ok: false,
      error: "wrong_nonce",
    });
    const theirs = await challenge(other);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, theirs), at(1000)), { ok: false, error: "wrong_nonce" });
    // Neither attempt burned a nonce they did not own: both still work for their owners.
    assert.equal((await linkWallet(db, uid, signed(kp, ch), at(2000))).ok, true);
    assert.equal((await linkWallet(db, other, signed(keypair(), theirs), at(2000))).ok, true);
    assert.equal((await walletOf(uid)).w, kp.address);
  });

  it("reused nonce: the second attempt with the same nonce fails, even after a failed first one", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    const ch = await challenge(uid);
    assert.equal((await linkWallet(db, uid, signed(kp, ch), at(1000))).ok, true);
    await unlinkWallet(db, uid);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch), at(2000)), { ok: false, error: "nonce_used" });

    const ch2 = await challenge(uid);
    const bad = signed(kp, ch2);
    assert.deepEqual(await linkWallet(db, uid, { ...bad, signature: keypair().sign(bad.message) }, at(3000)), {
      ok: false,
      error: "bad_signature",
    });
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch2), at(4000)), { ok: false, error: "nonce_used" });
    assert.equal((await walletOf(uid)).w, null);
  });

  it("expired: a nonce older than 10 minutes is refused (and spent)", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    const ch = await challenge(uid);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch), at(LINK_NONCE_TTL_MS)), { ok: false, error: "expired" });
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch), at(1000)), { ok: false, error: "nonce_used" });
    assert.equal((await walletOf(uid)).w, null);
  });

  it("wrong domain: the message must name the domain the nonce was issued for", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    const ch = await challenge(uid);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, ch, { domain: "evil.example" }), at(1000)), { ok: false, error: "wrong_domain" });
    // A nonce issued on another host does not verify a message for this one either.
    const local = await challenge(uid, { domain: "localhost:3001", uri: "http://localhost:3001", chainId: "devnet" });
    assert.deepEqual(await linkWallet(db, uid, signed(kp, local, { domain: "spoils.example" }), at(1000)), {
      ok: false,
      error: "wrong_domain",
    });
    assert.equal((await walletOf(uid)).w, null);
  });

  it("address taken: a wallet linked to one account cannot be linked to another", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    const kp = keypair();
    assert.equal((await linkWallet(db, a, signed(kp, await challenge(a)), at(1000))).ok, true);
    assert.deepEqual(await linkWallet(db, b, signed(kp, await challenge(b)), at(2000)), { ok: false, error: "address_taken" });
    assert.equal((await walletOf(b)).w, null);
    // Free again once the first account unlinks.
    assert.deepEqual(await unlinkWallet(db, a), { unlinked: true });
    assert.equal((await linkWallet(db, b, signed(kp, await challenge(b)), at(3000))).ok, true);
    assert.equal((await walletOf(b)).w, kp.address);
  });

  it("concurrent links of one wallet from two accounts: exactly one wins", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);
    const kp = keypair();
    const [pa, pb] = [signed(kp, await challenge(a)), signed(kp, await challenge(b))];
    const results = await Promise.all([linkWallet(db, a, pa, at(1000)), linkWallet(db, b, pb, at(1000))]);
    assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
    const loser = results.find((r) => !r.ok);
    assert.deepEqual(loser, { ok: false, error: "address_taken" });
  });

  it("already linked: same wallet again is a no-op, a second wallet needs an unlink first", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    assert.equal((await linkWallet(db, uid, signed(kp, await challenge(uid)), at(1000))).ok, true);
    assert.deepEqual(await linkWallet(db, uid, signed(kp, await challenge(uid)), at(5000)), {
      ok: true,
      wallet: { address: kp.address, linkedAt: at(1000).toISOString() },
    });
    assert.deepEqual(await linkWallet(db, uid, signed(keypair(), await challenge(uid)), at(6000)), { ok: false, error: "already_linked" });
    assert.equal((await walletOf(uid)).w, kp.address);
  });

  it("garbage message: refused before any nonce is touched", async () => {
    const uid = await makeUser(db);
    const ch = await challenge(uid);
    const kp = keypair();
    const message = new TextEncoder().encode(`Nonce: ${ch.nonce}`);
    assert.deepEqual(await linkWallet(db, uid, { address: kp.address, message, signature: kp.sign(message) }, at(1000)), {
      ok: false,
      error: "bad_message",
    });
    assert.equal((await linkWallet(db, uid, signed(kp, ch), at(2000))).ok, true);
  });
});

describe("unlinkWallet", () => {
  it("clears the wallet and linked_at; a second unlink reports nothing to do", async () => {
    const uid = await makeUser(db);
    const kp = keypair();
    await linkWallet(db, uid, signed(kp, await challenge(uid)), at(1000));
    assert.deepEqual(await unlinkWallet(db, uid), { unlinked: true });
    assert.deepEqual(await walletOf(uid), { w: null, at: null });
    assert.equal(await getLinkedWallet(db, uid), null);
    assert.deepEqual(await unlinkWallet(db, uid), { unlinked: false });
  });
});
