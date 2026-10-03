-- WORLD v6 (spec §4.1): one always-live map per 45-minute cycle, drop-in entries, XP and boards.
-- Run BEFORE `pnpm --filter web db:push` on an existing database (the backfills below give the new
-- NOT NULL columns their values first); afterwards db:push shows no diff. Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/002_world_v6.sql

begin;

-- raids: one row per shard-cycle (kind 'world'); legacy rows kind 'match'
alter table raids
  add column if not exists kind text not null default 'match',
  add column if not exists cycle_id integer,
  add column if not exists shard smallint not null default 0,
  add column if not exists room_id text,
  add column if not exists server_id text,
  add column if not exists instance_id text,
  add column if not exists entry_closes_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists boss_kind text,
  add column if not exists boss_zone text,
  add column if not exists next_boss_kind text,
  add column if not exists next_boss_zone text,
  add column if not exists boss_killed_by text,
  add column if not exists boss_killed_at timestamptz,
  add column if not exists boss_bag_filled boolean not null default false;
update raids set ends_at = started_at + interval '30 minutes' where ends_at is null;
alter table raids alter column ends_at set not null;
create index if not exists raids_world_cycle_idx on raids (kind, cycle_id);
create index if not exists raids_status_ends_idx on raids (status, ends_at);

-- raid_exits: per-entry key (legacy rows get a random entry id; new legacy exits use legacyEntryId)
alter table raid_exits add column if not exists entry_id uuid;
update raid_exits set entry_id = gen_random_uuid() where entry_id is null;
alter table raid_exits alter column entry_id set not null;
alter table raid_exits alter column entry_id set default gen_random_uuid();
alter table raid_exits drop constraint if exists raid_exits_match_id_user_id_pk;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'raid_exits'::regclass and contype = 'p') then
    alter table raid_exits add primary key (entry_id);
  end if;
end $$;
create index if not exists raid_exits_match_user_idx on raid_exits (match_id, user_id);
alter table raid_exits
  add column if not exists cycle_id integer,
  add column if not exists xp_lines jsonb not null default '[]'::jsonb,
  add column if not exists xp_grind integer not null default 0,
  add column if not exists on_map_ms integer not null default 0,
  add column if not exists npc_kills integer not null default 0,
  add column if not exists boss_kills integer not null default 0,
  add column if not exists pvp_ranked integer not null default 0;
create index if not exists raid_exits_cycle_idx on raid_exits (cycle_id);
create index if not exists raid_exits_at_idx on raid_exits (at);

create table if not exists raid_entries (
  entry_id uuid primary key,
  match_id uuid not null,
  cycle_id integer not null,
  user_id uuid not null,                 -- not a FK: guests
  loadout_id uuid,
  guest boolean not null default false,
  free_kit boolean not null default true,
  status text not null default 'active', -- active | exited | voided
  risk_units smallint not null default 0,
  max_tier smallint not null default 0,  -- max uniqueTierScore among this entry's risk items
  released smallint not null default 0,
  at_ms integer not null default 0,
  response jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create unique index if not exists raid_entries_one_active on raid_entries (user_id) where status = 'active';
create index if not exists raid_entries_match_idx on raid_entries (match_id, status);
create index if not exists raid_entries_cycle_user_idx on raid_entries (cycle_id, user_id);
create index if not exists raid_entries_user_day_idx on raid_entries (user_id, created_at);

create table if not exists pvp_kills (
  id bigserial primary key,
  killer_id uuid not null,
  victim_id uuid not null,
  match_id uuid not null,
  entry_id uuid not null,
  cycle_id integer,
  ranked boolean not null,
  at timestamptz not null default now()
);
create index if not exists pvp_kills_pair_idx on pvp_kills (killer_id, victim_id, at);
create index if not exists pvp_kills_board_idx on pvp_kills (ranked, at);
create index if not exists pvp_kills_cycle_idx on pvp_kills (cycle_id);
create index if not exists users_xp_idx on users (xp desc);

commit;
