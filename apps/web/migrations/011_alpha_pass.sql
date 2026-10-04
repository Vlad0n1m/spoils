-- Alpha Pass and tester tasks (src/lib/pass, @extract/shared pass.ts, docs/GAME_DESIGN.md §18e):
-- AP log (one row per task completion, idempotent per task and period), the weekly task slots, the
-- granted cosmetics (pass tiers, the alpha trophy, the invite reward), bug reports reviewed in /admin,
-- the in-menu survey, and the equipped character skin on users.
--
-- PERMANENT: the alpha item wipe (docs/ALPHA_PLAN.md) never touches pass_ap_log, pass_unlocks,
-- pass_weekly, bug_reports, alpha_survey or the cosmetic columns of users (title, name_color,
-- badge_frame, skin). It wipes items, stash, loadouts, CR and the market only.
-- No CR, no items, nothing tradable is ever granted from these tables.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/011_alpha_pass.sql

begin;

alter table users add column if not exists skin text;

create table if not exists pass_ap_log (
  id bigserial primary key,
  user_id uuid not null,
  source text not null,
  task text not null,
  period text not null,
  ap integer not null,
  ref text,
  at timestamptz not null default now(),
  constraint pass_ap_log_source check (source in ('daily', 'weekly', 'tester')),
  constraint pass_ap_log_ap_positive check (ap > 0)
);
create unique index if not exists pass_ap_log_once_idx on pass_ap_log (user_id, source, task, period);

create table if not exists pass_weekly (
  user_id uuid not null,
  slot smallint not null,
  week date not null,
  quest_id text not null,
  need integer not null,
  progress integer not null default 0,
  done_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint pass_weekly_user_id_slot_pk primary key (user_id, slot),
  constraint pass_weekly_slot_range check (slot >= 0 and slot < 3),
  constraint pass_weekly_progress_range check (progress >= 0 and progress <= need)
);

create table if not exists pass_unlocks (
  user_id uuid not null,
  reward_id text not null,
  source text not null,
  at timestamptz not null default now(),
  constraint pass_unlocks_user_id_reward_id_pk primary key (user_id, reward_id),
  constraint pass_unlocks_source check (source in ('pass', 'trophy', 'invite'))
);

create table if not exists bug_reports (
  id bigserial primary key,
  user_id uuid not null,
  text text not null,
  context text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  constraint bug_reports_status check (status in ('open', 'accepted', 'rejected'))
);
create index if not exists bug_reports_status_idx on bug_reports (status, created_at);
create index if not exists bug_reports_user_idx on bug_reports (user_id);

create table if not exists alpha_survey (
  user_id uuid primary key,
  answers jsonb not null,
  at timestamptz not null default now()
);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'pass_ap_log_user_id_users_id_fk') then
    alter table pass_ap_log add constraint pass_ap_log_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pass_weekly_user_id_users_id_fk') then
    alter table pass_weekly add constraint pass_weekly_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pass_unlocks_user_id_users_id_fk') then
    alter table pass_unlocks add constraint pass_unlocks_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bug_reports_user_id_users_id_fk') then
    alter table bug_reports add constraint bug_reports_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'alpha_survey_user_id_users_id_fk') then
    alter table alpha_survey add constraint alpha_survey_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;

comment on table pass_ap_log is 'Alpha Pass AP: PERMANENT, never wiped (GAME_DESIGN 18e)';
comment on table pass_unlocks is 'Granted cosmetics (pass tiers, alpha trophy, invite): PERMANENT, never wiped (GAME_DESIGN 18e)';

commit;
