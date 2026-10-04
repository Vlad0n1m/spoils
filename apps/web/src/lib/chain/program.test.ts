/**
 * The hand-built spoils_events instructions against the program's committed IDL
 * (programs/idl/spoils_events.json, copied from `anchor build`).
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/chain/program.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { DEVNET_PROGRAM_ID } from "./config";
import {
  BPF_LOADER_UPGRADEABLE_ID,
  configPda,
  decodeConfig,
  discriminator,
  encodeRecordData,
  initializeIx,
  programDataAddress,
  recordIx,
  setAuthorityIx,
  type RecordArgs,
} from "./program";

type IdlIx = {
  name: string;
  discriminator: number[];
  accounts: Array<{ name: string; writable?: boolean; signer?: boolean; address?: string }>;
  args: Array<{ name: string; type: unknown }>;
};
const idl = JSON.parse(readFileSync(new URL("../../../../../programs/idl/spoils_events.json", import.meta.url), "utf8")) as {
  address: string;
  instructions: IdlIx[];
  accounts: Array<{ name: string; discriminator: number[] }>;
  events: Array<{ name: string; discriminator: number[] }>;
};
const ix = (name: string) => idl.instructions.find((i) => i.name === name)!;
const PROGRAM = new PublicKey(DEVNET_PROGRAM_ID);
const h = (b: number) => new Uint8Array(32).fill(b);

/** Bytes of one Borsh argument type the program uses. */
function size(t: unknown): number {
  if (t === "u8") return 1;
  if (t === "u16") return 2;
  if (t === "u64") return 8;
  if (t === "pubkey") return 32;
  const arr = (t as { array?: [string, number] }).array;
  if (arr && arr[0] === "u8") return arr[1];
  throw new Error(`unexpected IDL type ${JSON.stringify(t)}`);
}

const SAMPLES: Record<string, RecordArgs> = {
  record_match: { kind: "match", cycleId: 640_123n, shard: 2, matchHash: h(0xaa), humans: 5, mia: 1 },
  record_boss_kill: { kind: "boss_kill", cycleId: 640_123n, bossKind: 1, killerHash: h(0xbb) },
  record_rare_extract: { kind: "rare_extract", cycleId: 640_123n, itemDefHash: h(0xcc), rarity: 3, ownerHash: h(0xdd) },
};

describe("spoils_events encoding", () => {
  test("the default program id is the IDL's address", () => {
    assert.equal(idl.address, DEVNET_PROGRAM_ID);
  });

  test("discriminators are sha256 prefixes and match the IDL", () => {
    for (const i of idl.instructions) assert.deepEqual([...discriminator("global", i.name)], i.discriminator, i.name);
    assert.deepEqual([...discriminator("account", "Config")], idl.accounts.find((a) => a.name === "Config")!.discriminator);
    for (const e of idl.events) assert.deepEqual([...discriminator("event", e.name)], e.discriminator, e.name);
  });

  test("record data: discriminator, then each IDL argument in order and little-endian", () => {
    for (const [name, args] of Object.entries(SAMPLES)) {
      const data = encodeRecordData(args);
      const def = ix(name);
      assert.equal(data.length, 8 + def.args.reduce((s, a) => s + size(a.type), 0), name);
      assert.deepEqual([...data.subarray(0, 8)], def.discriminator);
      assert.equal(data.readBigUInt64LE(8), 640_123n, `${name} cycle_id first`);
    }
    const m = encodeRecordData(SAMPLES.record_match!);
    assert.equal(m.readUInt8(16), 2);
    assert.ok(m.subarray(17, 49).every((b) => b === 0xaa));
    assert.equal(m.readUInt16LE(49), 5);
    assert.equal(m.readUInt16LE(51), 1);
    const b = encodeRecordData(SAMPLES.record_boss_kill!);
    assert.equal(b.readUInt8(16), 1);
    assert.ok(b.subarray(17, 49).every((x) => x === 0xbb));
    const r = encodeRecordData(SAMPLES.record_rare_extract!);
    assert.ok(r.subarray(16, 48).every((x) => x === 0xcc));
    assert.equal(r.readUInt8(48), 3);
    assert.ok(r.subarray(49, 81).every((x) => x === 0xdd));
  });

  test("out-of-range values throw instead of wrapping", () => {
    assert.throws(() => encodeRecordData({ ...(SAMPLES.record_match as Extract<RecordArgs, { kind: "match" }>), humans: 70_000 }), RangeError);
    assert.throws(() => encodeRecordData({ ...(SAMPLES.record_match as Extract<RecordArgs, { kind: "match" }>), shard: 256 }), RangeError);
    assert.throws(() => encodeRecordData({ ...(SAMPLES.record_match as Extract<RecordArgs, { kind: "match" }>), cycleId: -1n }), RangeError);
    assert.throws(() => encodeRecordData({ ...(SAMPLES.record_boss_kill as Extract<RecordArgs, { kind: "boss_kill" }>), killerHash: new Uint8Array(31) }), RangeError);
  });

  test("account metas follow the IDL: config writable, the authority signs", () => {
    const auth = Keypair.generate().publicKey;
    for (const name of Object.keys(SAMPLES)) {
      const i = recordIx(PROGRAM, auth, SAMPLES[name]!);
      const def = ix(name);
      assert.equal(i.keys.length, def.accounts.length);
      def.accounts.forEach((a, k) => {
        assert.equal(i.keys[k]!.isWritable, !!a.writable, `${name}.${a.name} writable`);
        assert.equal(i.keys[k]!.isSigner, !!a.signer, `${name}.${a.name} signer`);
      });
      assert.ok(i.keys[0]!.pubkey.equals(configPda(PROGRAM)));
      assert.ok(i.keys[1]!.pubkey.equals(auth));
    }
    for (const [name, i] of [
      ["initialize", initializeIx(PROGRAM, auth, Keypair.generate().publicKey)],
      ["set_authority", setAuthorityIx(PROGRAM, auth, Keypair.generate().publicKey)],
    ] as const) {
      const def = ix(name);
      assert.equal(i.keys.length, def.accounts.length, name);
      def.accounts.forEach((a, k) => {
        assert.equal(i.keys[k]!.isWritable, !!a.writable, `${name}.${a.name} writable`);
        assert.equal(i.keys[k]!.isSigner, !!a.signer, `${name}.${a.name} signer`);
        if (a.address) assert.equal(i.keys[k]!.pubkey.toBase58(), a.address, `${name}.${a.name} address`);
      });
      assert.equal(i.data.length, 8 + 32);
    }
  });

  test("PDAs: the config seed and the upgradeable loader's program data account", () => {
    const [cfg] = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM);
    assert.ok(configPda(PROGRAM).equals(cfg));
    const [pd] = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], BPF_LOADER_UPGRADEABLE_ID);
    assert.ok(programDataAddress(PROGRAM).equals(pd));
  });

  test("decodeConfig reads the account layout and refuses other accounts", () => {
    const auth = Keypair.generate().publicKey;
    const buf = Buffer.alloc(8 + 32 + 24 + 1);
    discriminator("account", "Config").copy(buf, 0);
    auth.toBuffer().copy(buf, 8);
    buf.writeBigUInt64LE(7n, 40);
    buf.writeBigUInt64LE(2n, 48);
    buf.writeBigUInt64LE(11n, 56);
    buf.writeUInt8(254, 64);
    const c = decodeConfig(buf)!;
    assert.ok(c.authority.equals(auth));
    assert.deepEqual([c.matches, c.bossKills, c.rareExtracts, c.bump], [7n, 2n, 11n, 254]);
    buf[0] ^= 1;
    assert.equal(decodeConfig(buf), null);
    assert.equal(decodeConfig(Buffer.alloc(10)), null);
  });
});
