"use client";

import { SessionProvider } from "@/lib/session-context";

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
