import assert from "node:assert/strict";
import { test } from "node:test";
import { generateMap } from "@extract/shared";
import { PLACE_NAMES } from "./brand";

test("PLACE_NAMES lists the map's places in generator order", () => {
  assert.deepEqual([...PLACE_NAMES], generateMap("steppe").zones.map((z) => z.name));
});
