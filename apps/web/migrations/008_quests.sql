-- Daily tasks and level rewards (src/lib/quests, @extract/shared quests.ts, docs/RETENTION.md §5):
-- quest_slots (3 tasks per player), quest_log (completed tasks: daily XP cap and task marks) and the
-- equipped earn-only cosmetics on users (title, name_color, badge_frame). XP only: no money, items
-- or CR involved.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Apply BEFORE the web build that reads these columns (whole-row user selects name them).
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/008_quests.sql

begin;

alter table users add column if not exists title text;
alter table users add column if not exists name_color text;
alter table users add column if not exists badge_frame text;

create table if not exists quest_slots (
  user_id uuid not null,
  slot smallint not null,
  quest_id text not null,
  need integer not null,
  xp integer not null,
  progress integer not null default 0,
  issued_day date not null,
  done_day date,
  rerolled_day date,
  updated_at timestamptz not null default now(),
  constraint quest_slots_user_id_slot_pk primary key (user_id, slot),
  constraint quest_slots_slot_range check (slot >= 0 and slot < 3),
  constraint quest_slots_progress_range check (progress >= 0 and progress <= need)
);

create table if not exists quest_log (
  id bigserial primary key,
  user_id uuid not null,
  day date not null,
  slot smallint not null,
  quest_id text not null,
  xp integer not null,
  entry_id uuid,
  at timestamptz not null default now()
);
create unique index if not exists quest_log_user_day_slot_idx on quest_log (user_id, day, slot);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'quest_slots_user_id_users_id_fk') then
    alter table quest_slots add constraint quest_slots_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quest_log_user_id_users_id_fk') then
    alter table quest_log add constraint quest_log_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;

commit;
