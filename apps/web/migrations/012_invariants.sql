-- B6 nightly invariant check (docs/ALPHA_PLAN.md): one row per run of lib/admin/invariants.ts
-- (GET /api/cron/invariants daily, or "Run now" on /admin/invariants). The checks themselves only
-- read; this table is the only thing a run writes. Definitions match the Drizzle schema, so
-- `pnpm --filter web db:push` shows no diff afterwards. Idempotent:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/012_invariants.sql
begin;

create table if not exists invariant_runs (
  id bigserial primary key,
  trigger text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  duration_ms integer not null,
  ok boolean not null,
  failed integer not null,
  checks jsonb not null
);

create index if not exists invariant_runs_started_at_idx on invariant_runs (started_at);

commit;
