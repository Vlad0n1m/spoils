"use client";

import { useEffect } from "react";
import { useLobby } from "@/lib/lobby/lobby-context";
import { panelHref } from "@/lib/lobby/panels";
import { LoadoutBoard } from "@/components/lobby/loadout-board";
import { StashPage } from "@/components/lobby/stash-page";
import { Gate, StashWait } from "./gate";

/**
 * Inventory (WORLD v6 spec §6.3): Loadout (the board; its button saves and closes the panel) and
 * Stash (StashPage; the junker moved to Shop · Traders). The stash is refetched when the panel
 * opens so a purchase elsewhere shows up here.
 */
export function InventoryPanel({ tab, onDone }: { tab: string; onDone: () => void }) {
  const { registered, sessionLoading, sessionKind, stash } = useLobby();
  const { reload } = stash;
  useEffect(() => {
    if (registered) void reload();
  }, [registered, reload]);

  if (!registered) {
    return <Gate loading={sessionLoading} guest={sessionKind === "guest"} next={panelHref({ panel: "inventory", tab })} />;
  }
  if (!stash.data) return <StashWait error={stash.error} onRetry={() => void reload()} />;
  return tab === "stash" ? <StashPage res={stash} /> : <LoadoutBoard stash={stash.data} reload={reload} onDone={onDone} />;
}
