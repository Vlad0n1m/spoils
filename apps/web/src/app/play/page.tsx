import { TopBar } from "@/components/top-bar";
import { PlayClient } from "@/components/play-client";
import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";

export const dynamic = "force-dynamic";

export default function PlayPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08] text-white">
      <ZooaAmbientBg />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <main className="relative flex-1">
          <PlayClient />
        </main>
      </div>
    </div>
  );
}
