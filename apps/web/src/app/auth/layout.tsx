import type { Metadata } from "next";
import { TopBar } from "@/components/top-bar";
import { ZooaAmbientBg } from "@/components/zooa-ambient-bg";

export const metadata: Metadata = {
  title: "Account — ZOOA",
  description: "Sign in or create a ZOOA account",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] flex-col overflow-hidden bg-[#090b08] text-white">
      <ZooaAmbientBg />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <TopBar />
        <main className="relative flex-1">{children}</main>
      </div>
    </div>
  );
}
