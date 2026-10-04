"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** "Run now": POST /api/admin/invariants, then reloads the page data. */
export function RunInvariantsButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-3">
      {err ? <span className="text-xs text-red-300">{err}</span> : null}
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const res = await fetch("/api/admin/invariants", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
            if (!res.ok) throw new Error(String(res.status));
            router.refresh();
          } catch (e) {
            setErr(`Не удалось запустить (${e instanceof Error ? e.message : "ошибка"})`);
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex min-h-[44px] items-center rounded-lg bg-white/10 px-4 text-sm font-semibold text-white hover:bg-white/15 disabled:opacity-50"
      >
        {busy ? "Проверяю…" : "Проверить сейчас"}
      </button>
    </div>
  );
}
