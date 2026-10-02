import { db } from "@/db/client";
import { getDraft, saveDraft } from "@/lib/inventory/loadout";
import { entriesSchema } from "@/lib/lobby/join";
import { apiError, caller, json, readJson, registeredOnly } from "@/lib/lobby/route-helpers";
import type { DraftResponse } from "@/lib/lobby/api-types";

export const dynamic = "force-dynamic";

export async function GET() {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  return json<DraftResponse>({ entries: (await getDraft(db, c.userId)) ?? [] });
}

/** Loadout page autosave. Only the shape is checked here; contents are validated at lock. */
export async function PUT(req: Request) {
  const c = await caller();
  const deny = registeredOnly(c);
  if (deny || c.kind !== "user") return deny!;
  const body = (await readJson(req)) as { entries?: unknown } | null;
  const parsed = entriesSchema.safeParse(body?.entries);
  if (!parsed.success) return apiError(400, "bad_body", "Loadout data is malformed.");
  await saveDraft(db, c.userId, parsed.data);
  return json<DraftResponse>({ entries: parsed.data });
}
