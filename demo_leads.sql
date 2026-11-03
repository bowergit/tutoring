-- Numbers left by visitors to the demo (/?demo=1).
--
-- The demo asks for a mobile number so its WhatsApp buttons can send the
-- generated messages to the visitor's own phone. A row is written here unless
-- they tick the box saying they don't want to be contacted about their
-- experience. consent_text keeps the wording they were shown.
--
-- The public site can only add rows. Nobody can read them through the API:
-- the admin-portal function reads them with the service key after checking
-- the caller is on tutoring_admins.

create table if not exists public.tutoring_demo_leads (
  id uuid primary key default gen_random_uuid(),
  -- International digits, as the app stores every phone: 447700900123.
  phone text not null check (phone ~ '^[1-9][0-9]{9,14}$'),
  consent_text text not null check (char_length(consent_text) between 10 and 300),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now()
);

create index if not exists tutoring_demo_leads_phone_idx on public.tutoring_demo_leads (phone);

alter table public.tutoring_demo_leads enable row level security;

drop policy if exists "demo visitors can leave a number" on public.tutoring_demo_leads;
create policy "demo visitors can leave a number" on public.tutoring_demo_leads
  for insert to anon, authenticated
  with check (true);

revoke all on public.tutoring_demo_leads from anon, authenticated;
grant insert on public.tutoring_demo_leads to anon, authenticated;
