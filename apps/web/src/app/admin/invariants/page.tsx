import { db } from "@/db/client";
import type { InvariantCheckResult, InvariantRunRow } from "@/db/schema";
import { latestInvariantRuns } from "@/lib/admin/invariants";
import { requireAdminPage } from "@/lib/admin/server";
import { Panel, utcText } from "../ui";
import { RunInvariantsButton } from "./run-button";

export const dynamic = "force-dynamic";

const STATUS: Record<InvariantCheckResult["status"], { text: string; cls: string }> = {
  ok: { text: "норма", cls: "bg-emerald-400/15 text-emerald-300" },
  fail: { text: "расхождение", cls: "bg-red-500/20 text-red-300" },
  error: { text: "ошибка", cls: "bg-amber-400/15 text-amber-300" },
};

const TRIGGER: Record<string, string> = { cron: "ночной крон", admin: "вручную", test: "тест" };

/** /admin/invariants: the latest invariant run (B6) with failures and sample ids, and the run history. */
export default async function AdminInvariantsPage() {
  await requireAdminPage();
  let runs: InvariantRunRow[] | null = null;
  try {
    runs = await latestInvariantRuns(db, 10);
  } catch (e) {
    console.error("[admin] invariant runs failed", e);
  }
  const last = runs?.[0] ?? null;
  const checks = last ? [...last.checks].sort((a, b) => Number(a.status === "ok") - Number(b.status === "ok")) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold md:text-3xl">Сверка инвариантов</h1>
          <p className="mt-2 max-w-[70ch] text-sm leading-relaxed text-white/60">
            Каждую ночь (02:40 UTC) проверяем, что каждая вещь в одном месте и её состояние совпадает с журналом, CR и
            деньги игроков сходятся с журналами, а казна только получает. Проверки только читают базу. При расхождении —
            строка <code>[invariants] FAILED</code> в логах и сообщение на <code>ALERT_WEBHOOK_URL</code>.
          </p>
        </div>
        <RunInvariantsButton />
      </div>

      {runs === null ? (
        <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">Прогоны не загрузились, см. логи сервера.</p>
      ) : !last ? (
        <p className="rounded-xl border border-white/10 bg-[#141925] p-4 text-sm text-white/60">Прогонов ещё не было. Нажмите «Проверить сейчас».</p>
      ) : (
        <>
          <div
            className={`rounded-xl border p-4 text-sm ${last.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : "border-red-400/40 bg-red-500/15 text-red-100"}`}
          >
            <p className="text-base font-bold">
              {last.ok ? "Все проверки в норме" : `Не сошлось: ${last.failed} из ${last.checks.length}`}
            </p>
            <p className="mt-1 text-xs opacity-80">
              {utcText(last.startedAt.getTime())} · {TRIGGER[last.trigger] ?? last.trigger} · {last.durationMs} мс
            </p>
          </div>

          <Panel title="Последний прогон" aside="до 10 примеров на проверку">
            <ul className="divide-y divide-white/10">
              {checks.map((c) => (
                <li key={c.key} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS[c.status].cls}`}>{STATUS[c.status].text}</span>
                    <span className="text-sm font-semibold text-white">{c.title}</span>
                    <code className="text-xs text-white/40">{c.key}</code>
                    <span className="ml-auto text-xs tabular-nums text-white/45">
                      {c.status === "fail" ? `${c.count.toLocaleString("ru-RU")} шт. · ` : ""}
                      {c.ms} мс
                    </span>
                  </div>
                  {c.detail ? <p className="mt-1 break-words text-xs text-white/55">{c.detail}</p> : null}
                  {c.sample.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-1.5">
                      {c.sample.map((id) => (
                        <li key={id}>
                          <code className="block break-all rounded bg-white/[0.06] px-1.5 py-0.5 text-[0.7rem] text-white/75">{id}</code>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="История">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-sm">
                <thead className="text-xs text-white/45">
                  <tr>
                    <th className="py-1.5 pr-3 font-normal">Начало (UTC)</th>
                    <th className="py-1.5 pr-3 font-normal">Запуск</th>
                    <th className="py-1.5 pr-3 font-normal">Итог</th>
                    <th className="py-1.5 font-normal">Время</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3 tabular-nums text-white/80">{utcText(r.startedAt.getTime())}</td>
                      <td className="py-1.5 pr-3 text-white/60">{TRIGGER[r.trigger] ?? r.trigger}</td>
                      <td className={`py-1.5 pr-3 ${r.ok ? "text-emerald-300" : "text-red-300"}`}>
                        {r.ok ? "норма" : `${r.failed} не сошлось: ${r.checks.filter((c) => c.status !== "ok").map((c) => c.key).join(", ")}`}
                      </td>
                      <td className="py-1.5 tabular-nums text-white/50">{r.durationMs} мс</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
