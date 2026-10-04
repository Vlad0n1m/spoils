-- Admin replays (@extract/shared replay.ts, src/lib/admin/replay.ts): the game server posts one
-- deflate-compressed chunk (about a minute) of every world shard-cycle to
-- /api/admin/replays/ingest (HMAC-signed, idempotent by (match_id, seq)); admins read them through
-- /api/admin/replays/**; the replays-retention cron deletes replays older than 14 days.
-- replays = one row per shard-cycle (match_id = raids.match_id, no FK: a replay may arrive for a
-- shard whose raids/open never landed). No money, items or CR involved.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/007_replays.sql

begin;

create table if not exists replays (
  match_id uuid primary key,
  cycle_id integer not null,
  shard smallint not null,
  map_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  last_ms integer not null default 0,
  entries integer not null default 0,
  chunks integer not null default 0,
  bytes bigint not null default 0,
  raw_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists replays_started_at_idx on replays (started_at);
create index if not exists replays_cycle_idx on replays (cycle_id);

create table if not exists replay_chunks (
  match_id uuid not null,
  seq integer not null,
  start_ms integer not null,
  end_ms integer not null,
  frames integer not null,
  events integer not null,
  bytes integer not null,
  raw_bytes integer not null,
  final boolean not null default false,
  data bytea not null,
  created_at timestamptz not null default now(),
  constraint replay_chunks_match_id_seq_pk primary key (match_id, seq)
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'replay_chunks_match_id_replays_match_id_fk') then
    alter table replay_chunks add constraint replay_chunks_match_id_replays_match_id_fk
      foreign key (match_id) references replays(match_id) on delete cascade;
  end if;
end $$;

commit;
