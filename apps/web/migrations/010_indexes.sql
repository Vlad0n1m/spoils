-- DB review (docs/DB_REVIEW.md): indexes for hot-path queries that scanned whole growing tables.
--   item_events_match_idx       pool allocations of a match / an entry (raids/exit of every free-kit
--                               player, raids/end, voids): was a sequential scan of item_events
--   raid_exits_at_cover_idx     NPC leaderboard + its /me rank, /economy raids 24 h, admin exits and
--                               active players read from the index alone; replaces raid_exits_at_idx
--   trades_at_idx               market history "last 20 trades" without a template
--   users_nickname_lower_idx    friend / party actions by nickname (lower(nickname) = lower($1))
--   items_giveaway_tradable_idx the paid starter kit cap count (under the giveaway advisory lock)
-- Names and definitions match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
--
-- Built CONCURRENTLY (writes keep flowing on a live database), so this file has no begin/commit and
-- must run outside a transaction. Idempotent: an index left INVALID by an interrupted earlier run is
-- dropped and rebuilt; existing valid ones are kept.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/010_indexes.sql

-- An interrupted CREATE INDEX CONCURRENTLY leaves an INVALID index that `if not exists` would keep.
do $$
declare
  ix text;
begin
  for ix in
    select c.relname from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and not i.indisvalid
      and c.relname in ('item_events_match_idx', 'raid_exits_at_cover_idx', 'trades_at_idx', 'users_nickname_lower_idx',
                        'items_giveaway_tradable_idx')
  loop
    execute format('drop index %I', ix);
  end loop;
end $$;

create index concurrently if not exists item_events_match_idx on item_events (match_id, reason) where match_id is not null;

create index concurrently if not exists raid_exits_at_cover_idx
  on raid_exits (at, user_id, guest, exit, credits, npc_kills, boss_kills);
-- Every query of raid_exits_at_idx (at ranges) is served by the cover index's leading column.
drop index concurrently if exists raid_exits_at_idx;

create index concurrently if not exists trades_at_idx on trades (at);

create index concurrently if not exists users_nickname_lower_idx on users (lower(nickname));

create index concurrently if not exists items_giveaway_tradable_idx on items (id) where origin = 'giveaway' and bound = false;

analyze item_events;
analyze raid_exits;
analyze trades;
analyze users;
analyze items;
