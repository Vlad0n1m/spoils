-- On-chain events (README "On-chain"): the chain_events outbox that settlement fills and the cron
-- worker /api/cron/chain-events sends to the spoils_events program on Solana (src/lib/chain).
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/004_chain_events.sql

begin;

create table if not exists chain_events (
  id bigserial primary key,
  kind text not null,
  dedupe_key text not null,
  payload jsonb not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  tx_sig text,
  tx_valid_until bigint,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index if not exists chain_events_dedupe_idx on chain_events (dedupe_key);
create index if not exists chain_events_status_next_idx on chain_events (status, next_at);
create index if not exists chain_events_sent_at_idx on chain_events (sent_at);

commit;
