import { ALPHA_TROPHY, PASS, TESTER_TASKS, cosmeticDef } from "@extract/shared";
import { db } from "@/db/client";
import { requireAdminPage } from "@/lib/admin/server";
import { listBugReports, type BugReportRow } from "@/lib/pass/pass";
import { Panel } from "../ui";
import { TestersClient } from "./testers-client";

export const dynamic = "force-dynamic";

/** /admin/testers: bug reports of the Alpha Pass (accept / reject) and the end-of-alpha trophy. */
export default async function AdminTestersPage() {
  await requireAdminPage();
  let bugs: BugReportRow[] | null = null;
  try {
    bugs = await listBugReports(db, "open");
  } catch (e) {
    console.error("[admin] bug reports failed", e);
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Тестеры</h1>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-white/60">
          Alpha Pass: отчёты об ошибках из меню и трофей альфы. Принятый отчёт закрывает задание тестера «Report a bug»
          (+{TESTER_TASKS.find((t) => t.id === "bug")?.ap ?? 0} AP, один раз на игрока). Всё пишется в журнал админа. Награды — только косметика и не стираются вайпом.
        </p>
      </div>
      <Panel title="Трофей альфы" aside={cosmeticDef(ALPHA_TROPHY.reward)?.name}>
        <p className="text-sm leading-relaxed text-white/70">
          Правило: в конце альфы титул «{cosmeticDef(ALPHA_TROPHY.reward)?.name}» получают места 1–{ALPHA_TROPHY.top} (с
          равными) каждой таблицы за всё время: уровень, убийства, NPC. Нажимать после объявления итогов; повторное нажатие
          ничего не дублирует. Награда за приглашение (после {PASS.INVITE_RAIDS} рейдов друга) выдаётся сама.
        </p>
      </Panel>
      {bugs ? (
        <TestersClient initial={bugs} />
      ) : (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">Отчёты не загрузились, см. логи сервера.</p>
      )}
    </div>
  );
}
