"use client";

import { ControlsSection, PlayerInstructions, RulesSection } from "@/components/play-instructions";

/** Info (WORLD v6 spec §6.3): How to play, Rules (currencies, risk, XP table), Controls. */
export function InfoPanel({ tab }: { tab: string }) {
  if (tab === "rules") return <RulesSection />;
  if (tab === "controls") return <ControlsSection />;
  return <PlayerInstructions />;
}
