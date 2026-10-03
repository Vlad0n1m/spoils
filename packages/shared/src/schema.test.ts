import assert from "node:assert/strict";
import { test } from "node:test";
import { Decoder, Encoder, Reflection, Schema, type, view } from "@colyseus/schema";
import * as schemaModule from "./schema.js";
import {
  ACT,
  BattleState,
  Corpse,
  GroundItem,
  SCHEMA_CLASSES,
  SelfState,
  VIEW_ROOT_FIELDS,
  containerLootKey,
  corpseLootKey,
  selfKeyOf,
} from "./schema.js";

type FieldMd = { name: string; tag?: number };
const META = (Symbol as unknown as { metadata: symbol }).metadata;

/**
 * Every field carrying view metadata, as "Class.field:tag". Private data may only live in
 * root-level @view() maps (critique: @view on a field of a public schema crashes the decoder after
 * view.remove → mutate, and @view(tag) is not used at all).
 */
function viewFields(classes: ReadonlyArray<abstract new () => Schema>): string[] {
  const out: string[] = [];
  for (const klass of classes) {
    const md = (klass as unknown as Record<symbol, Record<string, FieldMd>>)[META];
    assert.ok(md, `${klass.name} has schema metadata`);
    for (const k of Object.keys(md)) {
      if (!/^\d+$/.test(k)) continue;
      const f = md[k]!;
      if (f.tag !== undefined) out.push(`${klass.name}.${f.name}:${f.tag}`);
    }
  }
  return out.sort();
}

test("no view metadata outside the allowed BattleState root maps, and never @view(tag)", () => {
  const allowed = VIEW_ROOT_FIELDS.map((f) => `BattleState.${f}:-1`).sort();
  assert.deepEqual(viewFields(SCHEMA_CLASSES), allowed);
});

test("the lint catches @view(tag) and nested @view fields", () => {
  // Test files are compiled without experimentalDecorators (tsconfig excludes them), so the
  // decorators are applied by hand, in the same order as `@view() @type(...)` in schema.ts.
  class Priv extends Schema {}
  type("uint16")(Priv.prototype, "ammo");
  class BadPlayer extends Schema {}
  type("number")(BadPlayer.prototype, "x");
  type(Priv)(BadPlayer.prototype, "priv");
  view(1)(BadPlayer.prototype, "priv");
  class BadRoot extends Schema {}
  type({ map: BadPlayer })(BadRoot.prototype, "players");
  view()(BadRoot.prototype, "players");
  assert.deepEqual(viewFields([BadPlayer, BadRoot]), ["BadPlayer.priv:1", "BadRoot.players:-1"]);
});

test("SCHEMA_CLASSES lists every Schema class exported by schema.ts", () => {
  const exported = Object.values(schemaModule).filter(
    (v: unknown) => typeof v === "function" && v.prototype instanceof Schema,
  );
  assert.deepEqual(new Set(exported), new Set(SCHEMA_CLASSES as readonly unknown[]));
});

test("state encodes and reflects; view maps keyed as the contract says", () => {
  const s = new BattleState();
  s.containerState.push(0, 1, 2);
  const enc = new Encoder(s);
  assert.ok(enc.encodeAll().length > 0);
  assert.ok(Reflection.encode(enc).length > 0);
  assert.equal(selfKeyOf(7), "p7");
  assert.equal(containerLootKey(12), "c12");
  assert.equal(corpseLootKey("ab"), "kab");
  // ACT bits are distinct single bits (one uint8).
  const bits = Object.values(ACT).filter((v) => v !== 0);
  assert.equal(bits.reduce((a, b) => a | b, 0), bits.reduce((a, b) => a + b, 0));
  assert.ok(Math.max(...bits) < 256);
});

/** "Class.field" → schema type of every plain field. */
function fieldTypes(klass: abstract new () => Schema): Record<string, unknown> {
  const md = (klass as unknown as Record<symbol, Record<string, { name: string; type: unknown }>>)[META]!;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(md)) if (/^\d+$/.test(k)) out[md[k]!.name] = md[k]!.type;
  return out;
}

test("WORLD v6 fields: BattleState cycle / boss, SelfState arm, expiry timers; totalPlayers is uint16", () => {
  const bs = fieldTypes(BattleState);
  assert.equal(bs.cycleId, "uint32");
  assert.equal(bs.entryCloseMs, "number");
  assert.equal(bs.bossKind, "string");
  assert.equal(bs.bossZone, "string");
  assert.equal(bs.bossState, "uint8");
  assert.equal(bs.totalPlayers, "uint16", "entries this cycle can pass 255");
  const ss = fieldTypes(SelfState);
  assert.equal(ss.enteredAt, "number");
  assert.equal(ss.extractArmAt, "number");
  assert.equal(fieldTypes(GroundItem).expiresAt, "number");
  assert.equal(fieldTypes(Corpse).expiresAt, "number");
  // Defaults = legacy match.
  const s = new BattleState();
  assert.deepEqual(
    [s.cycleId, s.entryCloseMs, s.bossKind, s.bossZone, s.bossState, s.totalPlayers],
    [0, 0, "", "", 0, 0],
  );
  const self = new SelfState();
  assert.deepEqual([self.enteredAt, self.extractArmAt], [0, 0]);
  assert.equal(new GroundItem().expiresAt, 0);
  assert.equal(new Corpse().expiresAt, 0);
});

test("WORLD v6 plain fields round-trip through the encoder (no view needed)", () => {
  const s = new BattleState();
  s.cycleId = 657_408;
  s.entryCloseMs = 35 * 60_000;
  s.bossKind = "foreman";
  s.bossZone = "Grain Elevator";
  s.bossState = 2;
  s.totalPlayers = 300;
  const enc = new Encoder(s);
  const out = new BattleState();
  new Decoder(out).decode(enc.encodeAll());
  assert.deepEqual(
    [out.cycleId, out.entryCloseMs, out.bossKind, out.bossZone, out.bossState, out.totalPlayers],
    [657_408, 35 * 60_000, "foreman", "Grain Elevator", 2, 300],
  );
});
