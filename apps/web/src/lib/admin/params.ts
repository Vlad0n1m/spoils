import { sql } from "drizzle-orm";
import { AUTOSELL, POOL } from "@extract/shared";
import { adminAudit } from "../../db/schema";
import { PARAM, setParam } from "../economy/params";
import type { Db } from "../inventory/db";
import type {
  AdminAuditEntry,
  AdminParam,
  AdminParamSetBody,
  AdminParamSetResult,
  AdminParamsDto,
  AdminReadOnlyParam,
  AdminUser,
} from "./types";

/**
 * Stop-cranes (docs/ALPHA_PLAN.md B7) over the economy_params rows that the live World v6 code
 * reads. No new money numbers: the ranges are the ones the code already enforces (AUTOSELL.MIN..MAX
 * of the daily regulator, readReleaseParams' 0..2 clamp of k), and the two pauses are 0/1 switches
 * (market_paused: market list / buy; kit_sale_paused: the paid starter kit).
 * Every change runs in one transaction with an admin_audit row (who, when, old → new, note) and
 * is refused when the value moved since the admin looked at it (`expected`).
 */

interface ParamSpec {
  key: string;
  label: string;
  help: string;
  kind: "number" | "int";
  min: number;
  max: number;
  step: number;
  /** Same default as lib/economy/params.ts DEFAULTS (asserted by admin.test.ts). */
  def: number;
  quick: Array<{ label: string; value: number }>;
}

export const EDITABLE_PARAMS: readonly ParamSpec[] = [
  {
    key: PARAM.AUTOSELL_MULT,
    label: "Множитель автопродажи хлама",
    help:
      "CR за хлам при выходе = цена хлама × множитель. Читают расчёт выхода (applyExit), вход на карту и открытие карты " +
      "(сервер показывает цены), склад и /economy. Крон economy-daily раз в сутки сдвигает его на ±3 % от текущего значения " +
      `в пределах ${AUTOSELL.MIN}–${AUTOSELL.MAX}, если ветеранов не меньше ${AUTOSELL.MIN_SAMPLE}.`,
    kind: "number",
    min: AUTOSELL.MIN,
    max: AUTOSELL.MAX,
    step: 0.01,
    def: 1,
    quick: [
      { label: `Минимум (${AUTOSELL.MIN})`, value: AUTOSELL.MIN },
      { label: "По умолчанию (1)", value: 1 },
    ],
  },
  {
    key: PARAM.POOL_RISK_K,
    label: "Коэффициент выдачи пула (k)",
    help:
      "Сколько вещей из пула потерь получает вход: round(k × риск входа), дальше потолки карты, суток и целей. " +
      "Читает raids/enter (releaseForEntry) на каждом входе. k = 0 останавливает выдачу входам; сумка босса " +
      "заполняется отдельно и от k не зависит. Рычаг, если пул разбухает: 1.25 (экономика §13).",
    kind: "number",
    // readReleaseParams (lib/economy/pool.ts) clamps k to 0..2.
    min: 0,
    max: 2,
    step: 0.05,
    def: POOL.RISK_K,
    quick: [
      { label: "Стоп выдачи входам (0)", value: 0 },
      { label: `По умолчанию (${POOL.RISK_K})`, value: POOL.RISK_K },
    ],
  },
  {
    key: PARAM.MARKET_PAUSED,
    label: "Пауза рынка (0 — работает, 1 — пауза)",
    help:
      "1: рынок игроков не принимает новые лоты и ничего не продаёт — выставление и покупка отвечают 503 market_paused " +
      "с сообщением игроку, деньги не списываются. Снять свой лот можно и во время паузы. Торговцы за CR работают как обычно.",
    kind: "int",
    min: 0,
    max: 1,
    step: 1,
    def: 0,
    quick: [
      { label: "Пауза (1)", value: 1 },
      { label: "Рынок работает (0)", value: 0 },
    ],
  },
  {
    key: PARAM.KIT_SALE_PAUSED,
    label: "Пауза продажи торгуемого набора (0 — продаётся, 1 — пауза)",
    help:
      "1: платный (торгуемый) стартовый набор не продаётся — ответ 503 sale_paused, ничего не списывается и не выдаётся. " +
      "Бесплатный привязанный набор выдаётся как обычно. Цена набора и размер раздачи отсюда не меняются.",
    kind: "int",
    min: 0,
    max: 1,
    step: 1,
    def: 0,
    quick: [
      { label: "Пауза (1)", value: 1 },
      { label: "Продаётся (0)", value: 0 },
    ],
  },
];

/** Shown read-only: internal state, or a knob the live World v6 code does not read. */
const READ_ONLY_NOTES: Record<string, string> = {
  [PARAM.TAX_ACC]: "Дробный остаток 1 % налога в казну (takeTreasuryTax). Внутренний счётчик, руками не трогать.",
  [PARAM.POOL_MIN_RESERVE]:
    "Нижний предел пула: выдача на вход не опускает пул ниже этого числа вещей (POOL.MIN_RESERVE = 150, §25 дизайна). Меньше — пул выбирается быстрее; 0 — без предела.",
  [PARAM.SEEDED_AT]: "Когда последний раз засевали экономику (seed-economy).",
  [PARAM.DAILY_RAN_ON]: "UTC-день последнего запуска economy-daily (регулятор запускается раз в сутки).",
  [PARAM.POOL_MAX_PER_MATCH]:
    "Потолок выдачи старых матчей (releasePlan). В World v6 не читается: выдачу на карту ограничивают POOL.CYCLE_MAX и k.",
};
const GS_BOOT_PREFIX = "gs_boot:";

type Row = { key: string; value: unknown; updated_at: Date | string };

function ms(v: Date | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isFinite(t) ? t : null;
}

function effective(spec: ParamSpec, stored: unknown): number {
  return typeof stored === "number" && Number.isFinite(stored) ? stored : spec.def;
}

function toParam(spec: ParamSpec, row: Row | undefined): AdminParam {
  return {
    key: spec.key,
    label: spec.label,
    help: spec.help,
    kind: spec.kind,
    min: spec.min,
    max: spec.max,
    step: spec.step,
    def: spec.def,
    value: effective(spec, row?.value),
    stored: !!row,
    updatedAt: ms(row?.updated_at),
    quick: spec.quick,
  };
}

function toAudit(r: {
  id: number | string;
  at: Date | string;
  admin_nickname: string;
  action: string;
  target: string;
  old_value: unknown;
  new_value: unknown;
  note: string | null;
}): AdminAuditEntry {
  return {
    id: Number(r.id),
    at: ms(r.at) ?? 0,
    admin: r.admin_nickname,
    action: r.action,
    target: r.target,
    oldValue: r.old_value,
    newValue: r.new_value,
    note: r.note,
  };
}

/** Latest admin_audit rows, newest first (admin_audit_at_idx, bounded). */
export async function listAudit(db: Pick<Db, "execute">, limit = 50): Promise<AdminAuditEntry[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const r = await db.execute<Parameters<typeof toAudit>[0]>(sql`
    select id, at, admin_nickname, action, target, old_value, new_value, note
    from admin_audit order by at desc, id desc limit ${n}`);
  return r.rows.map(toAudit);
}

/** Every economy_params row: editable stop-cranes, the read-only rest, and the audit tail. */
export async function readAdminParams(db: Pick<Db, "execute">): Promise<AdminParamsDto> {
  const [rows, audit] = await Promise.all([
    db.execute<Row>(sql`select key, value, updated_at from economy_params order by key limit 500`),
    listAudit(db),
  ]);
  const byKey = new Map(rows.rows.map((r) => [r.key, r]));
  const params = EDITABLE_PARAMS.map((s) => toParam(s, byKey.get(s.key)));
  const editable = new Set(EDITABLE_PARAMS.map((s) => s.key));
  const readOnly: AdminReadOnlyParam[] = [];
  for (const r of rows.rows) {
    if (editable.has(r.key)) continue;
    const note =
      READ_ONLY_NOTES[r.key] ??
      (r.key.startsWith(GS_BOOT_PREFIX) ? "Последний запуск игрового сервера (для возврата вещей после перезапуска)." : "Не используется админкой.");
    readOnly.push({ key: r.key, note, value: r.value, updatedAt: ms(r.updated_at) });
  }
  return { params, readOnly, audit };
}

/** Validates a POST body. Null when it is not even shaped like AdminParamSetBody. */
export function parseParamSetBody(raw: unknown): AdminParamSetBody | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.length > 64) return null;
  if (typeof b.value !== "number" || !Number.isFinite(b.value)) return null;
  if (typeof b.expected !== "number" || !Number.isFinite(b.expected)) return null;
  if (b.note !== undefined && b.note !== null && typeof b.note !== "string") return null;
  const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
  return { key: b.key, value: b.value, expected: b.expected, ...(note ? { note } : {}) };
}

/** Rounds to the spec's precision (4 decimals like the regulator; integers for "int"). */
function normalize(spec: ParamSpec, v: number): number {
  return spec.kind === "int" ? v : Math.round(v * 10_000) / 10_000;
}

/**
 * Sets one stop-crane. In one transaction: the economy-daily advisory lock (so the regulator never
 * computes from a value replaced under it), the row lock, the `expected` check, the write and the
 * admin_audit row. Returns the new state, or why nothing changed.
 */
export async function setAdminParam(db: Db, admin: AdminUser, body: AdminParamSetBody, now = new Date()): Promise<AdminParamSetResult> {
  const spec = EDITABLE_PARAMS.find((s) => s.key === body.key);
  if (!spec) return { ok: false, error: "unknown_param", message: "Этот параметр нельзя менять из админки." };
  const value = normalize(spec, body.value);
  if (spec.kind === "int" && !Number.isInteger(body.value)) {
    return { ok: false, error: "out_of_range", message: "Нужно целое число." };
  }
  if (value < spec.min || value > spec.max) {
    return { ok: false, error: "out_of_range", message: `Допустимо от ${spec.min} до ${spec.max}.` };
  }

  return db.transaction(async (tx) => {
    if (spec.key === PARAM.AUTOSELL_MULT) await tx.execute(sql`select pg_advisory_xact_lock(hashtext('economy-daily'))`);
    const cur = await tx.execute<Row>(sql`select key, value, updated_at from economy_params where key = ${spec.key} for update`);
    const before = effective(spec, cur.rows[0]?.value);
    if (before !== body.expected) {
      return {
        ok: false as const,
        error: "stale" as const,
        message: `Значение уже изменилось: сейчас ${before}. Обновите страницу.`,
        current: before,
      };
    }
    await setParam(tx, spec.key, value);
    const ins = await tx
      .insert(adminAudit)
      .values({
        adminId: admin.id,
        adminNickname: admin.nickname,
        action: "param_set",
        target: spec.key,
        oldValue: before,
        newValue: value,
        note: body.note ?? null,
        at: now,
      })
      .returning();
    const a = ins[0]!;
    const row: Row = { key: spec.key, value, updated_at: now };
    return {
      ok: true as const,
      param: toParam(spec, row),
      audit: toAudit({
        id: a.id,
        at: a.at,
        admin_nickname: a.adminNickname,
        action: a.action,
        target: a.target,
        old_value: a.oldValue,
        new_value: a.newValue,
        note: a.note,
      }),
    };
  });
}
