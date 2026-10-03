import { Suspense } from "react";
import type { Metadata } from "next";
import { MainMenu } from "@/components/menu/main-menu";
import { BRAND } from "@/lib/brand";
import { parseLobbyPanel } from "@/lib/lobby/panels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `${BRAND.name} — ${BRAND.mapName}`,
  description: "One always-live map, wiped every 45 minutes. Drop in, loot up, get out alive.",
};

/**
 * WORLD v6 main menu (spec §6): full screen, panels selected by `?panel=&tab=&period=` (legacy
 * `?tab=` links still land on the right panel).
 */
export default async function PlayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const initialPanel = parseLobbyPanel(await searchParams);
  // useSearchParams lives inside: the boundary keeps any static render path legal.
  return (
    <Suspense fallback={<div className="h-[100dvh] bg-[#090b08]" aria-busy="true" />}>
      <MainMenu initialPanel={initialPanel} />
    </Suspense>
  );
}
