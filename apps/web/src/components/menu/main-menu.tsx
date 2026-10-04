"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import clsx from "clsx";
import { worldCycleOf, type LeaderboardBoard } from "@extract/shared";
import { useSession } from "@/lib/session-context";
import { LobbyProvider, useLobby } from "@/lib/lobby/lobby-context";
import {
  PANEL_HOTKEYS,
  PANEL_LABEL,
  PANEL_TABS,
  panelHref,
  parseLobbyPanel,
  type LbPeriod,
  type LobbyPanel,
  type PanelState,
} from "@/lib/lobby/panels";
import { stageForUser, type PlayStage } from "@/lib/play-stage";
import {
  hasUnseenNews,
  readLastRaidSeen,
  readNewsSeen,
  writeLastRaidSeen,
  writeNewsSeen,
  type NewsSeen,
} from "@/lib/lobby/news-seen";
import { unlocksBetween } from "@/lib/lobby/levels";
import { LATEST_POST_ID } from "@/content/news";
import { playUi } from "@/game/audio/ui-sounds";
import { BattleScreen } from "@/components/battle-screen";
import type { RoomExit } from "@/lib/room-exit";
import { GuestPlayDialog } from "@/components/guest-play-dialog";
import { GearStrip, loadoutOf } from "./gear-strip";
import { HeroStage, armorLevelOf } from "./hero-stage";
import { LastRaidCard } from "./last-raid-card";
import { LevelUpModal } from "./level-up-modal";
import { LobbyBackdrop } from "./lobby-backdrop";
import { MenuTopBar } from "./menu-top-bar";
import { MobileDock } from "./mobile-dock";
import { MoreSheet } from "./more-sheet";
import { Panel, type PanelVariant } from "./panel";
import { PlayButton, PlayMiniChip } from "./play-button";
import { PlayController, type BattleStart, type RetryRequest } from "./play-controller";
import { SideButton, MENU_ICONS } from "./side-button";
import { SignInSheet } from "./sign-in-sheet";
import { MenuToast } from "./toast";
import { WorldCard } from "./world-card";
import { InventoryPanel } from "./panels/inventory-panel";
import { ShopPanel } from "./panels/shop-panel";
import { InfoPanel } from "./panels/info-panel";
import { NewsPanel } from "./panels/news-panel";
import { LeaderboardsPanel } from "./panels/leaderboards-panel";

const VARIANT: Record<LobbyPanel, PanelVariant> = {
  inventory: "screen",
  shop: "screen",
  info: "drawer-left",
  news: "drawer-right",
  leaderboards: "drawer-right-wide",
};

/** "Settling your last raid…" (exit_settling): re-join after this long, at most this many times. */
const SETTLE_RETRY_MS = 2_000;
const SETTLE_RETRIES = 5;

/** The level-up modal only celebrates a raid that ended this recently (not an old one on a first visit). */
const LEVEL_UP_FRESH_MS = 60 * 60_000;

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * /play (WORLD v6 spec §6): the full-screen main menu, or the battle. The menu stays mounted (hidden)
 * during a battle so its state survives (armed flag, XP bar baseline for the after-raid fill); the
 * lobby data pauses meanwhile. Rendered on the client only: every line of it depends on the
 * session and the clock.
 */
export function MainMenu({ initialPanel }: { initialPanel: PanelState }) {
  const { user } = useSession();
  const [rawStage, setStage] = useState<PlayStage>({ kind: "menu" });
  /** A raid holds the signed ticket of whoever started it; after a sign-out it is dropped. */
  const stage = stageForUser(rawStage, user?.id);
  const stale = stage !== rawStage;
  useEffect(() => {
    if (stale) setStage({ kind: "menu" });
  }, [stale]);

  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const battle = user && stage.kind === "battle" ? stage : null;
  const onBattle = useCallback((b: BattleStart) => setStage({ kind: "battle", ...b }), []);
  const settleTries = useRef(0);
  const onLeave = useCallback(() => {
    settleTries.current = 0;
    setStage({ kind: "menu" });
  }, []);
  // The room refused the join with a retry reason: back to the menu, which joins again with a fresh
  // ticket (exit_settling: after 2 s, at most 5 times; then the battle screen's Back stays).
  const [retry, setRetry] = useState<RetryRequest | null>(null);
  const onRetry = useCallback((exit: RoomExit) => {
    if (exit.code === "exit_settling") {
      if (settleTries.current >= SETTLE_RETRIES) return;
      settleTries.current++;
    } else {
      settleTries.current = 0;
    }
    setStage({ kind: "menu" });
    setRetry({ seq: Date.now() + Math.random(), delayMs: exit.code === "exit_settling" ? SETTLE_RETRY_MS : 0 });
  }, []);

  return (
    <LobbyProvider active={!battle}>
      {mounted ? (
        <MenuScreen initialPanel={initialPanel} hidden={Boolean(battle)} onBattle={onBattle} retry={retry} />
      ) : (
        <div className="relative h-[100dvh] overflow-hidden bg-[#090b08]" aria-busy="true">
          <LobbyBackdrop />
        </div>
      )}
      {battle && user && (
        <BattleScreen
          key={`${battle.roomId}:${battle.ticket.entryId ?? battle.ticket.issuedAt}`}
          ticket={battle.ticket}
          battleRoomId={battle.roomId}
          nickname={user.nickname}
          onLeave={onLeave}
          onRetry={onRetry}
        />
      )}
    </LobbyProvider>
  );
}

function MenuScreen({
  initialPanel,
  hidden,
  onBattle,
  retry,
}: {
  initialPanel: PanelState;
  hidden: boolean;
  onBattle: (b: BattleStart) => void;
  retry: RetryRequest | null;
}) {
  const lobby = useLobby();
  const { sessionKind, registered, stash, status, me, reloadMe, reloadStatus, refreshSession, toast } = lobby;

  // ---- panels (URL state through the native history API: Next keeps useSearchParams in sync)
  const sp = useSearchParams();
  const panel = useMemo(() => (sp ? parseLobbyPanel(new URLSearchParams(sp.toString())) : initialPanel), [sp, initialPanel]);
  const pushed = useRef(false);
  const opener = useRef<HTMLElement | null>(null);

  const openPanel = useCallback(
    (p: LobbyPanel, tab?: string) => {
      const active = document.activeElement;
      // Switching panels (hotkey, link) from inside an open panel keeps the button that opened the
      // first one: the focused element inside the old panel unmounts with it.
      if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="dialog"]')) opener.current = active;
      const href = panelHref({ panel: p, tab });
      if (panel.panel) {
        window.history.replaceState(null, "", href);
      } else {
        window.history.pushState(null, "", href);
        pushed.current = true;
      }
      playUi("click");
    },
    [panel.panel],
  );
  const closePanel = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, "", "/play");
    }
  }, []);
  // Links inside a panel to another panel or tab (Shop · Traders, Equip in loadout, …): replace the
  // panel's history entry like setTab does. A Next <Link> would push a second entry that the menu does
  // not track, and × / Esc would then need two presses (the first one reopening the previous panel).
  const onPanelLinkCapture = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname !== "/play") return;
      e.preventDefault(); // Next's Link skips its own navigation for a prevented click
      const next = parseLobbyPanel(url.searchParams);
      if (next.panel) window.history.replaceState(null, "", panelHref(next));
      else closePanel();
    },
    [closePanel],
  );
  const setTab = useCallback(
    (tab: string) => {
      if (!panel.panel) return;
      window.history.replaceState(null, "", panelHref({ panel: panel.panel, tab, period: panel.period }));
    },
    [panel.panel, panel.period],
  );
  const setPeriod = useCallback(
    (period: LbPeriod) => {
      if (panel.panel !== "leaderboards") return;
      window.history.replaceState(null, "", panelHref({ panel: "leaderboards", tab: panel.tab, period }));
    },
    [panel.panel, panel.tab],
  );

  // Closed (× / Esc / Back): forget the push and return focus to the button that opened it.
  const wasOpen = useRef(panel.panel !== null);
  useEffect(() => {
    const open = panel.panel !== null;
    if (wasOpen.current && !open) {
      pushed.current = false;
      const el = opener.current;
      opener.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    }
    wasOpen.current = open;
  }, [panel.panel]);

  // ---- sheets and modals
  const [signIn, setSignIn] = useState(false);
  const [guest, setGuest] = useState(false);
  const [more, setMore] = useState(false);

  // ---- news dot
  const [newsSeen, setNewsSeen] = useState<NewsSeen | null>(null);
  useEffect(() => setNewsSeen(readNewsSeen()), []);
  const bossEventAt = status?.boss ? worldCycleOf(status.cycle).startAt : null;
  const newsDot = hasUnseenNews(newsSeen, LATEST_POST_ID, bossEventAt);
  useEffect(() => {
    if (panel.panel !== "news") return;
    const s: NewsSeen = { patch: LATEST_POST_ID, event: Math.max(Date.now(), bossEventAt ?? 0) };
    writeNewsSeen(s);
    setNewsSeen(s);
  }, [panel.panel, bossEventAt]);

  // ---- after a raid: refresh everything; the last-raid card and the level-up modal
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) {
      void stash.reload();
      void reloadMe();
      void reloadStatus();
    }
    wasHidden.current = hidden;
  }, [hidden, stash, reloadMe, reloadStatus]);

  const [lastSeen, setLastSeen] = useState<string | null | undefined>(undefined);
  useEffect(() => setLastSeen(readLastRaidSeen()), []);
  const lastRaid = me?.lastRaid ?? null;
  const showCard = lastRaid !== null && lastSeen !== undefined && lastRaid.entryId !== lastSeen;
  const dismissCard = useCallback(() => {
    if (!lastRaid) return;
    writeLastRaidSeen(lastRaid.entryId);
    setLastSeen(lastRaid.entryId);
  }, [lastRaid]);
  const [levelUpDone, setLevelUpDone] = useState<string | null>(null);
  const levelUp =
    showCard &&
    lastRaid.level > lastRaid.levelBefore &&
    levelUpDone !== lastRaid.entryId &&
    Date.now() - lastRaid.at < LEVEL_UP_FRESH_MS
      ? lastRaid
      : null;

  // ---- hotkeys: I, B, L, N, H (desktop, not while typing, not over a sheet or modal)
  const blocked = panel.panel !== null || signIn || guest || more || levelUp !== null;
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.defaultPrevented) return;
      if (isTypingTarget(e.target)) return;
      const p = PANEL_HOTKEYS[e.code];
      if (!p) return;
      if (signIn || guest || more || levelUp) return;
      // A dialog inside a panel (sell dialog) owns the keyboard.
      if (document.querySelector('[role="dialog"] [role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      if (panel.panel === p) closePanel();
      else openPanel(p);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hidden, panel.panel, signIn, guest, more, levelUp, openPanel, closePanel]);

  // ---- battle: close panels first, so the menu comes back clean
  const startBattle = useCallback(
    (b: BattleStart) => {
      if (panel.panel) {
        pushed.current = false;
        window.history.replaceState(null, "", "/play");
      }
      setMore(false);
      onBattle(b);
    },
    [panel.panel, onBattle],
  );

  const locked = (what: "Friends" | "Guilds") => {
    playUi("error");
    toast(`${what} are coming soon`);
  };

  const s = stash.data;
  const entries = registered ? loadoutOf(s) : [];
  const armor = armorLevelOf(entries);

  const panelBody = (() => {
    switch (panel.panel) {
      case "inventory":
        return <InventoryPanel tab={panel.tab ?? "loadout"} onDone={closePanel} />;
      case "shop":
        return <ShopPanel tab={panel.tab ?? "market"} />;
      case "info":
        return <InfoPanel tab={panel.tab ?? "howto"} />;
      case "news":
        return <NewsPanel tab={panel.tab ?? "feed"} />;
      case "leaderboards":
        return <LeaderboardsPanel board={(panel.tab ?? "level") as LeaderboardBoard} period={panel.period ?? "week"} onPeriod={setPeriod} />;
      default:
        return null;
    }
  })();

  return (
    <PlayController onBattle={startBattle} onSignIn={() => setSignIn(true)} retry={retry}>
      <div className={clsx("relative h-[100dvh] overflow-hidden bg-[#090b08] text-white", hidden && "hidden")}>
        <LobbyBackdrop />
        <div className="relative z-10 flex h-full flex-col" inert={blocked}>
          <MenuTopBar onCredits={() => openPanel("shop", "traders")} />
          {/* Landscape phones (≤ 500 px tall, also below 768 px wide): the side columns instead of the
              dock, smaller tiles and a compact centre so the gear strip and PLAY both fit. */}
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[6.5rem_1fr_6.5rem] lg:grid-cols-[8.5rem_1fr_8.5rem] min-[1440px]:grid-cols-[9.5rem_1fr_9.5rem] [@media(max-height:500px)]:grid-cols-[5.5rem_1fr_5.5rem]">
            <nav aria-label="Prepare" className="hidden flex-col items-center gap-3 overflow-y-auto pb-4 pt-5 md:flex [@media(max-height:500px)]:flex [@media(max-height:500px)]:gap-2 [@media(max-height:500px)]:py-2">
              <SideButton label="Inventory" icon={MENU_ICONS.inventory} hotkey="I" active={panel.panel === "inventory"} onClick={() => openPanel("inventory")} />
              <SideButton label="Shop" icon={MENU_ICONS.shop} hotkey="B" active={panel.panel === "shop"} onClick={() => openPanel("shop")} />
              <SideButton label="Info" icon={MENU_ICONS.info} hotkey="H" active={panel.panel === "info"} onClick={() => openPanel("info")} />
            </nav>

            {/* ≤ 640 px tall the hero is hidden: three rows (world, gear in the flexible one, PLAY), and
                the column scrolls instead of stacking PLAY over the gear strip if it still overflows. */}
            <main className="relative grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto_auto_auto] gap-3 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:gap-4 md:px-4 md:pb-6 md:pt-5 [@media(max-height:640px)]:grid-rows-[auto_minmax(min-content,1fr)_auto] [@media(max-height:640px)]:overflow-y-auto [@media(max-height:500px)]:gap-2 [@media(max-height:500px)]:pb-[calc(0.5rem+env(safe-area-inset-bottom))] [@media(max-height:500px)]:pt-2">
              <h1 className="sr-only">Main menu</h1>
              <WorldCard />
              <HeroStage armor={armor} />
              <div className="min-w-0 [@media(max-height:640px)]:self-end">
              <GearStrip
                stash={s}
                stashError={stash.error}
                guest={sessionKind === "guest"}
                signedIn={sessionKind !== "anon"}
                onEdit={() => openPanel("inventory", "loadout")}
                onStarter={() => openPanel("inventory", "stash")}
                onRetry={() => void stash.reload()}
              />
              </div>
              <MobileDock
                active={panel.panel}
                newsDot={newsDot}
                moreOpen={more}
                onMore={() => setMore(true)}
                onPanel={(p) => openPanel(p)}
              />
              <PlayButton onFixInventory={() => openPanel("inventory", "loadout")} />
              {showCard && (
                <div className="absolute bottom-44 left-3 z-10 hidden max-h-[calc(100%-16rem)] w-60 overflow-y-auto lg:block">
                  <LastRaidCard raid={lastRaid} onDismiss={dismissCard} />
                </div>
              )}
            </main>

            <nav aria-label="World" className="hidden flex-col items-center gap-3 overflow-y-auto pb-4 pt-5 md:flex [@media(max-height:500px)]:flex [@media(max-height:500px)]:gap-2 [@media(max-height:500px)]:py-2">
              <SideButton label="News" icon={MENU_ICONS.news} hotkey="N" dot={newsDot} active={panel.panel === "news"} onClick={() => openPanel("news")} />
              <SideButton
                label="Leaderboards"
                icon={MENU_ICONS.leaderboards}
                hotkey="L"
                active={panel.panel === "leaderboards"}
                onClick={() => openPanel("leaderboards")}
              />
              <SideButton label="Friends" icon={MENU_ICONS.friends} locked onClick={() => locked("Friends")} />
              <SideButton label="Guilds" icon={MENU_ICONS.guilds} locked onClick={() => locked("Guilds")} />
            </nav>
          </div>

          {showCard && (
            <div className="fixed inset-x-2 bottom-[calc(10.5rem+env(safe-area-inset-bottom))] z-30 max-h-[55vh] overflow-y-auto md:inset-x-auto md:bottom-36 md:left-[7.5rem] md:w-72 lg:hidden [@media(max-height:500px)]:inset-x-auto [@media(max-height:500px)]:bottom-[4.75rem] [@media(max-height:500px)]:left-[6.5rem] [@media(max-height:500px)]:max-h-[calc(100dvh-8.75rem)] [@media(max-height:500px)]:w-72">
              <LastRaidCard raid={lastRaid} onDismiss={dismissCard} />
            </div>
          )}
        </div>

        {panel.panel && (
          <Panel
            key={panel.panel}
            title={PANEL_LABEL[panel.panel]}
            variant={VARIANT[panel.panel]}
            tabs={PANEL_TABS[panel.panel]}
            tab={panel.tab ?? PANEL_TABS[panel.panel][0]}
            onTab={setTab}
            onClose={closePanel}
            headerExtra={panel.panel === "inventory" ? undefined : <PlayMiniChip />}
          >
            <div className="contents" onClickCapture={onPanelLinkCapture}>
              {panelBody}
            </div>
          </Panel>
        )}

        {more && (
          <MoreSheet
            onClose={() => setMore(false)}
            onInfo={() => {
              setMore(false);
              openPanel("info");
            }}
            onLocked={(w) => {
              setMore(false);
              locked(w);
            }}
          />
        )}
        {signIn && (
          <SignInSheet
            onClose={() => setSignIn(false)}
            onGuest={() => {
              setSignIn(false);
              setGuest(true);
            }}
          />
        )}
        <GuestPlayDialog
          open={guest}
          onClose={() => setGuest(false)}
          onSuccess={async () => {
            setGuest(false);
            await refreshSession();
          }}
        />
        {levelUp && (
          <LevelUpModal
            level={levelUp.level}
            unlocks={unlocksBetween(levelUp.levelBefore, levelUp.level, s?.market.sellUnlockLevel)}
            onClose={() => setLevelUpDone(levelUp.entryId)}
          />
        )}
        <MenuToast />
      </div>
    </PlayController>
  );
}
