-- Applied live 2026-11-16 (migration app_opens_install_tracking).
-- How tutors open TutorTally: as the installed app (home screen / desktop app)
-- or in a browser tab, and on what kind of device. Written by the app itself at
-- most every 30 minutes per device; read only by admin through the service key.
-- Nothing else is recorded: no page, no IP, no user agent string.

create table if not exists public.tutoring_app_opens (
  id bigserial primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  opened_at timestamptz not null default now(),
  mode text not null check (mode in ('app','browser')),
  device text not null check (device in ('phone','tablet','desktop'))
);
create index if not exists tutoring_app_opens_owner on public.tutoring_app_opens(owner_id, opened_at desc);
alter table public.tutoring_app_opens enable row level security;
revoke all on public.tutoring_app_opens from anon, authenticated;
grant insert on public.tutoring_app_opens to authenticated;
grant usage on sequence public.tutoring_app_opens_id_seq to authenticated;
grant all on public.tutoring_app_opens to service_role;
create policy app_opens_insert_own on public.tutoring_app_opens for insert to authenticated
  with check (owner_id = (select auth.uid()));

-- One row per tutor for the admin panel.
create or replace function public.tutoring_admin_app_use() returns table(
  owner_id uuid, installed_ever boolean, opens_30d bigint, app_30d bigint,
  browser_phone_30d bigint, browser_tablet_30d bigint, desktop_30d bigint,
  last_mode text, last_device text, last_open timestamptz)
language sql stable security definer set search_path = public as $$
  select o.owner_id,
         bool_or(o.mode = 'app'),
         count(*) filter (where o.opened_at >= now() - interval '30 days'),
         count(*) filter (where o.opened_at >= now() - interval '30 days' and o.mode = 'app'),
         count(*) filter (where o.opened_at >= now() - interval '30 days' and o.mode = 'browser' and o.device = 'phone'),
         count(*) filter (where o.opened_at >= now() - interval '30 days' and o.mode = 'browser' and o.device = 'tablet'),
         count(*) filter (where o.opened_at >= now() - interval '30 days' and o.mode = 'browser' and o.device = 'desktop'),
         (array_agg(o.mode order by o.opened_at desc))[1],
         (array_agg(o.device order by o.opened_at desc))[1],
         max(o.opened_at)
  from public.tutoring_app_opens o
  group by o.owner_id
$$;
revoke all on function public.tutoring_admin_app_use() from public, anon, authenticated;
grant execute on function public.tutoring_admin_app_use() to service_role;
