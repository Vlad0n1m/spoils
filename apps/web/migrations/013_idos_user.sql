-- iDos Games edition sign-in bridge (docs/IDOS_EDITION.md §3.3, app/api/idos/session): the iDos
-- account (`{TitleID}/{iDos UserID}`) a user was made for. Nullable and unused by the main build.
-- Definitions match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/013_idos_user.sql
begin;

alter table users add column if not exists idos_user_id text;
create unique index if not exists users_idos_user_id_idx on users (idos_user_id);

commit;
