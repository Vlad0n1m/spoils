import { TopBar } from "@/components/top-bar";
import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";
import { LobbyShell } from "@/components/lobby/lobby-shell";
import { parseLobbyTab } from "@/lib/lobby/tabs";

export const dynamic = "force-dynamic";

/** Lobby: tabs Raid | Loadout | Stash | Market, selected by `?tab=` so every tab is linkable. */
export default async function PlayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const tab = parseLobbyTab((await searchParams).tab);
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08] text-white">
      <ZooaAmbientBg />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <main className="relative flex-1">
          <LobbyShell tab={tab} />
        </main>
      </div>
    </div>
  );
}
