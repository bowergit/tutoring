-- Refer a tutor.
--
-- Every tutor gets a short code; their link is /app?ref=CODE. Whoever signs up
-- through it is recorded against them at the moment the account is created,
-- from the code the sign-up form puts in the user's metadata. Tutors see their
-- own link, how many signed up, how many are paying, and each one's first name.
--
-- Both tables are locked (RLS on, no policies). Tutors only ever reach them
-- through tutoring_my_referrals(), which answers about the caller and nobody
-- else. admin-portal reads them with the service key.

create table if not exists public.tutoring_referral_codes (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.tutoring_referrals (
  referee_id uuid primary key references auth.users(id) on delete cascade,
  referrer_id uuid not null references auth.users(id) on delete cascade,
  code text,
  referee_first_name text,
  created_at timestamptz not null default now()
);
create index if not exists tutoring_referrals_referrer_idx on public.tutoring_referrals(referrer_id);

alter table public.tutoring_referral_codes enable row level security;
alter table public.tutoring_referrals enable row level security;

-- Runs when an account is created. It must never stop a sign-up, so any
-- failure in here is swallowed and the account is created regardless.
create or replace function public.tutoring_record_referral()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := lower(trim(coalesce(new.raw_user_meta_data->>'referred_by', '')));
  v_referrer uuid;
begin
  if v_code = '' then return new; end if;
  select owner_id into v_referrer from public.tutoring_referral_codes where code = v_code;
  if v_referrer is null or v_referrer = new.id then return new; end if;
  insert into public.tutoring_referrals (referee_id, referrer_id, code, referee_first_name)
  values (
    new.id, v_referrer, v_code,
    nullif(split_part(trim(coalesce(new.raw_user_meta_data->>'display_name', '')), ' ', 1), '')
  )
  on conflict (referee_id) do nothing;
  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists tutoring_on_auth_user_referral on auth.users;
create trigger tutoring_on_auth_user_referral
  after insert on auth.users
  for each row execute function public.tutoring_record_referral();

-- The caller's own code (made on first ask) and who joined through it.
-- "Paying" means a live Pro subscription right now.
create or replace function public.tutoring_my_referrals()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_try int := 0;
begin
  if v_uid is null then raise exception 'not signed in'; end if;
  select code into v_code from public.tutoring_referral_codes where owner_id = v_uid;
  while v_code is null and v_try < 8 loop
    v_try := v_try + 1;
    begin
      insert into public.tutoring_referral_codes (owner_id, code)
      values (v_uid, substr(md5(gen_random_uuid()::text), 1, 6))
      returning code into v_code;
    exception when unique_violation then
      select code into v_code from public.tutoring_referral_codes where owner_id = v_uid;
    end;
  end loop;

  return json_build_object(
    'code', v_code,
    'referrals', coalesce((
      select json_agg(json_build_object(
        'first_name', coalesce(
          nullif(split_part(trim(coalesce(u.raw_user_meta_data->>'display_name', '')), ' ', 1), ''),
          r.referee_first_name),
        'joined', r.created_at,
        'paying', coalesce(s.stripe_status in ('active', 'past_due'), false)
      ) order by r.created_at desc)
      from public.tutoring_referrals r
      left join auth.users u on u.id = r.referee_id
      left join public.tutoring_subscriptions s on s.owner_id = r.referee_id
      where r.referrer_id = v_uid
    ), '[]'::json)
  );
end;
$$;

revoke all on function public.tutoring_my_referrals() from public, anon;
grant execute on function public.tutoring_my_referrals() to authenticated;
revoke all on function public.tutoring_record_referral() from public, anon, authenticated;
