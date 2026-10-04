import { notFound } from "next/navigation";
import { db } from "@/db/client";
import { readReplay } from "@/lib/admin/replay";
import { requireAdminPage } from "@/lib/admin/server";
import { ReplayViewer } from "@/components/admin/replay-viewer";

export const dynamic = "force-dynamic";

/** /admin/replays/:matchId: the replay viewer of one shard-cycle (chunks load in the browser). */
export default async function AdminReplayPage({ params }: { params: Promise<{ matchId: string }> }) {
  await requireAdminPage();
  const { matchId } = await params;
  const r = await readReplay(db, matchId);
  if (!r) notFound();
  return <ReplayViewer replay={r.replay} chunks={r.chunks} now={Date.now()} />;
}
