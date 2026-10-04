-- Admin panel (/admin, src/lib/admin): users.role ('admin' or NULL, granted by hand with SQL, README
-- "Админка") and the admin_audit journal of every admin change (who, when, old -> new).
-- No money, items or CR involved.
-- Names match the Drizzle schema, so `pnpm --filter web db:push` shows no diff afterwards.
-- Idempotent: safe to re-run.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/web/migrations/006_admin_role.sql

begin;

alter table users add column if not exists role text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_role_known') then
    alter table users add constraint users_role_known check (role is null or role = 'admin');
  end if;
end $$;

create table if not exists admin_audit (
  id bigserial primary key,
  admin_id uuid,
  admin_nickname text not null,
  action text not null,
  target text not null,
  old_value jsonb,
  new_value jsonb,
  note text,
  at timestamptz not null default now()
);
create index if not exists admin_audit_at_idx on admin_audit (at);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'admin_audit_admin_id_users_id_fk') then
    alter table admin_audit add constraint admin_audit_admin_id_users_id_fk
      foreign key (admin_id) references users(id) on delete set null;
  end if;
end $$;

commit;
