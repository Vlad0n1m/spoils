import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Payouts will be wired to crypto transfers from a central wallet; not active yet.
 */
export async function POST() {
  return NextResponse.json(
    {
      error: "withdrawals_coming_soon",
      message: "Fiat / crypto withdrawal is not enabled yet. Balance is tracked in US cents in-game.",
    },
    { status: 501 },
  );
}
