-- Wallet link (Sign-In with Solana): users.wallet_pubkey + wallet_linked_at and the single-use
-- challenge table wallet_link_nonces (see src/lib/wallet/link.ts). Identity only: no money moves.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/003_wallet_link.sql

begin;

alter table users
  add column if not exists wallet_pubkey text,
  add column if not exists wallet_linked_at timestamptz;
-- one account per wallet; NULLs (no wallet linked) do not collide
create unique index if not exists users_wallet_pubkey_idx on users (wallet_pubkey);

create table if not exists wallet_link_nonces (
  nonce text primary key,
  user_id uuid not null,
  domain text not null,
  uri text not null,
  chain_id text not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'wallet_link_nonces_user_id_users_id_fk') then
    alter table wallet_link_nonces
      add constraint wallet_link_nonces_user_id_users_id_fk
      foreign key (user_id) references users(id) on delete cascade;
  end if;
end $$;
create index if not exists wallet_link_nonces_user_idx on wallet_link_nonces (user_id);
create index if not exists wallet_link_nonces_expires_idx on wallet_link_nonces (expires_at);

commit;
