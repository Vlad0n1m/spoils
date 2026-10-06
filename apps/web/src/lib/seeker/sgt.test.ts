/**
 * Seeker Genesis Token parser and check on recorded mainnet JSON-RPC answers (fixtures/, recorded
 * 2026-10-06 from api.mainnet-beta.solana.com; the owner wallets and token accounts are replaced with
 * random addresses, the SGT mint 5mXb… is the docs' explorer example).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/seeker/sgt.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_SEEKER_RPC_URL, SGT, SgtRpcError, findSgtMint, heldMints, isSgtMintAccount, seekerRpcUrl, sgtMintIn, type FetchLike } from "./sgt";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const HOLDER = "57AoY689EJ8rhaHWG8Rpfn6UmGrRRrBnbzHeVJAgDVLL";
const FORMER = "GkTtEynos5M6f3kPExgq5UBDSvbGkXgYL9mFRwgSoffn";
const SGT_MINT = "5mXbkqKz883aufhAsx3p5Z1NcvD2ppZbdTTznM6oUKLj";
const OTHER_MINT = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"; // a Token-2022 stock token (not an SGT)
const RATE_LIMITED = { jsonrpc: "2.0", error: { code: 429, message: "Too many requests for a specific RPC call" }, id: 1 };

const holderAccounts = () => fixture("token-accounts-holder.json") as { result: { value: unknown[] } };
const mintsBody = () => fixture("mints-sgt-and-other.json") as { result: { value: Array<Record<string, any>> } };
const sgtAccount = () => structuredClone(mintsBody().result.value[0]!);
const clone = <T>(v: T): T => structuredClone(v);

function extOf(account: Record<string, any>, name: string): Record<string, any> {
  return account.data.parsed.info.extensions.find((e: { extension: string }) => e.extension === name).state;
}

describe("heldMints (getTokenAccountsByOwner, jsonParsed)", () => {
  it("lists the mints with a non-zero balance", () => {
    // The holder fixture also has an empty account of another token: skipped.
    assert.deepEqual(heldMints(holderAccounts(), HOLDER), [SGT_MINT]);
  });

  it("an SGT moved out leaves a 0-balance account that does not count", () => {
    assert.deepEqual(heldMints(fixture("token-accounts-former-holder.json"), FORMER), []);
  });

  it("ignores accounts of another owner and non-Token-2022 accounts", () => {
    assert.deepEqual(heldMints(holderAccounts(), FORMER), []);
    const body = holderAccounts();
    for (const v of body.result.value as Array<Record<string, any>>) v.account.owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    assert.deepEqual(heldMints(body, HOLDER), []);
  });

  it("an empty wallet has no mints", () => {
    assert.deepEqual(heldMints({ jsonrpc: "2.0", result: { context: { slot: 1 }, value: [] }, id: 1 }), []);
  });

  it("deduplicates a mint held in two accounts", () => {
    const body = holderAccounts();
    body.result.value.push(clone(body.result.value[1]));
    assert.deepEqual(heldMints(body, HOLDER), [SGT_MINT]);
  });

  it("throws on an RPC error or a malformed body (never 'no SGT')", () => {
    assert.throws(() => heldMints(RATE_LIMITED), SgtRpcError);
    assert.throws(() => heldMints(null), SgtRpcError);
    assert.throws(() => heldMints({ jsonrpc: "2.0", result: { value: null }, id: 1 }), SgtRpcError);
  });
});

describe("isSgtMintAccount / sgtMintIn (getMultipleAccounts, jsonParsed)", () => {
  it("recognises the real SGT and rejects another Token-2022 mint", () => {
    const [sgt, other] = mintsBody().result.value;
    assert.equal(isSgtMintAccount(sgt), true);
    assert.equal(isSgtMintAccount(other), false);
    assert.equal(sgtMintIn(mintsBody(), [SGT_MINT, OTHER_MINT]), SGT_MINT);
  });

  it("returns the SGT whatever its position, null when there is none", () => {
    const body = mintsBody();
    body.result.value.reverse();
    assert.equal(sgtMintIn(body, [OTHER_MINT, SGT_MINT]), SGT_MINT);
    const none = mintsBody();
    none.result.value = [none.result.value[1]!];
    assert.equal(sgtMintIn(none, [OTHER_MINT]), null);
  });

  it("missing accounts (null) are skipped", () => {
    const body = mintsBody();
    body.result.value.unshift(null as unknown as Record<string, any>);
    assert.equal(sgtMintIn(body, ["11111111111111111111111111111111", SGT_MINT, OTHER_MINT]), SGT_MINT);
  });

  it("needs both the metadata pointer and the group membership", () => {
    const wrongGroup = sgtAccount();
    extOf(wrongGroup, "tokenGroupMember").group = OTHER_MINT;
    assert.equal(isSgtMintAccount(wrongGroup), false);

    const wrongMeta = sgtAccount();
    extOf(wrongMeta, "metadataPointer").metadataAddress = OTHER_MINT;
    assert.equal(isSgtMintAccount(wrongMeta), false);

    const noGroup = sgtAccount();
    noGroup.data.parsed.info.extensions = noGroup.data.parsed.info.extensions.filter((e: { extension: string }) => e.extension !== "tokenGroupMember");
    assert.equal(isSgtMintAccount(noGroup), false);
  });

  it("a look-alike outside Token-2022, with another mint authority, or not a mint is rejected", () => {
    const classic = sgtAccount();
    classic.owner = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    assert.equal(isSgtMintAccount(classic), false);

    const otherAuthority = sgtAccount();
    otherAuthority.data.parsed.info.mintAuthority = OTHER_MINT;
    assert.equal(isSgtMintAccount(otherAuthority), false);

    const tokenAccount = sgtAccount();
    tokenAccount.data.parsed.type = "account";
    assert.equal(isSgtMintAccount(tokenAccount), false);

    assert.equal(isSgtMintAccount(null), false);
    assert.equal(isSgtMintAccount({ owner: SGT.TOKEN_2022_PROGRAM, data: ["AAAA", "base64"] }), false);
  });

  it("an absent mintAuthority field does not fail an otherwise valid SGT", () => {
    const a = sgtAccount();
    delete a.data.parsed.info.mintAuthority;
    assert.equal(isSgtMintAccount(a), true);
  });

  it("throws on an RPC error", () => {
    assert.throws(() => sgtMintIn(RATE_LIMITED, [SGT_MINT]), SgtRpcError);
  });
});

/** A fake RPC answering from fixtures; records the calls. */
function fakeRpc(answers: Record<string, unknown | ((params: any[]) => unknown)>, opts: { status?: number } = {}) {
  const calls: Array<{ method: string; params: any[] }> = [];
  const f: FetchLike = async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params: any[] };
    calls.push(req);
    const a = answers[req.method];
    const body = typeof a === "function" ? (a as (p: any[]) => unknown)(req.params) : a;
    return { ok: (opts.status ?? 200) < 400, status: opts.status ?? 200, json: async () => body };
  };
  return { f, calls };
}

describe("findSgtMint", () => {
  it("holder: two requests, returns the SGT mint", async () => {
    const rpc = fakeRpc({ getTokenAccountsByOwner: holderAccounts(), getMultipleAccounts: mintsBody() });
    assert.equal(await findSgtMint(HOLDER, { fetch: rpc.f, rpcUrl: "http://rpc.test" }), SGT_MINT);
    assert.deepEqual(
      rpc.calls.map((c) => c.method),
      ["getTokenAccountsByOwner", "getMultipleAccounts"],
    );
    assert.equal(rpc.calls[0]!.params[0], HOLDER);
    assert.deepEqual(rpc.calls[0]!.params[1], { programId: SGT.TOKEN_2022_PROGRAM });
    assert.equal(rpc.calls[0]!.params[2].encoding, "jsonParsed");
    assert.deepEqual(rpc.calls[1]!.params[0], [SGT_MINT]);
  });

  it("former holder: no non-empty accounts, no mint lookup, null", async () => {
    const rpc = fakeRpc({ getTokenAccountsByOwner: fixture("token-accounts-former-holder.json") });
    assert.equal(await findSgtMint(FORMER, { fetch: rpc.f }), null);
    assert.equal(rpc.calls.length, 1);
  });

  it("looks the mints up in batches of 100", async () => {
    const many = holderAccounts();
    const template = many.result.value[1] as Record<string, any>;
    many.result.value = Array.from({ length: 150 }, (_, i) => {
      const v = clone(template);
      v.account.data.parsed.info.mint = i === 149 ? SGT_MINT : `Mint${i}`.padEnd(44, "z");
      return v;
    });
    const sgt = mintsBody().result.value[0];
    const rpc = fakeRpc({
      getTokenAccountsByOwner: many,
      getMultipleAccounts: (params: any[]) => ({ jsonrpc: "2.0", id: 1, result: { value: (params[0] as string[]).map((m) => (m === SGT_MINT ? sgt : null)) } }),
    });
    assert.equal(await findSgtMint(HOLDER, { fetch: rpc.f }), SGT_MINT);
    assert.deepEqual(
      rpc.calls.filter((c) => c.method === "getMultipleAccounts").map((c) => c.params[0].length),
      [100, 50],
    );
  });

  it("RPC failures throw (rate limit, HTTP error, network)", async () => {
    await assert.rejects(findSgtMint(HOLDER, { fetch: fakeRpc({ getTokenAccountsByOwner: RATE_LIMITED }).f }), SgtRpcError);
    await assert.rejects(findSgtMint(HOLDER, { fetch: fakeRpc({}, { status: 503 }).f }), SgtRpcError);
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(findSgtMint(HOLDER, { fetch: down }), SgtRpcError);
  });
});

describe("seekerRpcUrl", () => {
  it("SEEKER_RPC_URL or the public mainnet default", () => {
    assert.equal(seekerRpcUrl({}), DEFAULT_SEEKER_RPC_URL);
    assert.equal(seekerRpcUrl({ SEEKER_RPC_URL: "  " }), DEFAULT_SEEKER_RPC_URL);
    assert.equal(seekerRpcUrl({ SEEKER_RPC_URL: "https://mainnet.example/rpc" }), "https://mainnet.example/rpc");
    assert.match(DEFAULT_SEEKER_RPC_URL, /mainnet/);
  });
});
