"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminAuditEntry, AdminParam, AdminParamSetResult, AdminParamsDto } from "@/lib/admin/types";

/** UTC on purpose: the same text on the server render and in the browser. */
function utcText(ms: number | null | undefined): string {
  if (!ms) return "—";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/** Parses what the admin typed ("1,1" works too). Null when it is not a valid value of `p`. */
function parseDraft(p: AdminParam, text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  if (!Number.isFinite(v) || v < p.min || v > p.max) return null;
  if (p.kind === "int" && !Number.isInteger(v)) return null;
  return v;
}

interface Pending {
  param: AdminParam;
  value: number;
}

export function ParamsEditor({ initial }: { initial: AdminParamsDto }) {
  const router = useRouter();
  const [dto, setDto] = useState(initial);
  const [pending, setPending] = useState<Pending | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => setDto(initial), [initial]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (pending && !d.open) d.showModal();
    if (!pending && d.open) d.close();
  }, [pending]);

  function ask(param: AdminParam, value: number) {
    setFlash(null);
    setNote("");
    setPending({ param, value });
  }

  async function confirm() {
    if (!pending || busy) return;
    setBusy(true);
    const { param, value } = pending;
    try {
      const res = await fetch("/api/admin/params", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: param.key, value, expected: param.value, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as AdminParamSetResult | null;
      if (body && body.ok) {
        setDto((d) => ({
          ...d,
          params: d.params.map((p) => (p.key === body.param.key ? body.param : p)),
          audit: [body.audit, ...d.audit].slice(0, 50),
        }));
        setFlash({ ok: true, text: `${param.label}: ${show(body.audit.oldValue)} → ${show(body.audit.newValue)}. Записано в журнал.` });
        setPending(null);
        router.refresh();
      } else {
        setFlash({ ok: false, text: body && !body.ok ? body.message : `Не сохранилось (HTTP ${res.status}).` });
        setPending(null);
        if (body && !body.ok && body.error === "stale") router.refresh();
      }
    } catch {
      setFlash({ ok: false, text: "Сеть недоступна, ничего не изменилось." });
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {flash ? (
        <p
          role="status"
          className={`rounded-xl border p-3 text-sm ${flash.ok ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-200" : "border-red-400/30 bg-red-500/10 text-red-200"}`}
        >
          {flash.text}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {dto.params.map((p) => (
          <ParamCard key={`${p.key}:${p.value}:${p.updatedAt ?? 0}`} param={p} onAsk={ask} />
        ))}
      </div>

      <section className="rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5">
        <h2 className="text-base font-bold">Чего здесь нет</h2>
        <p className="mt-2 max-w-[75ch] text-sm leading-relaxed text-white/60">
          Денежные числа (цены, комиссии, размер раздачи, цена набора) из админки не меняются. Паузы рынка и продажи
          торгуемого набора — выше, как переключатели 0/1.
        </p>
      </section>

      <section className="rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5">
        <h2 className="text-base font-bold">Только чтение</h2>
        {dto.readOnly.length === 0 ? (
          <p className="mt-2 text-sm text-white/50">Других строк в economy_params нет.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-white/45">
                  <th className="py-1.5 font-normal">Ключ</th>
                  <th className="py-1.5 font-normal">Значение</th>
                  <th className="py-1.5 font-normal">Обновлено</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {dto.readOnly.map((r) => (
                  <tr key={r.key} className="align-top">
                    <td className="py-2 pr-3">
                      <code className="text-white/85">{r.key}</code>
                      <p className="mt-1 max-w-[40ch] text-xs leading-snug text-white/45">{r.note}</p>
                    </td>
                    <td className="break-all py-2 pr-3 font-mono text-xs text-white/75">{show(r.value)}</td>
                    <td className="whitespace-nowrap py-2 text-xs text-white/50">{utcText(r.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AuditTable audit={dto.audit} />

      <dialog
        ref={dialog}
        onClose={() => setPending(null)}
        aria-labelledby="admin-confirm-title"
        className="w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-white/15 bg-[#141925] p-0 text-white backdrop:bg-black/70"
      >
        {pending ? (
          <form
            method="dialog"
            className="font-body space-y-4 p-5 leading-normal"
            onSubmit={(e) => {
              e.preventDefault();
              void confirm();
            }}
          >
            <h2 id="admin-confirm-title" className="text-lg font-bold">
              Изменить «{pending.param.label}»?
            </h2>
            <p className="text-sm text-white/70">
              <code>{pending.param.key}</code>:{" "}
              <span className="tabular-nums text-white">{pending.param.value}</span> →{" "}
              <span className="tabular-nums font-bold text-zooa-lime">{pending.value}</span>
            </p>
            <p className="text-xs leading-relaxed text-white/50">
              Действует сразу для всех игроков. Изменение попадёт в журнал с вашим ником.
            </p>
            <label className="block text-sm">
              <span className="text-white/70">Причина (необязательно)</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 500))}
                rows={2}
                className="mt-1.5 w-full rounded-lg border border-white/15 bg-black/30 p-2 text-sm text-white outline-none focus:border-zooa-lime/60"
                placeholder="например: пул разбух, k → 1.25"
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                autoFocus
                onClick={() => setPending(null)}
                className="min-h-[44px] rounded-lg px-4 text-sm font-semibold text-white/75 hover:bg-white/5"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={busy}
                className="min-h-[44px] rounded-lg bg-zooa-lime px-4 text-sm font-bold text-black disabled:opacity-50"
              >
                {busy ? "Сохраняю…" : "Подтвердить"}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </div>
  );
}

function ParamCard({ param: p, onAsk }: { param: AdminParam; onAsk: (p: AdminParam, v: number) => void }) {
  const [draft, setDraft] = useState(String(p.value));
  const parsed = parseDraft(p, draft);
  const changed = parsed !== null && parsed !== p.value;
  const inputId = `param-${p.key}`;
  return (
    <section className="rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">{p.label}</h2>
          <code className="text-xs text-white/40">{p.key}</code>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tabular-nums text-zooa-lime">{p.value}</p>
          <p className="text-[0.7rem] text-white/45">{p.stored ? `изменено ${utcText(p.updatedAt)}` : "по умолчанию (строки нет)"}</p>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-white/60">{p.help}</p>
      <p className="mt-2 text-xs text-white/45">
        Допустимо {p.min}–{p.max}, по умолчанию {p.def}.
      </p>
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && parsed !== null) onAsk(p, parsed);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Новое значение
        </label>
        <input
          id={inputId}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          aria-invalid={parsed === null}
          className={`min-h-[44px] w-28 rounded-lg border bg-black/30 px-3 text-base tabular-nums text-white outline-none ${
            parsed === null ? "border-red-400/60" : "border-white/15 focus:border-zooa-lime/60"
          }`}
        />
        <button
          type="submit"
          disabled={!changed}
          className="min-h-[44px] rounded-lg bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-40"
        >
          Изменить…
        </button>
        {p.quick
          .filter((q) => q.value !== p.value)
          .map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => onAsk(p, q.value)}
              className="min-h-[44px] rounded-lg border border-white/15 px-3 text-sm text-white/80 hover:bg-white/5"
            >
              {q.label}
            </button>
          ))}
      </form>
      {parsed === null ? <p className="mt-1.5 text-xs text-red-300">Нужно число от {p.min} до {p.max}.</p> : null}
    </section>
  );
}

function AuditTable({ audit }: { audit: AdminAuditEntry[] }) {
  return (
    <section className="rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-bold">Журнал изменений</h2>
        <span className="text-xs text-white/45">последние 50, admin_audit</span>
      </div>
      {audit.length === 0 ? (
        <p className="mt-2 text-sm text-white/50">Изменений ещё не было.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-white/45">
                <th className="py-1.5 font-normal">Когда</th>
                <th className="py-1.5 font-normal">Кто</th>
                <th className="py-1.5 font-normal">Что</th>
                <th className="py-1.5 font-normal">Было → стало</th>
                <th className="py-1.5 font-normal">Причина</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {audit.map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="whitespace-nowrap py-2 pr-3 text-xs text-white/60">{utcText(a.at)}</td>
                  <td className="py-2 pr-3">{a.admin}</td>
                  <td className="py-2 pr-3">
                    <code className="text-xs">{a.target}</code>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums">
                    {show(a.oldValue)} → <span className="font-semibold text-zooa-lime">{show(a.newValue)}</span>
                  </td>
                  <td className="py-2 text-xs text-white/60">{a.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
