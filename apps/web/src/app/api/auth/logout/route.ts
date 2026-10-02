import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { checkSameOriginRequest } from "@/lib/request-guard";

export async function POST(req: Request) {
  const blocked = checkSameOriginRequest(req, { json: false });
  if (blocked) return NextResponse.json({ error: blocked.error }, { status: blocked.status });
  const session = await getSession();
  session.destroy();
  return NextResponse.json({ ok: true });
}
