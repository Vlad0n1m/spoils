import { NextResponse } from "next/server";
import { coreEnv, isCronAuthorized } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * On-chain deposit scanning (previously Solana) is disabled until top-ups are
 * implemented as incoming transfers from any supported wallet, credited in cents.
 */
export async function GET(req: Request) {
  if (!isCronAuthorized(req.headers.get("authorization"), coreEnv().CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    status: "deposits_disabled",
    message: "Deposit crediting is not enabled yet. Future: transfer crypto, credited as USD cents.",
  });
}
