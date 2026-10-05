-- Player market switches to CR (alpha decision 05.10, lib/market/market.ts): listings.price_minor
-- now holds whole CR. Lots opened under the old SOL-minor pricing are closed here: player lots go
-- back to the seller's stash, treasury lots back to the treasury (listing fees are not refunded,
-- the same as a cancel). Old trades stop counting for the CR price index.
-- Idempotent (a second run finds no open lots):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/014_cr_market.sql
begin;

with open_lots as (
  select l.id, l.item_id, l.seller_id
  from listings l
  where l.status in ('pending', 'active')
),
moved as (
  update items i
  set state = case when o.seller_id is null then 'treasury'::item_state else 'in_stash'::item_state end
  from open_lots o
  where i.id = o.item_id and i.state = 'listed'
  returning i.id, o.id as listing_id, o.seller_id
)
insert into item_events (item_id, from_state, to_state, from_owner, to_owner, reason, ref_id, at)
select m.id, 'listed', case when m.seller_id is null then 'treasury'::item_state else 'in_stash'::item_state end,
       m.seller_id, m.seller_id, 'delist', m.listing_id::text, now()
from moved m
on conflict do nothing;

update listings set status = 'cancelled', closed_at = now() where status in ('pending', 'active');

update trades set counted_for_index = false where counted_for_index and at < now();

commit;
