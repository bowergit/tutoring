-- Applied live 2026-11-04 (migrations weekly_roll_forward_stale_proposals, weekly_roll_forward_hourly_job).
-- An unsigned weekly proposal whose first payment date has passed moves forward to the
-- next same-weekday date, so a parent link never goes stale and nothing is backdated.
-- The plan guard allows this one change only while tutoring.rolling_start is set by the function below.
-- The acceptance guard now says "refresh and sign again" instead of "ask Daniel for a new link".

create or replace function public.tutoring_weekly_roll_forward(p_plan_id uuid) returns date
language plpgsql set search_path=public as $$
declare p public.tutoring_weekly_plans; today date := (now() at time zone 'Europe/London')::date; next_start date;
begin
  select * into p from public.tutoring_weekly_plans where id=p_plan_id for update;
  if not found or p.status<>'proposed' or p.starts_on>=today then return p.starts_on; end if;
  next_start := p.starts_on + (((today - p.starts_on) + 6) / 7) * 7;
  perform set_config('tutoring.rolling_start','on',true);
  update public.tutoring_weekly_plans set starts_on=next_start where id=p.id;
  perform set_config('tutoring.rolling_start','off',true);
  return next_start;
end $$;

create or replace function public.tutoring_weekly_roll_forward_all() returns integer
language plpgsql set search_path=public as $$
declare r record; n integer := 0;
begin
  for r in select id from public.tutoring_weekly_plans where status='proposed' and starts_on < (now() at time zone 'Europe/London')::date loop
    perform public.tutoring_weekly_roll_forward(r.id); n := n + 1;
  end loop;
  return n;
end $$;

-- Runs at five past every hour.
select cron.schedule('weekly-proposals-roll-forward', '5 * * * *', 'select public.tutoring_weekly_roll_forward_all()');

-- Added to tutoring_guard_weekly_plan, before the "Create a new proposal to change the agreement" check:
--   elsif current_setting('tutoring.rolling_start', true)='on' and old.status='proposed' and new.status='proposed'
--     and new.starts_on > old.starts_on and (new.starts_on - old.starts_on) % 7 = 0
--     and new.starts_on >= today and lesson, fee, notice and end date unchanged then
--     regenerate terms_text for the new date and return new;
