-- Friends and parties (src/lib/social): friend pairs, menu presence, parties of 2-4, party invites
-- and party drops (spawn together, @extract/shared party.ts). No money, items or CR involved.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/005_friends_party.sql

begin;

-- one row per unordered pair (user_lo < user_hi); pending -> accepted, declined/cancelled/removed = deleted
create table if not exists friendships (
  user_lo uuid not null,
  user_hi uuid not null,
  requested_by uuid not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint friendships_user_lo_user_hi_pk primary key (user_lo, user_hi),
  constraint friendships_ordered_pair check (user_lo < user_hi),
  constraint friendships_requester_in_pair check (requested_by = user_lo or requested_by = user_hi),
  constraint friendships_status check (status in ('pending', 'accepted'))
);
create index if not exists friendships_user_hi_idx on friendships (user_hi);

create table if not exists user_presence (
  user_id uuid primary key,
  seen_at timestamptz not null
);

create table if not exists parties (
  id uuid primary key default gen_random_uuid(),
  leader_id uuid not null,
  created_at timestamptz not null default now()
);

-- primary key on user_id = one party per user
create table if not exists party_members (
  user_id uuid primary key,
  party_id uuid not null,
  follow boolean not null default false,
  joined_at timestamptz not null default now()
);
create index if not exists party_members_party_idx on party_members (party_id);

create table if not exists party_invites (
  party_id uuid not null,
  to_id uuid not null,
  from_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint party_invites_party_id_to_id_pk primary key (party_id, to_id)
);
create index if not exists party_invites_to_idx on party_invites (to_id);

create table if not exists party_drops (
  drop_id uuid primary key,
  party_id uuid not null,
  cycle integer not null,
  match_id uuid not null,
  leader_id uuid not null,
  members jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists party_drops_party_created_idx on party_drops (party_id, created_at);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'friendships_user_lo_users_id_fk') then
    alter table friendships add constraint friendships_user_lo_users_id_fk
      foreign key (user_lo) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'friendships_user_hi_users_id_fk') then
    alter table friendships add constraint friendships_user_hi_users_id_fk
      foreign key (user_hi) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'user_presence_user_id_users_id_fk') then
    alter table user_presence add constraint user_presence_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'parties_leader_id_users_id_fk') then
    alter table parties add constraint parties_leader_id_users_id_fk
      foreign key (leader_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_members_user_id_users_id_fk') then
    alter table party_members add constraint party_members_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_members_party_id_parties_id_fk') then
    alter table party_members add constraint party_members_party_id_parties_id_fk
      foreign key (party_id) references parties(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_invites_party_id_parties_id_fk') then
    alter table party_invites add constraint party_invites_party_id_parties_id_fk
      foreign key (party_id) references parties(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_invites_to_id_users_id_fk') then
    alter table party_invites add constraint party_invites_to_id_users_id_fk
      foreign key (to_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_invites_from_id_users_id_fk') then
    alter table party_invites add constraint party_invites_from_id_users_id_fk
      foreign key (from_id) references users(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'party_drops_party_id_parties_id_fk') then
    alter table party_drops add constraint party_drops_party_id_parties_id_fk
      foreign key (party_id) references parties(id) on delete cascade;
  end if;
end $$;

commit;
