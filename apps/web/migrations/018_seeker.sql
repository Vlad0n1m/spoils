-- Seeker perk (src/lib/seeker, docs/GAME_DESIGN.md §18g): the cached mainnet Seeker Genesis Token check
-- per linked wallet, the one-time Seeker frame claim (one per SGT mint = one per Seeker phone, one per
-- account) and the 'seeker' source of pass_unlocks. Cosmetic only: no CR, no items, nothing tradable.
-- PERMANENT like the other cosmetics: the alpha item wipe never touches these tables.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/018_seeker.sql

begin;

create table if not exists seeker_checks (
  wallet text primary key,
  sgt_mint text,
  checked_at timestamptz not null
);
create index if not exists seeker_checks_mint_idx on seeker_checks (sgt_mint);

create table if not exists seeker_claims (
  sgt_mint text primary key,
  user_id uuid not null,
  wallet text not null,
  at timestamptz not null default now()
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'seeker_claims_user_id_users_id_fk') then
    alter table seeker_claims add constraint seeker_claims_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;

alter table pass_unlocks drop constraint if exists pass_unlocks_source;
alter table pass_unlocks add constraint pass_unlocks_source check (source in ('pass', 'trophy', 'invite', 'donation', 'seeker'));

comment on table seeker_claims is 'Seeker frame claims, one per SGT mint: PERMANENT, never wiped (GAME_DESIGN 18g)';

commit;
