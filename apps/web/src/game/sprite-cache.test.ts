/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/sprite-cache.test.ts
 *
 * The battle sprite cache: each image is downloaded and decoded once per page (warmed in the menu,
 * reused by every raid's textures), a failed one is retried later, and the warm-up keeps only a few
 * downloads in flight.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const loads: string[] = [];
let inFlight = 0;
let maxInFlight = 0;
const failing = new Set<string>();

class FakeImage {
  src = "";
  async decode(): Promise<void> {
    loads.push(this.src);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (failing.has(this.src)) throw new Error("404");
  }
}
(globalThis as { Image?: unknown }).Image = FakeImage;

const { SPRITE_NAMES, spriteImage, warmSprites, warmSpritesFor } = await import("./sprite-cache");

describe("sprite cache", () => {
  it("decodes each sprite once, keeps it for later raids, and retries a failed one", async () => {
    failing.add("/sprites/bolt.png");
    await warmSprites();
    assert.equal(loads.length, SPRITE_NAMES.length, "one download per sprite");
    assert.ok(maxInFlight <= 3, `at most 3 in flight (${maxInFlight})`);
    const a = await spriteImage("player");
    const b = await spriteImage("player");
    assert.ok(a && a === b, "the same decoded image every time");
    assert.equal(loads.length, SPRITE_NAMES.length, "no second download");
    // The failed one is not cached: the next request tries again.
    assert.equal(await spriteImage("bolt"), null);
    assert.equal(loads.filter((s) => s === "/sprites/bolt.png").length, 2);
    failing.clear();
    assert.ok(await spriteImage("bolt"));
  });

  it("warmSpritesFor never waits longer than its cap", async () => {
    const t0 = Date.now();
    await warmSpritesFor(5);
    assert.ok(Date.now() - t0 < 1_000);
  });
});
