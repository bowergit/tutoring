-- Applied live 2026-11-15 (migrations lesson_rate_falls_back_to_first_price_then_standard,
-- then lesson_rate_fallback_first_price_only, which narrowed it).
--
-- A lesson dated before a student's first price used to be charged a fixed 90.
-- Joel set a student up at £50 today, added a lesson from last week, and was told
-- he was owed £90. It now takes the student's first price instead.
--
-- A student with no price at all still uses 90, as before. Using the tutor's
-- standard price there was tried and pulled back: Tom has students with no price
-- whose parents had paid £90 a lesson while his standard price says £60, so it
-- would have moved real balances. The standard price only pre-fills forms.
--
-- Same rule in rateForLesson (index.html) and the student-portal function.

create or replace function public.tutoring_fallback_rate(p_student uuid, p_owner uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select rh.rate from public.tutoring_rate_history rh where rh.student_id = p_student
      order by rh.effective_from_date, rh.created_at limit 1),
    90)
$$;
revoke all on function public.tutoring_fallback_rate(uuid, uuid) from public, anon;
grant execute on function public.tutoring_fallback_rate(uuid, uuid) to authenticated, service_role;

create or replace function public.tutoring_lesson_rate(p_lesson_id uuid) returns numeric
language sql stable set search_path to 'public' as $function$
select case when exists(select 1 from public.tutoring_weekly_plans p where p.student_id=l.student_id and p.owner_id=l.owner_id
  and p.status in ('active','ended') and exists(select 1 from public.tutoring_weekly_acceptances a where a.plan_id=p.id) and l.lesson_date>=p.starts_on and (p.ends_before is null or l.lesson_date < p.starts_on+((p.ends_before-p.starts_on+6)/7)*7)) then 0
else coalesce(l.rate_charged,(select rh.rate from public.tutoring_rate_history rh where rh.student_id=l.student_id and rh.effective_from_date<=l.lesson_date order by rh.effective_from_date desc,rh.created_at desc limit 1),public.tutoring_fallback_rate(l.student_id,l.owner_id)) end
from public.tutoring_lessons l where l.id=p_lesson_id;
$function$;

-- tutoring_admin_accounts(): "coalesce(l.rate_charged, rh.rate, 90)" in the
-- lessons-paid count became
-- "coalesce(l.rate_charged, rh.rate, public.tutoring_fallback_rate(l.student_id, l.owner_id))".
