-- Reserved weekly tuition is available only to Daniel's canonical account.
create table public.tutoring_weekly_plans (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.tutoring_students(id) on delete cascade,
  owner_id uuid not null references auth.users(id),
  starts_on date not null,
  ends_before date,
  weekly_fee numeric(10,2) not null default 80 check (weekly_fee = 80),
  lesson_slot text not null check (length(trim(lesson_slot)) between 3 and 200),
  notice_days integer not null default 7 check (notice_days between 1 and 28),
  status text not null default 'proposed' check (status in ('proposed','active','ended')),
  terms_version text not null default '2026-10-15.1',
  terms_text text not null,
  end_requested_at timestamptz,
  review_required boolean not null default false,
  created_at timestamptz not null default now(),
  check (owner_id = 'babb06b5-b5e0-4436-8b72-bc5556814956'),
  check (ends_before is null or ends_before >= starts_on)
);
create index on public.tutoring_weekly_plans(owner_id, student_id);
create table public.tutoring_weekly_acceptances (
  plan_id uuid primary key references public.tutoring_weekly_plans(id) on delete cascade,
  owner_id uuid not null,
  signer_name text not null check (length(trim(signer_name)) between 2 and 150),
  terms_version text not null,
  terms_text text not null,
  start_early boolean not null,
  accepted_at timestamptz not null default now()
);
create index on public.tutoring_weekly_acceptances(owner_id);
create table public.tutoring_weekly_waivers (
  plan_id uuid not null references public.tutoring_weekly_plans(id) on delete cascade,
  charge_date date not null,
  owner_id uuid not null,
  reason text not null check (length(trim(reason)) between 3 and 250),
  created_at timestamptz not null default now(),
  primary key (plan_id, charge_date)
);
create index on public.tutoring_weekly_waivers(owner_id);
alter table public.tutoring_weekly_plans enable row level security;
alter table public.tutoring_weekly_acceptances enable row level security;
alter table public.tutoring_weekly_waivers enable row level security;
revoke all on public.tutoring_weekly_plans, public.tutoring_weekly_acceptances, public.tutoring_weekly_waivers from anon, authenticated;
grant select,insert,update on public.tutoring_weekly_plans to authenticated;
grant select on public.tutoring_weekly_acceptances to authenticated;
grant select,insert,delete on public.tutoring_weekly_waivers to authenticated;
grant all on public.tutoring_weekly_plans, public.tutoring_weekly_acceptances, public.tutoring_weekly_waivers to service_role;
create policy weekly_plan_owner on public.tutoring_weekly_plans to authenticated
  using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id and owner_id = 'babb06b5-b5e0-4436-8b72-bc5556814956'
    and exists (select 1 from public.tutoring_students s where s.id=student_id and s.owner_id=(select auth.uid())));
create policy weekly_acceptance_owner on public.tutoring_weekly_acceptances for select to authenticated using ((select auth.uid())=owner_id);
create policy weekly_waiver_owner on public.tutoring_weekly_waivers to authenticated
  using ((select auth.uid())=owner_id)
  with check ((select auth.uid())=owner_id and exists (select 1 from public.tutoring_weekly_plans p where p.id=plan_id and p.owner_id=(select auth.uid())));

create function public.tutoring_weekly_terms(p public.tutoring_weekly_plans) returns text
language sql stable set search_path = public as $$
select 'Bower Maths: reserved weekly tuition' || E'\n\n' ||
'Tutor: Daniel Bower, Bower Maths. Use the contact details on your parent dashboard to contact Daniel about this agreement.' || E'\n\n' ||
'Your reserved lesson: ' || p.lesson_slot || '. First weekly charge: ' || p.starts_on::text || '.' || E'\n\n' ||
'The fee is �80 every seven days from the first charge date, payable in advance. It reserves one weekly lesson and includes preparation, targeted work, progress tracking and support between lessons. The fee continues during school holidays and when your child cannot attend, including illness, holidays and missed lessons. There is no separate 48 hour cancellation rule for individual lessons under this arrangement.' || E'\n\n' ||
'Please tell Daniel as soon as possible if you cannot attend. Rearrangements depend on availability and mutual agreement; a missed lesson does not automatically entitle you to an additional lesson. An agreed replacement is covered by the original weekly fee.' || E'\n\n' ||
'If Daniel cannot provide the reserved lesson, you may agree a replacement. If no replacement is agreed, that weekly charge is waived. If already paid, you may choose a refund or account credit. Daniel will give as much notice as reasonably possible. Contact Daniel if a charge needs correcting.' || E'\n\n' ||
'You can end weekly tuition by giving ' || p.notice_days::text || ' calendar days of written notice through this dashboard, by email or WhatsApp. Fees remain payable for weekly charge dates before the end date; there are no new charges on or after it. Any final weekly fee covers its full seven day period, and the reserved lesson remains available for that period. There is no additional termination fee. Daniel may agree an earlier end date. Daniel will give at least the same notice to end the arrangement, except where immediate termination is reasonably necessary; unavailable lessons will not be charged.' || E'\n\n' ||
'Payments may be made by an agreed method. You may set up a weekly bank standing order using the details supplied by Daniel. TutorTally records charges and payments; accepting these terms does not authorise a Direct Debit or recurring card payment. Cancel or amend your standing order when tuition ends. Any overpayment will be credited or refunded, as you choose.' || E'\n\n' ||
'For a contract agreed online or by phone, you normally have 14 days from agreement to cancel. Email Daniel or use the dashboard to exercise this right. If you expressly request tuition to start during that period, you may have to pay a proportionate amount for services actually supplied before cancellation, rather than the ordinary notice charges. Contact Daniel for the final calculation. Your statutory consumer rights are unaffected.' || E'\n\n' ||
'The named parent or guardian agrees to pay these fees. The start date, reserved time and terms are recorded with your acceptance. Changes to the fee or these terms require a new agreement. You can print or save a copy of this page. Terms version: ' || p.terms_version || '.';
$$;

create function public.tutoring_guard_weekly_plan() returns trigger language plpgsql set search_path=public as $$
begin
  perform 1 from public.tutoring_students where id=new.student_id and owner_id=new.owner_id for update;
  if not found then raise exception 'Student does not belong to this tutor'; end if;
  if tg_op='INSERT' then
    if new.status <> 'proposed' or new.starts_on < (now() at time zone 'Europe/London')::date then
      raise exception 'Create a proposal starting today or later'; end if;
    new.terms_version := '2026-10-15.1';
    new.terms_text := public.tutoring_weekly_terms(new);
  else
    if row(new.student_id,new.owner_id,new.starts_on,new.weekly_fee,new.lesson_slot,new.notice_days,new.terms_version,new.terms_text)
      is distinct from row(old.student_id,old.owner_id,old.starts_on,old.weekly_fee,old.lesson_slot,old.notice_days,old.terms_version,old.terms_text)
      then raise exception 'Create a new proposal to change the agreement'; end if;
    if old.status in ('active','ended') and new.status='proposed' then raise exception 'An active agreement cannot become a proposal'; end if;
    if old.status='ended' and new.status<>'ended' then raise exception 'An ended agreement cannot be restarted'; end if;
    if old.ends_before is not null and (new.ends_before is null or new.ends_before>old.ends_before) then raise exception 'An end date cannot be extended'; end if;
    if new.ends_before is not null and (old.ends_before is null or new.ends_before<old.ends_before) and new.ends_before < (now() at time zone 'Europe/London')::date then raise exception 'End dates cannot be backdated'; end if;
  end if;
  if new.status='active' and old.status is distinct from 'active' and not exists(select 1 from public.tutoring_weekly_acceptances where plan_id=new.id) then
    raise exception 'The parent must accept the terms before activation'; end if;
  if new.status='active' and new.starts_on < (now() at time zone 'Europe/London')::date and old.status='proposed' then
    raise exception 'Start date has passed. End this proposal and create a new one'; end if;
  if exists(select 1 from public.tutoring_weekly_plans p where p.student_id=new.student_id and p.id<>new.id
    and p.status<>'ended' and new.status<>'ended') then raise exception 'This student already has an open weekly arrangement'; end if;
  if new.status in ('active','ended') and exists(select 1 from public.tutoring_weekly_plans p where p.student_id=new.student_id and p.id<>new.id and p.status in ('active','ended')
    and daterange(p.starts_on,p.ends_before,'[)') && daterange(new.starts_on,new.ends_before,'[)')) then
    raise exception 'Weekly billing periods cannot overlap'; end if;
  return new;
end $$;
create trigger guard_weekly_plan before insert or update on public.tutoring_weekly_plans for each row execute function public.tutoring_guard_weekly_plan();

create function public.tutoring_guard_weekly_record() returns trigger language plpgsql set search_path=public as $$
declare p public.tutoring_weekly_plans;
begin
  select * into p from public.tutoring_weekly_plans where id=new.plan_id for update;
  if not found or p.owner_id<>new.owner_id then raise exception 'Invalid agreement'; end if;
  if tg_table_name='tutoring_weekly_acceptances' then
    if p.status<>'proposed' then raise exception 'This proposal is no longer available'; end if;
    new.terms_text:=p.terms_text; new.terms_version:=p.terms_version; new.accepted_at:=now();
    if p.starts_on<(now() at time zone 'Europe/London')::date+14 and not new.start_early then raise exception 'Please request an early start or ask Daniel for a later start date'; end if;
  else
    if p.status not in ('active','ended') or new.charge_date<p.starts_on or (p.ends_before is not null and new.charge_date>=p.ends_before)
       or (new.charge_date-p.starts_on)%7<>0 then raise exception 'Not a weekly charge date'; end if;
  end if;
  return new;
end $$;
create trigger guard_weekly_acceptance before insert on public.tutoring_weekly_acceptances for each row execute function public.tutoring_guard_weekly_record();
create trigger guard_weekly_waiver before insert on public.tutoring_weekly_waivers for each row execute function public.tutoring_guard_weekly_record();

create view public.tutoring_weekly_charges with (security_invoker=true) as
select p.id as plan_id,p.student_id,p.owner_id,(p.starts_on+n*7)::date as charge_date,
  case when w.plan_id is null then p.weekly_fee else 0 end as amount,
  w.plan_id is not null as waived,w.reason
from public.tutoring_weekly_plans p
cross join lateral generate_series(0, greatest(-1, (least(coalesce(p.ends_before-1,(now() at time zone 'Europe/London')::date+183),(now() at time zone 'Europe/London')::date+183)-p.starts_on)/7)) n
left join public.tutoring_weekly_waivers w on w.plan_id=p.id and w.charge_date=p.starts_on+n*7
where p.status in ('active','ended') and exists(select 1 from public.tutoring_weekly_acceptances a where a.plan_id=p.id) and (p.ends_before is null or p.starts_on+n*7<p.ends_before)
  and p.starts_on+n*7<=(now() at time zone 'Europe/London')::date+183;
grant select on public.tutoring_weekly_charges to authenticated,service_role;
revoke all on function public.tutoring_weekly_terms(public.tutoring_weekly_plans),public.tutoring_guard_weekly_plan(),public.tutoring_guard_weekly_record() from public,anon;
grant execute on function public.tutoring_weekly_terms(public.tutoring_weekly_plans) to authenticated,service_role;

-- Covered lessons have no separate fee. The weekly ledger is authoritative.
create or replace function public.tutoring_lesson_rate(p_lesson_id uuid) returns numeric language sql stable set search_path=public as $$
select case when exists(select 1 from public.tutoring_weekly_plans p where p.student_id=l.student_id and p.owner_id=l.owner_id
  and p.status in ('active','ended') and exists(select 1 from public.tutoring_weekly_acceptances a where a.plan_id=p.id) and l.lesson_date>=p.starts_on and (p.ends_before is null or l.lesson_date < p.starts_on+((p.ends_before-p.starts_on+6)/7)*7)) then 0
else coalesce(l.rate_charged,(select rh.rate from public.tutoring_rate_history rh where rh.student_id=l.student_id and rh.effective_from_date<=l.lesson_date order by rh.effective_from_date desc,rh.created_at desc limit 1),90) end
from public.tutoring_lessons l where l.id=p_lesson_id;
$$;
create function public.tutoring_weekly_reallocate() returns trigger language plpgsql set search_path=public as $$
begin
  if new.status in ('active','ended') then perform public.reallocate_student_payments(new.student_id); end if;
  return new;
end $$;
create trigger reallocate_weekly after update on public.tutoring_weekly_plans for each row execute function public.tutoring_weekly_reallocate();
revoke all on function public.tutoring_weekly_reallocate() from public,anon,authenticated;
