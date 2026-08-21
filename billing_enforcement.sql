-- TutorTally billing enforcement.
-- Free accounts can have up to free_student_limit active students.
-- TutorTally Pro access comes from a comped account, a live free TutorTally Pro grant, or a live
-- Stripe subscription status. If a TutorTally Pro account later lapses while over the
-- limit, ordinary writes become read-only until students are archived or TutorTally Pro
-- is active again.

create or replace function public.tutoring_has_pro_access(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select plan = 'comp'
        or pro_free_until >= current_date
        or stripe_status in ('active', 'trialing', 'past_due')
    from public.tutoring_subscriptions
    where owner_id = p_owner
  ), false);
$$;

create or replace function public.tutoring_can_write_account(p_owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.tutoring_has_pro_access(p_owner)
      or (
        select count(*)
        from public.tutoring_students
        where owner_id = p_owner
          and active is true
      ) <= coalesce((
        select free_student_limit
        from public.tutoring_subscriptions
        where owner_id = p_owner
      ), 3);
$$;

create or replace function public.tutoring_enforce_student_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(new.owner_id, old.owner_id);
  v_limit integer;
  v_count integer;
  v_read_only boolean;
begin
  select coalesce(free_student_limit, 3)
    into v_limit
    from public.tutoring_subscriptions
   where owner_id = v_owner;
  v_limit := coalesce(v_limit, 3);

  v_read_only := not public.tutoring_can_write_account(v_owner);

  if tg_op = 'UPDATE' and v_read_only then
    if old.active is true and new.active is false then
      return new;
    end if;
    raise exception using
      errcode = 'P0001',
      message = 'This account is over the TutorTally Lite student limit, so TutorTally is read-only until students are archived or TutorTally Pro is active.';
  elsif tg_op = 'DELETE' and v_read_only then
    raise exception using
      errcode = 'P0001',
      message = 'This account is over the TutorTally Lite student limit. Archive students instead of deleting them, or activate TutorTally Pro.';
  end if;

  if tg_op in ('INSERT', 'UPDATE')
     and new.active is true
     and not public.tutoring_has_pro_access(new.owner_id)
     and not (tg_op = 'UPDATE' and old.active is true) then
    select count(*)
      into v_count
      from public.tutoring_students
     where owner_id = new.owner_id
       and active is true
       and (tg_op <> 'UPDATE' or id <> new.id);

    if v_count >= v_limit then
      raise exception using
        errcode = 'P0001',
        message = format('TutorTally Lite covers %s active students. TutorTally Pro is £5 a month for as many as you like.', v_limit);
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.tutoring_enforce_account_write_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := coalesce(new.owner_id, old.owner_id);
begin
  if not public.tutoring_can_write_account(v_owner) then
    raise exception using
      errcode = 'P0001',
      message = 'This account is over the TutorTally Lite student limit, so TutorTally is read-only until students are archived or TutorTally Pro is active.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists tutoring_students_billing_guard on public.tutoring_students;
create trigger tutoring_students_billing_guard
before insert or update or delete on public.tutoring_students
for each row execute function public.tutoring_enforce_student_access();

drop trigger if exists tutoring_lessons_billing_guard on public.tutoring_lessons;
create trigger tutoring_lessons_billing_guard
before insert or update or delete on public.tutoring_lessons
for each row execute function public.tutoring_enforce_account_write_access();

drop trigger if exists tutoring_payments_billing_guard on public.tutoring_payments;
create trigger tutoring_payments_billing_guard
before insert or update or delete on public.tutoring_payments
for each row execute function public.tutoring_enforce_account_write_access();

drop trigger if exists tutoring_bundles_billing_guard on public.tutoring_bundles;
create trigger tutoring_bundles_billing_guard
before insert or update or delete on public.tutoring_bundles
for each row execute function public.tutoring_enforce_account_write_access();

drop trigger if exists tutoring_rate_history_billing_guard on public.tutoring_rate_history;
create trigger tutoring_rate_history_billing_guard
before insert or update or delete on public.tutoring_rate_history
for each row execute function public.tutoring_enforce_account_write_access();

revoke all on function public.tutoring_has_pro_access(uuid) from public, anon, authenticated;
revoke all on function public.tutoring_can_write_account(uuid) from public, anon, authenticated;
revoke all on function public.tutoring_enforce_student_access() from public, anon, authenticated;
revoke all on function public.tutoring_enforce_account_write_access() from public, anon, authenticated;

-- Existing SECURITY DEFINER helpers should only run from their trigger/admin
-- paths, not as public RPC endpoints.
revoke all on function public.tutoring_grant_pro_months(uuid, integer) from public, anon, authenticated;
revoke all on function public.tutoring_new_user_subscription() from public, anon, authenticated;
