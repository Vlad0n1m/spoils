-- Admin replays: the map generator version a shard-cycle was recorded on (replays.gen_version,
-- ReplayChunkUpload.genVersion = MapData.genVersion). The viewer draws the map from the current
-- generator and warns when a replay was recorded on another one (e.g. MAP_GEN_VERSION 3 replays
-- after the map v2 bump to 4). Null = recorded by a game server built before this column.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/009_replay_gen_version.sql

begin;

alter table replays add column if not exists gen_version smallint;

commit;
