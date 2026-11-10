-- Applied live 2026-11-10 (migration lesson_deletions_keep_notes). Written after Zachy Young's notes for 3 and 5 Nov were lost.
--
-- What happened: a "Sync now" at 00:34 on 10 Nov found new Google event ids for every
-- Zachy lesson from 3 Nov on (the recurring series had been edited in Google Calendar).
-- The sync inserted fresh lessons for the new ids and deleted the old ones as orphans,
-- and tutor_notes went with them. The free Supabase plan keeps no backups.
--
-- This makes two changes:
-- 1. Every deleted lesson that carried notes or a manual adjustment is copied into
--    tutoring_lesson_deletions first, so it can always be recovered.
-- 2. When the sync replaces a lesson (a new event for the same student and day was
--    created in the last 15 minutes), the new copy takes over the notes, billed minutes,
--    free flag and charge override instead of starting blank.
-- Neither can block a delete: both are wrapped so an error is swallowed.

create table if not exists public.tutoring_lesson_deletions (
  id bigserial primary key,
  deleted_at timestamptz not null default now(),
  owner_id uuid,
  lesson_id uuid,
  student_id uuid,
  lesson_date date,
  carried_to uuid,
  lesson jsonb not null
);
create index if not exists tutoring_lesson_deletions_owner on public.tutoring_lesson_deletions(owner_id, deleted_at desc);
alter table public.tutoring_lesson_deletions enable row level security;
revoke all on public.tutoring_lesson_deletions from anon, authenticated;
grant select on public.tutoring_lesson_deletions to authenticated;
grant all on public.tutoring_lesson_deletions to service_role;
grant usage on sequence public.tutoring_lesson_deletions_id_seq to service_role;
create policy lesson_deletions_owner_read on public.tutoring_lesson_deletions for select to authenticated using ((select auth.uid()) = owner_id);

create or replace function public.tutoring_lesson_before_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  if old.tutor_notes is null and old.billed_minutes is null and not coalesce(old.is_complimentary,false) and not coalesce(old.charge_overridden,false) then
    return old;
  end if;
  begin
    if old.google_event_id is not null then
      select n.id into target from public.tutoring_lessons n
       where n.student_id = old.student_id and n.lesson_date = old.lesson_date and n.id <> old.id
         and n.google_event_id is not null and n.google_event_id <> old.google_event_id
         and n.created_at > now() - interval '15 minutes'
       order by n.created_at desc limit 1;
      if target is not null then
        update public.tutoring_lessons n set
          tutor_notes = coalesce(n.tutor_notes, old.tutor_notes),
          billed_minutes = coalesce(n.billed_minutes, old.billed_minutes),
          is_complimentary = coalesce(n.is_complimentary,false) or coalesce(old.is_complimentary,false),
          rate_charged = case when coalesce(old.charge_overridden,false) and not coalesce(n.charge_overridden,false) then old.rate_charged else n.rate_charged end,
          charge_overridden = coalesce(n.charge_overridden,false) or coalesce(old.charge_overridden,false)
        where n.id = target;
      end if;
    end if;
  exception when others then target := null; -- never block a delete over this
  end;
  begin
    insert into public.tutoring_lesson_deletions(owner_id, lesson_id, student_id, lesson_date, carried_to, lesson)
    values (old.owner_id, old.id, old.student_id, old.lesson_date, target, to_jsonb(old));
  exception when others then null;
  end;
  return old;
end $$;
revoke all on function public.tutoring_lesson_before_delete() from public, anon, authenticated;
drop trigger if exists keep_lesson_notes_on_delete on public.tutoring_lessons;
create trigger keep_lesson_notes_on_delete before delete on public.tutoring_lessons
  for each row execute function public.tutoring_lesson_before_delete();
