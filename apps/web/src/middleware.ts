import { NextResponse, type NextRequest } from "next/server";
import { checkApiMutation } from "./lib/request-guard";

/**
 * CSRF guard of every state-changing /api route (lib/request-guard.ts checkApiMutation): a
 * cross-site or foreign-Origin POST/PUT/PATCH/DELETE is 403, a form body type 415. Needed in the
 * iDos edition, whose session cookie is SameSite=None; harmless in the main build, where the app
 * only ever calls its API from its own pages. Game server and cron routes are left to their own
 * HMAC / Bearer checks.
 */
export function middleware(req: NextRequest) {
  const blocked = checkApiMutation(req, req.nextUrl.pathname);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status, headers: { "Cache-Control": "no-store" } });
  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
