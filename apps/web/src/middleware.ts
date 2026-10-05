import { NextResponse, type NextRequest } from "next/server";
import { editionBlock } from "./lib/edition";
import { checkApiMutation, editionCorsHeaders } from "./lib/request-guard";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * 1. Edition gate (lib/edition.ts editionBlock): the iDos edition answers 404 on the SOL economy's API
 *    (market, wallet, withdraw, starter-kit sale, economy stats) and sends its pages (/wallet,
 *    /economy) to /play; the main build answers 404 on the edition-only /api/idos bridge. Server-side,
 *    so a hidden button is never the only barrier.
 * 2. CSRF guard of every state-changing /api route (lib/request-guard.ts checkApiMutation): a
 *    cross-site or foreign-Origin POST/PUT/PATCH/DELETE is 403, a form body type 415. Needed in the
 *    iDos edition, whose session cookie is SameSite=None; harmless in the main build, where the app
 *    only ever calls its API from its own pages. Game server and cron routes are left to their own
 *    HMAC / Bearer checks.
 * The /wallet and /economy matchers only feed the edition gate; in the main build those pages pass
 * through untouched.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const gate = editionBlock(pathname);
  if (gate === "api") return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });
  if (gate === "page") return NextResponse.redirect(new URL("/play", req.url), { status: 307, headers: NO_STORE });
  if (!pathname.startsWith("/api/")) return NextResponse.next();
  // 3. iDos edition: CORS for our client on the iDos title subdomains (request-guard.ts); none elsewhere.
  const cors = editionCorsHeaders(req.headers.get("origin"));
  if (cors && req.method === "OPTIONS") return new NextResponse(null, { status: 204, headers: cors });
  const blocked = checkApiMutation(req, pathname);
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status, headers: { ...NO_STORE, ...cors } });
  return NextResponse.next(cors ? { headers: cors } : undefined);
}

export const config = {
  matcher: ["/api/:path*", "/wallet/:path*", "/economy/:path*"],
};
