/**
 * Paying through the iDos Title store (lib/idos/store-pay.ts) against a fake iDos: the request shape,
 * the debit verification (a Success that did not take exactly Count × price is a failed payment),
 * the 100k-then-1k legs with refund_owed when the second fails, refusals and unknown outcomes, and
 * the balance read.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/idos/store-pay.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decomposeSpoils, type PaymentLeg } from "./shop-rules";
import {
  checkLeg,
  idosClientRequest,
  mainDebited,
  parseSpoilsBalance,
  payLegs,
  purchaseBody,
  readSpoilsBalance,
  refusalCode,
  type IdosPlayer,
} from "./store-pay";

const PLAYER: IdosPlayer = { titleId: "8YECHSD4", userId: "user_abc123", ticket: "T".repeat(40) };
const LEG_1K: PaymentLeg = { offerId: "pay_1k", count: 14, spoils: 14_000, key: "1k" };

/** The verified live answer of Store/Purchase with `amount` Main debited. */
function purchaseOk(offerId: string, count: number, amount: number) {
  return {
    Success: true,
    Data: {
      OfferID: offerId,
      Count: count,
      Resources: {
        Consume: { Standard: { Entries: [{ Type: "CryptoCurrency", CurrencyID: "Main", Amount: amount }] } },
        Grant: { Standard: { Entries: [{ Type: "VirtualCurrency", CurrencyID: "SR", Amount: count }] } },
      },
    },
  };
}

type Reply = { status?: number; body?: unknown } | "throw";

/** A fetch that answers `replies` in order and records every request. */
function fakeIdos(replies: Reply[]) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init!, body: JSON.parse(String(init!.body)) });
    const r = replies.shift();
    if (!r || r === "throw") throw new Error("network down");
    return new Response(JSON.stringify(r.body ?? null), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("requests", () => {
  it("call the Client API as the SDK does, with the player's ticket", () => {
    const { url, init } = idosClientRequest(PLAYER, "Store/Purchase", { OfferID: "pay_1k" }, "https://api.example/");
    assert.equal(url, "https://api.example/api/v2/8YECHSD4/Client/Store/Purchase/user_abc123");
    assert.equal(init.method, "POST");
    const h = init.headers as Record<string, string>;
    assert.equal(h.Authorization, `Bearer ${PLAYER.ticket}`);
    assert.equal(h["X-IG-Platform"], "Web");
    assert.deepEqual(JSON.parse(String(init.body)), { UserID: PLAYER.userId, ClientSessionTicket: PLAYER.ticket, OfferID: "pay_1k" });
  });

  it("buy the offer from its Fixed slot with the order's idempotency key", () => {
    assert.deepEqual(purchaseBody(LEG_1K, "order-1:1k"), {
      OfferID: "pay_1k",
      Count: 14,
      SelectedOptionID: "spoils",
      StoreID: "spoils",
      SectionID: "pay",
      SlotID: "pay_1k",
      RelatedEntityID: "order-1:1k",
    });
  });
});

describe("debit verification", () => {
  it("counts only Main crypto in Consume", () => {
    assert.equal(mainDebited(purchaseOk("pay_1k", 14, 14_000).Data), 14_000);
    assert.equal(mainDebited({ Resources: { Consume: { Standard: { Entries: [{ Type: "VirtualCurrency", CurrencyID: "Main", Amount: 5 }] } } } }), 0);
    assert.equal(mainDebited({ Resources: { Consume: { Standard: { Entries: [{ Type: "CryptoCurrency", CurrencyID: "Main", Amount: "3000" }] } } } }), 3000);
    assert.equal(mainDebited(null), 0);
    assert.equal(mainDebited({}), 0);
  });

  it("a leg is paid only when exactly Count × price was debited", () => {
    assert.deepEqual(checkLeg(purchaseOk("pay_1k", 14, 14_000).Data, LEG_1K), { ok: true, debited: 14_000 });
    // The USD-priced option: Success, but iDos debits 0 Main.
    const zero = checkLeg(purchaseOk("pay_1k", 14, 0).Data, LEG_1K);
    assert.equal(zero.ok, false);
    assert.equal(zero.debited, 0);
    assert.equal(checkLeg(purchaseOk("pay_1k", 14, 13_000).Data, LEG_1K).ok, false);
    assert.equal(checkLeg(purchaseOk("pay_1k", 14, 15_000).Data, LEG_1K).ok, false);
    assert.equal(checkLeg(purchaseOk("pay_100k", 14, 14_000).Data, LEG_1K).ok, false, "another offer");
    assert.equal(checkLeg(purchaseOk("pay_1k", 13, 14_000).Data, LEG_1K).ok, false, "another count");
  });

  it("classifies refusals", () => {
    assert.equal(refusalCode("Atomic purchase transaction failed: CC Main: insufficient balance (have 0, need 3000)."), "insufficient_spoils");
    assert.equal(refusalCode("Offer not found in slot."), "store_missing");
    assert.equal(refusalCode("Something else"), "refused");
  });
});

describe("payLegs", () => {
  const legs = decomposeSpoils(278_000)!;

  it("pays 100k then 1k and reports the total", async () => {
    const f = fakeIdos([{ body: purchaseOk("pay_100k", 2, 200_000) }, { body: purchaseOk("pay_1k", 78, 78_000) }]);
    const r = await payLegs(PLAYER, "o1", legs, {}, { fetchImpl: f.impl, baseUrl: "https://x" });
    assert.equal(r.status, "paid");
    assert.equal(r.paid, 278_000);
    assert.deepEqual(f.calls.map((c) => [c.body.OfferID, c.body.Count, c.body.RelatedEntityID]), [
      ["pay_100k", 2, "o1:100k"],
      ["pay_1k", 78, "o1:1k"],
    ]);
  });

  it("insufficient balance on the first leg: failed, nothing taken", async () => {
    const f = fakeIdos([{ body: { Success: false, Error: "Atomic purchase transaction failed: CC Main: insufficient balance (have 0, need 200000)." } }]);
    const r = await payLegs(PLAYER, "o2", legs, {}, { fetchImpl: f.impl });
    assert.equal(r.status, "failed");
    assert.equal(r.status === "failed" && r.code, "insufficient_spoils");
    assert.equal(r.paid, 0);
    assert.equal(f.calls.length, 1, "the 1k leg is never tried");
  });

  it("the 1k leg fails after the 100k leg was taken: refund_owed with the paid amount", async () => {
    const f = fakeIdos([{ body: purchaseOk("pay_100k", 2, 200_000) }, { body: { Success: false, Error: "CC Main: insufficient balance" } }]);
    const r = await payLegs(PLAYER, "o3", legs, {}, { fetchImpl: f.impl });
    assert.equal(r.status, "refund_owed");
    assert.equal(r.paid, 200_000);
  });

  it("a mismatched debit is a failed payment; whatever was taken is owed back", async () => {
    const zero = await payLegs(PLAYER, "o4", [LEG_1K], {}, { fetchImpl: fakeIdos([{ body: purchaseOk("pay_1k", 14, 0) }]).impl });
    assert.equal(zero.status, "failed");
    assert.equal(zero.status === "failed" && zero.code, "debit_mismatch");
    const part = await payLegs(PLAYER, "o5", [LEG_1K], {}, { fetchImpl: fakeIdos([{ body: purchaseOk("pay_1k", 14, 5_000) }]).impl });
    assert.equal(part.status, "refund_owed");
    assert.equal(part.paid, 5_000);
  });

  it("a refused ticket is invalid_session", async () => {
    const r = await payLegs(PLAYER, "o6", [LEG_1K], {}, { fetchImpl: fakeIdos([{ status: 401, body: { Success: false } }]).impl });
    assert.equal(r.status === "failed" && r.code, "invalid_session");
  });

  it("no answer: unknown, and a retry skips the legs already paid and reuses the keys", async () => {
    const first = fakeIdos([{ body: purchaseOk("pay_100k", 2, 200_000) }, "throw"]);
    const r1 = await payLegs(PLAYER, "o7", legs, {}, { fetchImpl: first.impl });
    assert.equal(r1.status, "unknown");
    assert.equal(r1.paid, 200_000);
    const second = fakeIdos([{ body: purchaseOk("pay_1k", 78, 78_000) }]);
    const r2 = await payLegs(PLAYER, "o7", legs, r1.legs, { fetchImpl: second.impl });
    assert.equal(r2.status, "paid");
    assert.equal(r2.paid, 278_000);
    assert.deepEqual(second.calls.map((c) => c.body.RelatedEntityID), ["o7:1k"]);
  });

  it("a 5xx is unknown, never a refusal", async () => {
    const r = await payLegs(PLAYER, "o8", [LEG_1K], {}, { fetchImpl: fakeIdos([{ status: 502, body: { Success: false, Error: "bad gateway" } }]).impl });
    assert.equal(r.status, "unknown");
  });
});

describe("balance", () => {
  it("reads CryptoBalances.Main.Amount (absent = 0)", async () => {
    assert.equal(parseSpoilsBalance({ CryptoBalances: { Main: { Amount: "1234567.5" } } }), 1234567.5);
    assert.equal(parseSpoilsBalance({ CryptoBalances: {} }), 0);
    assert.equal(parseSpoilsBalance(null), 0);
    const f = fakeIdos([{ body: { Success: true, Data: { CryptoBalances: { Main: { Amount: "50000" } } } } }]);
    assert.deepEqual(await readSpoilsBalance(PLAYER, { fetchImpl: f.impl }), { ok: true, spoils: 50_000 });
    assert.match(f.calls[0]!.url, /\/Client\/Blockchain\/GetUserState\/user_abc123$/);
    assert.deepEqual(await readSpoilsBalance(PLAYER, { fetchImpl: fakeIdos([{ status: 401 }]).impl }), { ok: false, reason: "invalid_session" });
    assert.deepEqual(await readSpoilsBalance(PLAYER, { fetchImpl: fakeIdos(["throw"]).impl }), { ok: false, reason: "unavailable" });
  });
});
