# Packaging this for other people

Written 3 Aug 2026. A plan for turning a single-user tool into something
Jeevan (tutor) or Michael (personal trainer) could pay for.

## The short answer

**Do one thing now — add `owner_id` to every table. Then stop and validate.**

That is roughly two hours of work. It is the only change that gets
dramatically more expensive the longer it is left, because retrofitting
multi-tenancy onto live data with real payments attached is a migration you do
not want to be doing at 11pm because a friend wants a login.

Everything else — signup screens, billing, onboarding, generic wording — costs
about the same whether it is built now or in a year. So there is no reason to
build any of it before someone has actually asked to pay.

Do not build a white-labelled product yet. Build the foundation that makes one
possible, then go and find out whether anybody wants it.

## Why not "just keep it bespoke"

Because of one specific thing: the moment a second person's data is in the
database, every table needs to know whose row is whose. Adding a column to six
tables today is trivial. Doing it once there are two people's payments,
allocations and lesson histories in there means backfilling ownership by
inference, and getting it wrong means one tutor sees another's students.

That is the whole argument. Everything else genuinely can wait.

## Why not "build the full product now"

Three reasons, in order of severity.

### 1. The bank connection is a legal wall, not a technical one

Monzo's developer API is for accessing **your own** account. Building a
commercial product where other people connect *their* bank accounts is
regulated activity in the UK — you would need to be an FCA-authorised Account
Information Service Provider, or go through one (TrueLayer, Plaid, GoCardless
Open Banking). That means compliance work and a per-user cost, before a single
customer.

It is also UK-only, which caps the market on day one.

**Recommendation: version one for other people has no bank sync at all.**
Manual payment entry, which already works well. The automatic Monzo matching
stays as your own private advantage. If bank sync turns out to be the thing
people will pay for, that is a strong signal — and a much easier decision to
fund once there is revenue.

### 2. The calendar sync is tied to your Google account

The Apps Script runs as *you*. It cannot read Jeevan's calendar. Supporting
other users means Google OAuth plus a server-side sync running on a schedule
in Supabase, replacing the Apps Script entirely for new users.

This one is genuinely solvable — call it one to two days — but it is real work
and it is a prerequisite for anyone else using it properly. Without calendar
sync they are typing lessons in by hand, which is a much weaker product.

### 3. A personal trainer is a different product, not a setting

Students/lessons/exam boards/school years/past papers versus
clients/sessions/programmes/personal bests. The *core* is genuinely shared —
recurring appointments, who owes what, reconciling against money in — but the
layer on top is not.

Trying to serve both before either is proven usually produces something
mediocre at both. Get tutoring genuinely good first. If Michael still wants it
after seeing it, that is when to find out how thin the shared core really is.

## Phases

### Phase 0 — now, ~2 hours

- `owner_id UUID` on students, lessons, payments, bundles, rate_history,
  allocations. Backfill to your user id.
- RLS policies become `owner_id = auth.uid()` instead of the current
  email allowlist.
- App sets `owner_id` on insert.
- Nothing else changes. It still looks and behaves exactly as it does now.

**DONE — 3 Aug 2026** (migration `phase0_owner_id`), with two deliberate
deviations from the plan above:

- The policy is `owner_id = auth.uid() OR is_app_owner()`, not a pure uid
  check. Daniel has two personal accounts on this project, and a strict
  policy would show an empty app — indistinguishable from data loss — when
  signed in with the "wrong" one. The override doubles as an operator view
  of tenant data; drop `is_app_owner()` from the policy before promising
  anyone data privacy in writing.
- The app does NOT set `owner_id` on insert. Every current writer (app,
  calendar sync, Monzo functions) is Daniel, so the column DEFAULT owns new
  rows — and an app-set `auth.uid()` would have fragmented his data across
  his two accounts. Phase 1 drops the default and makes writers explicit.
  `allocate_payment()` already copies the payment's owner properly.

Verified by simulating JWTs in-database: both of Daniel's accounts see all
rows, a stranger's account sees zero and cannot insert, anonymous requests
get `[]`/401, and Edge Functions (service role) are unaffected.

After this, adding a second user is a row in a table, not a migration.

### Phase 1 — only once someone has said yes, ~1 week

- Invite-only signup (you create accounts; no public sign-up form).
- Google Calendar via OAuth with a server-side scheduled sync.
- Per-user settings: targets, default rate, ignore patterns — all currently
  hardcoded constants.
- Manual payments only. No bank connection.
- Still no billing. Charge them by bank transfer if it comes to it; Stripe is
  a week of work to avoid one invoice a month.

**Google Calendar OAuth — DONE, 6 Aug 2026**, ahead of the "once someone has
said yes" gate above, because the Apps Script bridge (share-your-calendar-
with-Daniel) turned out not to survive contact with a real second tutor —
every new person meant Daniel manually editing a config array and manually
subscribing to their calendar. Full details in `GOOGLE_CALENDAR_SETUP.md`,
short version: seven Edge Functions (`google-calendar-connect/auth/list/
select/status/disconnect/sync`), two new tables
(`tutoring_google_calendar_auth`, `tutoring_oauth_state`), a `pg_cron` job
calling the sync function nightly via a key stored in Supabase Vault (never
pasted into a migration or seen by the assistant). Any signed-in tutor
connects their own calendar from inside the app; no admin step per user.
`tutoring_sync.gs` keeps running Daniel's own calendar sync in parallel until
he's verified the new path and chooses to retire it — nothing forced the
switch. Past-paper sync is unaffected and still Apps-Script-only.

### Phase 2 — only at ~5 paying users, ~2 weeks

- Stripe subscriptions and a billing page.
- Self-serve signup and onboarding.
- Own domain, proper error reporting, a support inbox.

### Phase 3 — only when demand is proven

- Configurable terminology so a PT sees "clients" and "sessions".
- Vertical-specific fields.

## Validating without building anything

The cheapest possible test, available the day Phase 0 lands:

**Give Jeevan a login on your instance.** He becomes a second `owner_id`. He
sees only his own data. He types his students in by hand, because there is no
calendar sync for him yet.

Then watch for the only thing that matters: **is he still using it in three
weeks?** Not "does he like it", not "would he pay" — people are kind and both
answers will be yes. Whether he opens it unprompted in week three is the real
signal.

If he does, Phase 1 is justified. If he does not, you have learned that for
the cost of an afternoon.

## The money, honestly

At £10/month:

| Subscribers | Monthly | Equivalent tutoring |
|---|---|---|
| 10 | £100 | about one hour |
| 50 | £500 | about five hours |
| 100 | £1,000 | about ten hours |

Ten users is one hour of tutoring a month, and ten users will generate more
than an hour a month of support — someone's calendar will not connect, someone
will not understand why a payment did not match. Support does not scale down.

This becomes worth it somewhere north of fifty users, or at a higher price.
Worth asking whether £25/month for something that reconciles a tutor's income
automatically is closer to the real value, particularly if bank matching ever
does get built. Ten pounds is priced like a note-taking app; this is closer to
bookkeeping.

None of which is an argument against doing it. It is an argument for not
spending three weeks on billing infrastructure before knowing whether the
second user opens it in week three.

## What to do this week

1. Phase 0. Two hours, and it stops the door closing.
2. Show Jeevan the actual app. Not a description — the thing.
3. If he wants it, give him a login and wait three weeks.

Everything else is downstream of what happens in step 3.
