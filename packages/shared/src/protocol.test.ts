import assert from "node:assert/strict";
import { test } from "node:test";
import { C2S, CLOSE_CODES, S2C, WORLD_JOIN_ERR, quantizeFa } from "./protocol.js";
import { joinTicketPayload } from "./types.js";

test("message names are unique per direction; v1 broadcast events are gone", () => {
  assert.equal(new Set(Object.values(C2S)).size, Object.values(C2S).length);
  assert.equal(new Set(Object.values(S2C)).size, Object.values(S2C).length);
  for (const gone of ["shot", "hit", "kill", "chest", "noise", "sound"]) {
    assert.ok(!(Object.values(S2C) as string[]).includes(gone), gone);
  }
  assert.equal(CLOSE_CODES.LOADOUT_REJECTED, 4104);
  for (const c of Object.values(CLOSE_CODES)) assert.ok(c > 4100 && c < 5000, "outside Colyseus' reserved 4000–4010");
});

test("quantizeFa snaps to 2π/64 (damage arc, too coarse to aim with)", () => {
  const step = (Math.PI * 2) / 64;
  assert.equal(quantizeFa(0), 0);
  assert.ok(Math.abs(quantizeFa(step * 0.49)) < 1e-12);
  assert.ok(Math.abs(quantizeFa(step * 0.51) - step) < 1e-12);
  assert.ok(Math.abs(quantizeFa(-Math.PI / 2) + Math.PI / 2) < 1e-12);
  for (let a = -Math.PI; a <= Math.PI; a += 0.013) assert.ok(Math.abs(quantizeFa(a) - a) <= step / 2 + 1e-12);
});

test("joinTicketPayload covers every signed field including the loadout, match and entry", () => {
  assert.equal(joinTicketPayload({ userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L" }), "u.n.5.L..");
  assert.equal(
    joinTicketPayload({ userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L", matchId: "m", entryId: "e" }),
    "u.n.5.L.m.e",
  );
  const t = { userId: "u", nickname: "n", issuedAt: 5, loadoutId: "L", matchId: "m", entryId: "e" };
  const p = joinTicketPayload(t);
  assert.notEqual(joinTicketPayload({ ...t, loadoutId: "" }), p);
  assert.notEqual(joinTicketPayload({ ...t, matchId: "m2" }), p);
  assert.notEqual(joinTicketPayload({ ...t, entryId: "e2" }), p);
});

test("WORLD v6 close codes and admission error codes", () => {
  assert.equal(CLOSE_CODES.WIPED, 4105);
  assert.equal(CLOSE_CODES.NOT_IN_WORLD, 4109);
  assert.equal(new Set(Object.values(CLOSE_CODES)).size, Object.values(CLOSE_CODES).length, "close codes are unique");
  const errs = Object.values(WORLD_JOIN_ERR);
  assert.equal(new Set(errs).size, errs.length);
  assert.ok(errs.every((e) => /^[a-z_]+$/.test(e)), "no ':' inside a code (detail goes after it)");
  assert.equal(WORLD_JOIN_ERR.WORLD_FULL, "world_full");
  assert.equal(WORLD_JOIN_ERR.MAP_GONE, "map_gone");
});
