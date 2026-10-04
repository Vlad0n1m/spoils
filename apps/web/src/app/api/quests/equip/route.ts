import type { WearableKind } from "@extract/shared";
import { db } from "@/db/client";
import { json, readJson } from "@/lib/lobby/route-helpers";
import { equipCosmetic } from "@/lib/quests/quests";
import { questCaller, questError } from "@/lib/quests/route";

export const dynamic = "force-dynamic";

const KINDS: readonly WearableKind[] = ["title", "color", "frame", "skin"];

/**
 * POST /api/quests/equip `{ kind: "title" | "color" | "frame" | "skin", id: string | null }`: wear an
 * unlocked level, task-mark or granted (Alpha Pass) reward (null takes it off). 200 `{ ok, equipped }`; 403 locked.
 */
export async function POST(req: Request) {
  const who = await questCaller({ limit: true });
  if ("res" in who) return who.res;
  const body = (await readJson(req)) as { kind?: unknown; id?: unknown } | null;
  const kind = body?.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return questError("bad_body");
  const id = body?.id;
  if (id !== null && (typeof id !== "string" || id.length > 40)) return questError("bad_body");
  try {
    const r = await equipCosmetic(db, who.userId, kind as WearableKind, id);
    if (!r.ok) return questError(r.code);
    return json({ ok: true, equipped: r.equipped });
  } catch (e) {
    console.error("[quests] equip failed", e);
    return questError("internal");
  }
}
