-- Applied live 2026-11-11 (migration lesson_status_lock).
--
-- Lets a tutor cancel a lesson in the app and have it stay cancelled.
--
-- The calendar sync rewrites every lesson's status on each run ("completed" if
-- the event is in the past, otherwise "scheduled"), so a lesson cancelled in
-- the app was turned back into a taught, chargeable lesson within two hours.
-- The sync function is left as it is. Instead the lesson carries a lock, and
-- while the lock is on, nothing can change its status.
--
-- The app sets status and status_locked together when it cancels, and clears
-- the lock when it restores. The sync never mentions status_locked, so the
-- lock survives it. If the calendar event is moved to another day it is a
-- different lesson, so the lock comes off and the sync's status is taken.
-- Cancelled lessons were already left out of balances, payment allocation and
-- the parent page.

alter table public.tutoring_lessons
  add column if not exists status_locked boolean not null default false;

create or replace function public.tutoring_lesson_keep_status() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status_locked and new.status_locked then
    if new.lesson_date is distinct from old.lesson_date then
      new.status_locked := false;
    else
      new.status := old.status;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists tutoring_lessons_keep_status on public.tutoring_lessons;
create trigger tutoring_lessons_keep_status
  before update on public.tutoring_lessons
  for each row execute function public.tutoring_lesson_keep_status();
