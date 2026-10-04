import { REPLAY } from "@extract/shared";
import { db } from "@/db/client";
import { listReplays } from "@/lib/admin/replay";
import { requireAdminPage } from "@/lib/admin/server";
import { ReplayList } from "@/components/admin/replay-list";

export const dynamic = "force-dynamic";

const PAGE = 50;

/** /admin/replays: recorded world shard-cycles, newest first (open one for the viewer). */
export default async function AdminReplaysPage() {
  await requireAdminPage();
  const rows = await listReplays(db, { limit: PAGE });
  const last = rows.length >= PAGE ? rows.at(-1) : undefined;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Повторы</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-white/55">
          Каждый шард мира записывается целиком: кадр всех на карте каждые 200 мс, выстрелы, попадания, убийства, выходы, лут и
          вайп. Хранится {REPLAY.RETENTION_DAYS} дней, видят только админы. Для споров и разборов: открой карту, выбери игрока —
          камера пойдёт за ним, а список событий прыгает по времени.
        </p>
      </div>
      <ReplayList initial={rows} next={last ? { before: last.startedAt, beforeId: last.matchId } : null} now={Date.now()} />
    </div>
  );
}
