-- On-chain items and the SOL market (lib/onchain, README "On-chain"): items can leave the game as
-- SPOILS Metaplex Core assets (state 'onchain', items.chain_asset) and every player-signed
-- transaction the server builds is kept in onchain_ops. Definitions match the Drizzle schema.
-- Idempotent:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/015_onchain_items.sql
alter type item_state add value if not exists 'onchain';

begin;

alter table items add column if not exists chain_asset text;
create unique index if not exists items_chain_asset_idx on items (chain_asset);

create table if not exists onchain_ops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  wallet text not null,
  action text not null,
  item_id uuid,
  asset text,
  lamports text,
  message text not null,
  status text not null default 'prepared',
  signature text,
  signed_tx text,
  last_valid_block_height bigint not null,
  error text,
  created_at timestamp with time zone not null default now(),
  done_at timestamp with time zone
);
create index if not exists onchain_ops_user_idx on onchain_ops (user_id, created_at);
create index if not exists onchain_ops_status_idx on onchain_ops (status, created_at);
create unique index if not exists onchain_ops_signature_idx on onchain_ops (signature);

commit;
