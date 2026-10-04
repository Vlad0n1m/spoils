/**
 * Main-menu panels and their URL (WORLD v6 spec §6.3; replaces the old `?tab=` lobby tabs).
 * `/play?panel=…&tab=…&period=…`. Plain module: the server page parses it, the client menu renders
 * it, the tests cover it. Old links keep working: `?tab=raid|loadout|stash|market` map to none /
 * Inventory·Loadout / Inventory·Stash / Shop·Market. Friends (friends, requests, party) has a panel;
 * Guilds is still locked: no panel.
 */
export const LOBBY_PANELS = ["inventory", "shop", "info", "news", "leaderboards", "friends"] as const;
export type LobbyPanel = (typeof LOBBY_PANELS)[number];

export const PANEL_TABS = {
  inventory: ["loadout", "stash"],
  shop: ["market", "traders"],
  info: ["howto", "rules", "controls"],
  news: ["feed", "patch"],
  leaderboards: ["level", "kills", "npc"],
  friends: ["friends", "requests", "party"],
} as const satisfies Record<LobbyPanel, readonly string[]>;
export type PanelTab<P extends LobbyPanel = LobbyPanel> = (typeof PANEL_TABS)[P][number];

/** Leaderboard periods (the level board is all-time and ignores it). */
export const LB_PERIODS = ["map", "week", "all"] as const;
export type LbPeriod = (typeof LB_PERIODS)[number];
export const DEFAULT_LB_PERIOD: LbPeriod = "week";

export const PANEL_LABEL: Readonly<Record<LobbyPanel, string>> = {
  inventory: "Inventory",
  shop: "Shop",
  info: "Info",
  news: "News",
  leaderboards: "Leaderboards",
  friends: "Friends",
};

export const TAB_LABEL: Readonly<Record<string, string>> = {
  loadout: "Loadout",
  stash: "Stash",
  market: "Market",
  traders: "Traders",
  howto: "How to play",
  rules: "Rules",
  controls: "Controls",
  feed: "World feed",
  patch: "Patch notes",
  level: "Level",
  kills: "Raider kills",
  npc: "NPC kills",
  friends: "Friends",
  requests: "Requests",
  party: "Party",
};

/** Desktop hotkeys (not while typing): I, B, L, N, H, F. */
export const PANEL_HOTKEYS: Readonly<Record<string, LobbyPanel>> = {
  KeyI: "inventory",
  KeyB: "shop",
  KeyL: "leaderboards",
  KeyN: "news",
  KeyH: "info",
  KeyF: "friends",
};

export interface PanelState {
  panel: LobbyPanel | null;
  /** A tab of `panel` (its first tab by default); null without a panel. */
  tab: string | null;
  /** Leaderboards only (default week); null otherwise. */
  period: LbPeriod | null;
}

export const NO_PANEL: PanelState = { panel: null, tab: null, period: null };

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function first(sp: Params, key: string): string | undefined {
  const v = sp instanceof URLSearchParams ? sp.get(key) ?? undefined : sp[key];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim().toLowerCase() : undefined;
}

export function isLobbyPanel(v: unknown): v is LobbyPanel {
  return typeof v === "string" && (LOBBY_PANELS as readonly string[]).includes(v);
}

/** The panel state `p` with a valid tab and period (defaults filled in). */
export function normalizePanel(panel: LobbyPanel | null, tab?: string | null, period?: string | null): PanelState {
  if (!panel) return NO_PANEL;
  const tabs = PANEL_TABS[panel] as readonly string[];
  const t = tab && tabs.includes(tab) ? tab : tabs[0];
  const per = panel === "leaderboards" ? ((LB_PERIODS as readonly string[]).includes(period ?? "") ? (period as LbPeriod) : DEFAULT_LB_PERIOD) : null;
  return { panel, tab: t, period: per };
}

/** Parses `/play` search params (junk → no panel; legacy `?tab=` links mapped). */
export function parseLobbyPanel(sp: Params): PanelState {
  const panel = first(sp, "panel");
  const tab = first(sp, "tab");
  if (isLobbyPanel(panel)) return normalizePanel(panel, tab, first(sp, "period"));
  if (panel) return NO_PANEL;
  // Legacy lobby tabs (pre-v6 bookmarks and links).
  if (tab === "loadout" || tab === "stash") return normalizePanel("inventory", tab);
  if (tab === "market") return normalizePanel("shop", "market");
  return NO_PANEL;
}

/** "/play?panel=shop&tab=traders" (defaults omitted: "/play?panel=shop"). */
export function panelHref(p: { panel: LobbyPanel | null; tab?: string | null; period?: string | null }): string {
  const s = normalizePanel(p.panel, p.tab, p.period);
  if (!s.panel) return "/play";
  const q = new URLSearchParams({ panel: s.panel });
  if (s.tab && s.tab !== PANEL_TABS[s.panel][0]) q.set("tab", s.tab);
  if (s.period && s.period !== DEFAULT_LB_PERIOD) q.set("period", s.period);
  return `/play?${q.toString()}`;
}

/** Same panel, tab and period. */
export function samePanel(a: PanelState, b: PanelState): boolean {
  return a.panel === b.panel && a.tab === b.tab && a.period === b.period;
}
