-- ALPHA LOOT (packages/shared alpha-loot.ts): items the game server mints in a raid (alpha container,
-- floor and supply-drop finds) get their row on extract with origin 'alpha' (lib/inventory/raids.ts
-- createAlphaItem). Definitions match the Drizzle schema, so `pnpm --filter web db:push` shows no diff
-- afterwards. Idempotent; ADD VALUE runs outside a transaction block:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/014_alpha_loot.sql
alter type item_origin add value if not exists 'alpha';
