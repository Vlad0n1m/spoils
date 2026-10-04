import { TopBar } from "@/components/top-bar";
import { WalletPanel } from "@/components/wallet-panel";
import { WalletLinkSection } from "@/components/wallet/wallet-link-card";
import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";

export const dynamic = "force-dynamic";

/**
 * Wallet: the custodial market balance (WalletPanel) and, below it, the self-custody Solana wallet
 * linked to the account by Sign-In with Solana (identity only, registered users).
 */
export default function WalletPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08] text-white">
      <ZooaAmbientBg />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <main className="relative flex-1">
          <WalletPanel />
          <WalletLinkSection />
        </main>
      </div>
    </div>
  );
}
