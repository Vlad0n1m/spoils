-- iDos edition SPOILS shop (lib/idos/shop.ts, docs/IDOS_EDITION.md §3.5): orders paid with the
-- SPOILS token through the iDos Title store, and the Supporter / Patron donation titles (pass_unlocks
-- source 'donation'). Definitions match the Drizzle schema, so `pnpm --filter web db:push` shows no
-- diff afterwards. The table exists in the main build too (it simply stays empty there: the shop is
-- edition-only), so lib/inventory/starter.ts can count shop kits in both builds with one query.
-- Idempotent:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/017_idos_shop.sql
begin;

create table if not exists idos_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  product text not null,
  request_id text not null,
  usd_cents integer not null,
  spoils_quoted bigint not null,
  spoils_paid bigint not null default 0,
  status text not null default 'pending',
  detail jsonb,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint idos_orders_status check (status in ('pending', 'paid', 'delivered', 'failed', 'refund_owed'))
);
create unique index if not exists idos_orders_request_idx on idos_orders (user_id, request_id);
create index if not exists idos_orders_product_idx on idos_orders (product, status, created_at);

alter table pass_unlocks drop constraint if exists pass_unlocks_source;
alter table pass_unlocks add constraint pass_unlocks_source check (source in ('pass', 'trophy', 'invite', 'donation'));

commit;
