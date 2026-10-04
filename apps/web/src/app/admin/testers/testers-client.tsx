"use client";

import { useState } from "react";
import type { BugReportRow } from "@/lib/pass/pass";
import { Panel } from "../ui";

async function post(body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> | null }> {
  try {
    const res = await fetch("/api/admin/testers", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { ok: false, json: null };
  }
}

/** Open bug reports with accept / reject, and the trophy button (confirmed first). */
export function TestersClient({ initial }: { initial: BugReportRow[] }) {
  const [bugs, setBugs] = useState(initial);
  const [busy, setBusy] = useState<number | "trophy" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmTrophy, setConfirmTrophy] = useState(false);

  const review = async (id: number, accept: boolean) => {
    setBusy(id);
    const r = await post({ action: "bug", id, accept });
    setBusy(null);
    if (r.ok || r.json?.error === "reviewed") setBugs((b) => b.filter((x) => x.id !== id));
    setNote(r.ok ? (accept ? `#${id} принят${r.json?.apGranted ? ", задание закрыто" : " (задание уже было закрыто)"}.` : `#${id} отклонён.`) : String(r.json?.message ?? "Ошибка."));
  };

  const trophies = async () => {
    setBusy("trophy");
    const r = await post({ action: "trophies" });
    setBusy(null);
    setConfirmTrophy(false);
    const granted = (r.json?.granted as string[] | undefined) ?? [];
    setNote(r.ok ? (granted.length ? `Трофей выдан: ${granted.join(", ")}.` : "Новых получателей нет.") : "Ошибка, см. логи.");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {!confirmTrophy ? (
          <button type="button" onClick={() => setConfirmTrophy(true)} className="min-h-[44px] rounded-lg bg-amber-400/15 px-4 text-sm font-semibold text-amber-200 hover:bg-amber-400/25">
            Выдать трофеи альфы…
          </button>
        ) : (
          <>
            <span className="text-sm text-white/70">Выдать титул топ-10 всех таблиц сейчас?</span>
            <button type="button" disabled={busy !== null} onClick={() => void trophies()} className="min-h-[44px] rounded-lg bg-amber-400 px-4 text-sm font-bold text-black disabled:opacity-60">
              Да, выдать
            </button>
            <button type="button" onClick={() => setConfirmTrophy(false)} className="min-h-[44px] rounded-lg px-4 text-sm text-white/70 hover:bg-white/5">
              Отмена
            </button>
          </>
        )}
        {note && <p role="status" className="text-sm text-white/80">{note}</p>}
      </div>
      <Panel title="Отчёты об ошибках" aside={`открыто: ${bugs.length}`}>
        {bugs.length === 0 ? (
          <p className="text-sm text-white/50">Открытых отчётов нет.</p>
        ) : (
          <ul className="divide-y divide-white/10">
            {bugs.map((b) => (
              <li key={b.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-start md:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-white/50">
                    #{b.id} · {b.nickname} · {new Date(b.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC{b.context ? ` · ${b.context}` : ""}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-white/90">{b.text}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" disabled={busy !== null} onClick={() => void review(b.id, true)} className="min-h-[44px] rounded-lg bg-emerald-400/20 px-4 text-sm font-semibold text-emerald-200 hover:bg-emerald-400/30 disabled:opacity-60">
                    Принять
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void review(b.id, false)} className="min-h-[44px] rounded-lg bg-white/5 px-4 text-sm text-white/70 hover:bg-white/10 disabled:opacity-60">
                    Отклонить
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
