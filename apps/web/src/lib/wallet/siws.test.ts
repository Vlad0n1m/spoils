/**
 * Sign-In with Solana message builder / parser (pure).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/wallet/siws.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SIWS_NONCE_RE, SIWS_STATEMENT, SIWS_VERSION, buildSiwsMessage, parseSiwsMessage, shortAddress, type SiwsFields } from "./siws";
import { explorerAddressUrl, parseCluster, siwsChainId, walletChain } from "./cluster";

const ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const LINK: SiwsFields = {
  domain: "spoils.example",
  address: ADDRESS,
  statement: SIWS_STATEMENT,
  uri: "https://spoils.example",
  version: SIWS_VERSION,
  chainId: "devnet",
  nonce: "0123456789abcdef0123456789abcdef",
  issuedAt: "2026-10-04T06:00:00.000Z",
  expirationTime: "2026-10-04T06:10:00.000Z",
};

describe("buildSiwsMessage", () => {
  it("writes the SIWS layout wallets show (header, address, statement, fields)", () => {
    assert.equal(
      buildSiwsMessage(LINK),
      [
        "spoils.example wants you to sign in with your Solana account:",
        ADDRESS,
        "",
        "Link this wallet to your SPOILS account",
        "",
        "URI: https://spoils.example",
        "Version: 1",
        "Chain ID: devnet",
        "Nonce: 0123456789abcdef0123456789abcdef",
        "Issued At: 2026-10-04T06:00:00.000Z",
        "Expiration Time: 2026-10-04T06:10:00.000Z",
      ].join("\n"),
    );
  });

  it("omits what is not given; resources are a dash list", () => {
    assert.equal(
      buildSiwsMessage({ domain: "localhost:3001", address: ADDRESS }),
      `localhost:3001 wants you to sign in with your Solana account:\n${ADDRESS}`,
    );
    assert.equal(
      buildSiwsMessage({ domain: "a.example", address: ADDRESS, requestId: "r1", resources: ["https://a.example/x", "ipfs://y"] }),
      `a.example wants you to sign in with your Solana account:\n${ADDRESS}\n\nRequest ID: r1\nResources:\n- https://a.example/x\n- ipfs://y`,
    );
  });
});

describe("parseSiwsMessage", () => {
  it("round-trips the link message and every optional field", () => {
    assert.deepEqual(parseSiwsMessage(buildSiwsMessage(LINK)), LINK);
    const full: SiwsFields = {
      ...LINK,
      statement: "Another one-line statement.",
      notBefore: "2026-10-04T06:00:01.000Z",
      requestId: "req-7",
      resources: ["https://spoils.example/terms", "https://spoils.example/privacy"],
    };
    assert.deepEqual(parseSiwsMessage(buildSiwsMessage(full)), full);
    assert.deepEqual(parseSiwsMessage(buildSiwsMessage({ domain: "localhost:3001", address: ADDRESS })), {
      domain: "localhost:3001",
      address: ADDRESS,
    });
  });

  it("keeps the domain's port and tolerates trailing newlines", () => {
    const p = parseSiwsMessage(`${buildSiwsMessage({ ...LINK, domain: "localhost:3001" })}\n\n`);
    assert.equal(p?.domain, "localhost:3001");
    assert.equal(p?.nonce, LINK.nonce);
  });

  it("rejects anything that is not a SIWS message", () => {
    assert.equal(parseSiwsMessage(""), null);
    assert.equal(parseSiwsMessage("hello"), null);
    assert.equal(parseSiwsMessage(`spoils.example wants you to sign in with your Ethereum account:\n${ADDRESS}`), null);
    assert.equal(parseSiwsMessage(`\xffsolana offchain${buildSiwsMessage(LINK)}`), null, "off-chain message envelope");
    assert.equal(parseSiwsMessage(buildSiwsMessage(LINK).replace(/\n/g, "\r\n")), null, "CRLF");
    assert.equal(parseSiwsMessage(`${buildSiwsMessage(LINK)}\nNonce: 2nd`), null, "duplicate field");
    assert.equal(parseSiwsMessage(`${buildSiwsMessage(LINK)}\nUnknown: x`), null, "unknown trailing field");
    assert.equal(parseSiwsMessage("x".repeat(5000)), null, "oversized");
  });

  it("rejects a multi-line statement (it could fake fields, e.g. a second nonce)", () => {
    assert.equal(parseSiwsMessage(buildSiwsMessage({ ...LINK, statement: `${SIWS_STATEMENT}\nNonce: aaaaaaaaaaaaaaaa` })), null);
    assert.equal(parseSiwsMessage(buildSiwsMessage({ ...LINK, statement: "Two lines\nof statement" })), null);
  });
});

describe("helpers", () => {
  it("nonce pattern, short address", () => {
    assert.ok(SIWS_NONCE_RE.test(LINK.nonce!));
    assert.ok(!SIWS_NONCE_RE.test("short"));
    assert.ok(!SIWS_NONCE_RE.test("has space in it"));
    assert.equal(shortAddress(ADDRESS), "7xKX…gAsU");
  });

  it("cluster: default devnet, SIWS chain id and Wallet Standard chain", () => {
    assert.equal(parseCluster(undefined), "devnet");
    assert.equal(parseCluster(""), "devnet");
    assert.equal(parseCluster("mainnet"), "mainnet-beta");
    assert.equal(parseCluster("Mainnet-Beta"), "mainnet-beta");
    assert.equal(parseCluster("testnet"), "testnet");
    assert.equal(siwsChainId("mainnet-beta"), "mainnet");
    assert.equal(siwsChainId("devnet"), "devnet");
    assert.equal(walletChain("devnet"), "solana:devnet");
    assert.equal(walletChain("mainnet-beta"), "solana:mainnet");
    assert.equal(explorerAddressUrl(ADDRESS, "devnet"), `https://explorer.solana.com/address/${ADDRESS}?cluster=devnet`);
    assert.equal(explorerAddressUrl(ADDRESS, "mainnet-beta"), `https://explorer.solana.com/address/${ADDRESS}`);
  });
});
