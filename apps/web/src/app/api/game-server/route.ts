import { NextRequest, NextResponse } from "next/server";

/** ISO 3166-1 alpha-2 (uppercase). */
const CC_RE = /^[A-Z]{2}$/;

function defaultGameServerUrl() {
  return process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "ws://localhost:2567";
}

function parseCountryMap(): Record<string, string> {
  const raw = process.env.GAME_SERVER_URL_BY_COUNTRY?.trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (CC_RE.test(k) && typeof v === "string" && v.length > 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function countryFromRequest(req: NextRequest) {
  return (
    req.headers.get("x-vercel-ip-country")?.toUpperCase() ||
    req.headers.get("cf-ipcountry")?.toUpperCase() ||
    undefined
  );
}

/**
 * Picks the Colyseus WebSocket URL: optional `?cc=KZ` (if present in
 * GAME_SERVER_URL_BY_COUNTRY), else geo from edge headers, else default.
 */
export function GET(req: NextRequest) {
  const byCountry = parseCountryMap();
  const fallback = defaultGameServerUrl();

  const paramCc = req.nextUrl.searchParams.get("cc")?.toUpperCase();
  if (paramCc && CC_RE.test(paramCc) && byCountry[paramCc]) {
    return NextResponse.json(
      { url: byCountry[paramCc]! },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const rawGeo = countryFromRequest(req);
  const geo = rawGeo && CC_RE.test(rawGeo) ? rawGeo : undefined;
  if (geo && byCountry[geo]) {
    return NextResponse.json(
      { url: byCountry[geo]! },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { url: fallback },
    { headers: { "Cache-Control": "no-store" } },
  );
}
