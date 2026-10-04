import { db } from "@/db/client";
import { readAdminParams } from "@/lib/admin/params";
import { requireAdminPage } from "@/lib/admin/server";
import type { AdminParamsDto } from "@/lib/admin/types";
import { ParamsEditor } from "./params-editor";

export const dynamic = "force-dynamic";

/** /admin/params: stop-cranes over the existing economy_params rows, with confirm and audit. */
export default async function AdminParamsPage() {
  await requireAdminPage();
  let dto: AdminParamsDto | null = null;
  try {
    dto = await readAdminParams(db);
  } catch (e) {
    console.error("[admin] params failed", e);
  }
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold md:text-3xl">Стоп-краны</h1>
        <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-white/60">
          Рычаги экономики из <code>economy_params</code>, которые читает живой код World v6. Каждое изменение — после
          подтверждения, с записью в журнал (кто, когда, было → стало). Цены руками не держим: только эти рычаги
          (ALPHA_PLAN §4).
        </p>
      </div>
      {dto ? (
        <ParamsEditor initial={dto} />
      ) : (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">Параметры не загрузились, см. логи сервера.</p>
      )}
    </div>
  );
}
