import { TopBar } from "@/components/top-bar";
import { OnchainPanel } from "@/components/onchain/onchain-panel";
import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";

export const dynamic = "force-dynamic";

export const metadata = { title: "On chain" };

/** SPOILS on Solana: items in your wallet, the SOL market escrow and the wallet-paid starter kit. */
export default function OnchainPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08] text-white">
      <ZooaAmbientBg />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <OnchainPanel />
      </div>
    </div>
  );
}
