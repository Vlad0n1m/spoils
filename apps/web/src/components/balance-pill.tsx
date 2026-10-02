"use client";

import { useSession } from "@/lib/session-context";
import { formatUsdCents } from "@/lib/format-money";

export function BalancePill() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-xs text-zooa-lime/90">
      {formatUsdCents(user.balanceCents)}
    </span>
  );
}
