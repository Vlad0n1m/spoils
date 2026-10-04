/**
 * T23 panel URLs (WORLD v6 spec §6.3): parsing, defaults, legacy `?tab=` links, junk params, hrefs.
 * Run: apps/game-server/node_modules/.bin/tsx --test apps/web/src/lib/lobby/panels.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NO_PANEL, PANEL_HOTKEYS, PANEL_TABS, normalizePanel, panelHref, parseLobbyPanel, samePanel } from "./panels";

describe("parseLobbyPanel", () => {
  it("no params → no panel", () => {
    assert.deepEqual(parseLobbyPanel({}), NO_PANEL);
  });

  it("a panel gets its first tab by default; only leaderboards carry a period (week by default)", () => {
    assert.deepEqual(parseLobbyPanel({ panel: "inventory" }), { panel: "inventory", tab: "loadout", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "shop" }), { panel: "shop", tab: "market", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "info" }), { panel: "info", tab: "howto", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "news" }), { panel: "news", tab: "feed", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "leaderboards" }), { panel: "leaderboards", tab: "level", period: "week" });
    assert.deepEqual(parseLobbyPanel({ panel: "friends" }), { panel: "friends", tab: "friends", period: null });
  });

  it("valid tabs and periods are kept", () => {
    assert.deepEqual(parseLobbyPanel({ panel: "shop", tab: "traders" }), { panel: "shop", tab: "traders", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "leaderboards", tab: "kills", period: "map" }), {
      panel: "leaderboards",
      tab: "kills",
      period: "map",
    });
    assert.deepEqual(parseLobbyPanel(new URLSearchParams("panel=leaderboards&tab=npc&period=all")), {
      panel: "leaderboards",
      tab: "npc",
      period: "all",
    });
  });

  it("legacy ?tab= links map to the new panels", () => {
    assert.deepEqual(parseLobbyPanel({ tab: "raid" }), NO_PANEL);
    assert.deepEqual(parseLobbyPanel({ tab: "loadout" }), { panel: "inventory", tab: "loadout", period: null });
    assert.deepEqual(parseLobbyPanel({ tab: "stash" }), { panel: "inventory", tab: "stash", period: null });
    assert.deepEqual(parseLobbyPanel({ tab: "market" }), { panel: "shop", tab: "market", period: null });
  });

  it("junk params are ignored, never thrown on", () => {
    assert.deepEqual(parseLobbyPanel({ panel: "guilds" }), NO_PANEL);
    assert.deepEqual(parseLobbyPanel({ panel: "friends", tab: "stash" }), { panel: "friends", tab: "friends", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "friends", tab: "party" }), { panel: "friends", tab: "party", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "<script>" }), NO_PANEL);
    assert.deepEqual(parseLobbyPanel({ tab: "nope" }), NO_PANEL);
    assert.deepEqual(parseLobbyPanel({ panel: "shop", tab: "loadout" }), { panel: "shop", tab: "market", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: "leaderboards", period: "day" }), { panel: "leaderboards", tab: "level", period: "week" });
    assert.deepEqual(parseLobbyPanel({ panel: "info", period: "all" }), { panel: "info", tab: "howto", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: ["news", "shop"], tab: ["patch"] }), { panel: "news", tab: "patch", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: " Shop ", tab: "TRADERS" }), { panel: "shop", tab: "traders", period: null });
    assert.deepEqual(parseLobbyPanel({ panel: undefined, tab: [] }), NO_PANEL);
  });
});

describe("panelHref", () => {
  it("omits defaults and round-trips through the parser", () => {
    assert.equal(panelHref({ panel: null }), "/play");
    assert.equal(panelHref({ panel: "shop" }), "/play?panel=shop");
    assert.equal(panelHref({ panel: "shop", tab: "market" }), "/play?panel=shop");
    assert.equal(panelHref({ panel: "shop", tab: "traders" }), "/play?panel=shop&tab=traders");
    assert.equal(panelHref({ panel: "leaderboards", tab: "kills", period: "week" }), "/play?panel=leaderboards&tab=kills");
    assert.equal(panelHref({ panel: "leaderboards", tab: "kills", period: "map" }), "/play?panel=leaderboards&tab=kills&period=map");
    assert.equal(panelHref({ panel: "info", tab: "bogus" }), "/play?panel=info");
    for (const panel of Object.keys(PANEL_TABS) as Array<keyof typeof PANEL_TABS>) {
      for (const tab of PANEL_TABS[panel]) {
        const s = normalizePanel(panel, tab, panel === "leaderboards" ? "all" : null);
        const back = parseLobbyPanel(new URLSearchParams(panelHref(s).split("?")[1] ?? ""));
        assert.ok(samePanel(s, back), `${panel}/${tab}`);
      }
    }
  });
});

describe("hotkeys", () => {
  it("I, B, L, N, H, F open Inventory, Shop, Leaderboards, News, Info, Friends", () => {
    assert.deepEqual(PANEL_HOTKEYS, { KeyI: "inventory", KeyB: "shop", KeyL: "leaderboards", KeyN: "news", KeyH: "info", KeyF: "friends" });
  });
});
