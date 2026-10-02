import assert from "node:assert/strict";
import { test } from "node:test";
import { Encoder, Reflection, Schema, type, view } from "@colyseus/schema";
import * as schemaModule from "./schema.js";
import { ACT, BattleState, SCHEMA_CLASSES, VIEW_ROOT_FIELDS, containerLootKey, corpseLootKey, selfKeyOf } from "./schema.js";

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
