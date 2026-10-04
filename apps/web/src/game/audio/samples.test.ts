/**
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/game/audio/samples.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CONTAINER_KINDS, buildCollisionIndex } from "@extract/shared";
import { containerOpenSfx, wallImpact } from "./game-audio";
import { SFX, isSfxId } from "./recipes";
import {
  SAMPLE_IDS,
  SAMPLE_MANIFEST,
  SAMPLE_PEAK,
  buildTakes,
  formatOrder,
  layerTake,
  leadTrimIndex,
  matchTake,
  peakOf,
  peakWindowRms,
  sampleFiles,
} from "./samples";

const SR = 48000;
const SFX_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../public/sfx");

function sine(len: number, amp: number, f = 440, lead = 0): Float32Array {
  const d = new Float32Array(lead + len);
  for (let i = 0; i < len; i++) d[lead + i] = amp * Math.sin((2 * Math.PI * f * i) / SR);
  return d;
}

describe("sample manifest", () => {
  it("only names real sounds, never a loop", () => {
    for (const id of SAMPLE_IDS) {
      assert.ok(isSfxId(id), id);
      assert.ok(!(SFX[id] as { loop?: boolean }).loop, `${id} is a loop`);
      assert.ok(SAMPLE_MANIFEST[id]!.files.length > 0, id);
    }
  });

  it("every file exists as .ogg and .m4a, and the whole set stays under 3 MB", () => {
    let bytes = 0;
    for (const f of sampleFiles()) {
      for (const ext of ["ogg", "m4a"]) {
        const p = join(SFX_DIR, `${f}.${ext}`);
        assert.ok(existsSync(p), `missing ${f}.${ext}`);
        bytes += statSync(p).size;
      }
    }
    assert.ok(bytes < 3 * 1024 * 1024, `${bytes} bytes`);
  });

  it("public/sfx/manifest.json lists every file with its Kenney source", () => {
    const m = JSON.parse(readFileSync(join(SFX_DIR, "manifest.json"), "utf8")) as { files: Record<string, { sources: string[] }> };
    for (const f of sampleFiles()) assert.ok(m.files[f]?.sources.length, f);
  });

  it("covers guns, steps by terrain, impacts, interaction and UI", () => {
    for (const id of ["gun_rifle", "gun_shotgun", "explosion", "step_grass", "step_dirt", "step_concrete", "step_wood", "hit_flesh", "hit_armor", "hit_wall", "reload_in", "dry_fire", "chest_open_safe", "item_pickup", "ui_click", "extract_success"] as const) {
      assert.ok(SAMPLE_MANIFEST[id], id);
    }
  });
});

describe("sample DSP", () => {
  it("peakWindowRms of a sine is amp/√2", () => {
    assert.ok(Math.abs(peakWindowRms(sine(SR / 2, 0.5), SR) - 0.5 / Math.SQRT2) < 0.01);
    assert.equal(peakWindowRms(new Float32Array(100), SR), 0);
  });

  it("leadTrimIndex skips leading silence but keeps a 1 ms pre-roll", () => {
    const d = sine(1000, 0.8, 440, 4800);
    const i = leadTrimIndex(d, SR);
    assert.ok(i >= 4800 - 48 && i <= 4800, String(i));
    assert.equal(leadTrimIndex(new Float32Array(10), SR), 0);
  });

  it("matchTake brings a sample to the reference level and never past the peak cap", () => {
    const out = matchTake(sine(SR / 4, 0.1, 440, 2000), SR, 0.3);
    assert.ok(Math.abs(peakWindowRms(out, SR) - 0.3) < 0.01);
    assert.ok(out.length < SR / 4 + 2000);
    const loud = matchTake(sine(SR / 4, 0.1), SR, 2);
    assert.ok(peakOf(loud) <= SAMPLE_PEAK + 1e-6);
    // Unknown reference: kept as authored.
    assert.ok(Math.abs(peakOf(matchTake(sine(SR / 4, 0.2), SR, 0)) - 0.2) < 0.01);
  });

  it("layerTake keeps the procedural level and the longer length", () => {
    const proc = sine(SR / 10, 0.5, 300);
    const smp = sine(SR / 5, 0.05, 900);
    const out = layerTake(proc, smp, SR, -3);
    assert.equal(out.length, smp.length);
    assert.ok(Math.abs(peakWindowRms(out, SR) - peakWindowRms(proc, SR)) < 0.01);
    assert.ok(peakOf(out) <= SAMPLE_PEAK + 1e-6);
    assert.ok(out.every(Number.isFinite));
  });

  it("buildTakes: layer pairs takes (max count), replace maps samples, layer without synth degrades", () => {
    const p = [sine(4800, 0.5), sine(4800, 0.4), sine(4800, 0.6)];
    const s = [sine(4800, 0.1, 800)];
    assert.equal(buildTakes({ files: ["a"], mode: "layer" }, s, p, SR).length, 3);
    assert.equal(buildTakes({ files: ["a"] }, s, p, SR).length, 1);
    assert.equal(buildTakes({ files: ["a"], mode: "layer" }, s, [], SR).length, 1);
    assert.equal(buildTakes({ files: [] }, [], p, SR).length, 0);
  });

  it("formatOrder prefers Opus where supported, AAC otherwise", () => {
    assert.deepEqual(formatOrder(() => "probably"), ["ogg", "m4a"]);
    assert.deepEqual(formatOrder(() => ""), ["m4a", "ogg"]);
  });
});

describe("container lids and wall impacts", () => {
  it("every container kind maps to a lid sound", () => {
    for (const k of CONTAINER_KINDS) assert.ok(isSfxId(containerOpenSfx(k)), k);
    assert.equal(containerOpenSfx("safe"), "chest_open_safe");
    assert.equal(containerOpenSfx("crate"), "chest_open");
    assert.equal(containerOpenSfx("toolbox"), "chest_open_metal");
    assert.equal(containerOpenSfx(undefined), "chest_open");
  });

  it("wallImpact finds the first solid along the middle pellet, null when the shot flies clear", () => {
    const idx = buildCollisionIndex({ rects: [{ x: 500, y: 0, w: 40, h: 1000 }], circles: [] }, 2000, 1000);
    const hit = wallImpact(idx, { cx: 100, cy: 500, a: [-0.1, 0, 0.1] }, 900);
    assert.ok(hit);
    assert.ok(Math.abs(hit.x - 498) < 1 && Math.abs(hit.y - 500) < 1, JSON.stringify(hit));
    assert.ok(Math.abs(hit.dist - 398) < 1);
    assert.equal(wallImpact(idx, { cx: 100, cy: 500, a: [Math.PI] }, 900), null);
    assert.equal(wallImpact(idx, { cx: 100, cy: 500, a: [0] }, 300), null);
    assert.equal(wallImpact(idx, { cx: 100, cy: 500, a: [] }, 900), null);
  });
});
