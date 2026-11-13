# TutorTally: notes for Claude

TutorTally (tutortally.co.uk) is a lesson, payment and chasing app for solo
tutors. Static pages plus Supabase. Read this first, then only the section of
the file you are changing. The code comments explain the "why" at each spot;
this file is the map and the rules that must keep holding.

Other docs, read only when relevant: `DESIGN_SYSTEM.md` (how screens look,
tokens, components), `BRAND.md` (voice, naming), `ONBOARDING.md` (how tutors
get accounts, admin SQL), `GOOGLE_CALENDAR_SETUP.md`. `DJAVHAN_SETUP.md`,
`MIGRATION.md` and `PACKAGING.md` are history.

## Shape of the code

| File | What it is |
|---|---|
| `index.html` | The whole tutor app (~10k lines). React 18 + in-browser Babel, one `<script type="text/babel">`. No build step. |
| `admin.html` | `/admin`, plain JS. Data from the `admin-portal` edge function. Has its own `const VERSION`. |
| `app.html` | `/app` marketing page with a scripted demo. Not the real app. |
| `student.html`, `lessons.html` | Parent page and pupil page. Read through the `student-portal` edge function by link token, no login. |
| `worker.js` | Cloudflare Worker in front of the parent/pupil pages only, to put the student's name in link previews. Everything else is static. |
| `weekly-billing.js`, `hourly-billing.js` | Pure helpers shared by the app and the tests (`TTWeekly`, `TTHourly`). |
| `tokens.css`, `ux.css` | Design tokens and shared component CSS. |
| `glide.js` | `TTGlide.toggle(el)` and auto-gliding `<details>` for the parent, pupil and /app pages. Anything that opens must glide, never flick: use this there, and the grid 0fr to 1fr pattern in `index.html`. Bump its `?v=` when changed. |
| `supabase/functions/*` | Every TutorTally edge function, copied from the live project on 13 Nov 2026. See below. |
| `*.sql` | Hand-run migrations, kept for the record. Not applied automatically. |
| `test-weekly.cjs`, `test-hourly.cjs` | `node test-weekly.cjs` / `node test-hourly.cjs`. Run them after touching billing code. |

`index.html` is split by banner comments: `// ---------- Name ----------`.
Find a section with `grep -n "^// ---------- " index.html` and read only that
range. Main ones: Demo mode and billing lock, Billing, Privacy, Calendar,
Monzo, Insights, Export, Note formatting, New in your calendar, Global Tools
Sheet (Settings), Student / Payment modals, Statement, Home Screen tip,
Privacy carried over, Weekly / Hourly tuition, Onboarding walkthrough,
then `function App()` near the end.

## Deploying

- Push to `master` and Cloudflare rebuilds the site (Workers with static
  assets, `wrangler.jsonc`). `.assetsignore` keeps `*.md`, `*.sql`, `*.gs`,
  `*.cjs`, `supabase/` and the worker itself from being served.
- Edge functions are deployed separately to Supabase project
  `uilytgubukiinyrqrltj` (no CLI login here; deploy through the Supabase MCP
  tool with the same `verify_jwt` the function already has). The repo copy is
  the source of truth: edit it, deploy it, commit it. Before deploying, fetch
  the live version and check nobody changed it outside the repo.
- The repo is PUBLIC on GitHub. Functions read every key from Supabase secrets
  (`Deno.env.get`). Never write a key, token or password into a file here.
- Edge functions by job:
  - Calendar: `google-calendar-connect` / `-auth` (OAuth), `-list`, `-select`,
    `-status`, `-disconnect`, `-sync` (+ `ics.ts` for pasted links).
    `-diagnose` is retired (410).
  - Money: `stripe-checkout`, `stripe-portal`, `stripe-webhook` (writes
    `tutoring_subscriptions`), `stripe-refresh`. `stripe-price-diagnose` is disabled.
  - Owner only: `monzo-connect` / `-auth` / `-status` / `-sync` / `-review`,
    `platform-stats`.
  - Pages: `student-portal` (parent and pupil data, weekly agreement signing),
    `student-preview` (first name for link previews), `admin-portal`.
  - Account: `delete-account`.
- Also in the same Supabase project but NOT TutorTally, so not in this repo:
  `social` (Post Desk) and `weight-sync`. Leave them alone.
- Every user-visible change bumps the version: `<div className="version-tag">vX.Y.Z</div>`
  in `index.html`, and `const VERSION` in `admin.html` when admin changes.
  Minor for features, patch for fixes. Put the version first in the commit subject.
- Bump the `?v=` on `tokens.css` / `weekly-billing.js` when you change those
  files, or phones keep the cached copy.
- The owner wants changes committed and pushed to master without asking,
  unless something is risky (data deletion, billing, migrations).

## Data and accounts

- All tables are `tutoring_*`, owned by `owner_id`, with RLS so a tutor only
  ever sees their own rows. Anything cross-tenant goes through an edge function
  holding the service key that checks who is asking first (`admin-portal`
  checks `tutoring_admins`).
- Writes go through `saved(() => supabase...)`. It reports failures to the
  user and returns false. Never fire a write and assume it worked.
- Free plan limit: a database trigger refuses new lessons/students when an
  account is over its free student limit (`tutoring_can_write_account`).
  The app and the sync both expect that refusal; `saved()` stays quiet for it
  because the billing UI explains it.
- `isDanielAccount(session)` gates the owner's own features: Monzo, weekly
  tuition, parent page activity, About & data sources. Other tutors must never
  see them. Admin-only things check the `tutoring_admins` table via
  `supabase.rpc('tutoring_is_admin')`, never an email list.
- `?demo` (`DEMO_MODE`) swaps Supabase for an in-memory stand-in with a demo
  tutor's books. New features should either work in demo or skip cleanly.

## Rules that must keep holding

**Money**
- Balance = completed, chargeable lessons minus payments. Lessons that are
  `cancelled`, `is_complimentary` or `pre_settled` never count. Weekly plans
  cover their lessons (`TTWeekly.covers`). Keep these filters identical
  everywhere balances are computed, including `student-portal`.
- `pre_settled` comes from a per-account `reset_date` on the calendar
  connection. Only the owner's account has one. Other tutors count everything
  from when they joined; do not add global cut-off dates.
- A lesson with a payment attached is never deleted by the calendar sync.

**Calendar sync** (`google-calendar-sync`, live only)
- Runs every two hours via pg_cron, plus on Sync and when a student is added.
  Reads Google (OAuth) or a pasted `.ics` link; if both exist, Google wins.
- Window: 7 days back, 90 ahead. Fetch one day wider than the deletion window.
- An empty calendar read never deletes anything.
- Matching: custom pattern, then full name, then first name, longest first.
  Archived students still claim their own events so they do not fall to
  someone with a similar name.
- Calendar links are secrets (they open the whole calendar). Never send one
  to the browser in admin or logs; send a label (`calendar_kind`) instead.

**Privacy mode** (Settings > Privacy mode)
- Amounts: real, fake (`dummy`) or hidden. Names: real or hidden only; there
  are no fake names any more.
- Masking happens at display time through `useMoney`, `useRawMoney`,
  `useNameDisplay`. Rates are faked at source when `PRIVACY_MONEY_MODE` is
  `dummy`. New screens showing names or money must use these helpers.
- While anything is masked, add/edit forms go read-only so fake values can
  never be saved into real records. Text copied for parents stays real.
- The mode is remembered per device (`localStorage` `tt_privacy_modes`). If it
  was on, it comes back ON and `PrivacyStillOnModal` asks; only the explicit
  "Turn it off" reveals data. Closing the popup any other way keeps it on.
- Switches go through `flipPrivacy()` in `App`, which animates only the text
  that changes (`.pv-swap`). Do not set the modes directly.

**Tips and popups**
- New tutors are not hit with tips. The Home Screen tip waits for 3 separate
  days of use, an active student and no other open overlay, shows once, then
  lives in Settings, and is hidden there when already running as a web app.
  Follow the same pattern for future nudges.
- Overlays use `.overlay` + `.sheet`, `useAnimatedClose`, and `DialogClose`
  (focus trap and Escape). Reuse them.

**Settings menu order** (Global Tools Sheet)
Money, then Lessons and students, then Using the app, then Account, then an
Admin section for owner/admin-only rows at the bottom. Add new rows where a
tutor would look for them, most-used first. Owner-only rows never go in the
tutor sections.

## Writing UI copy

Plain British English, short sentences, says what happens. No em dashes in
anything a user reads. No "seamless", "powerful", "unlock". Name things the
way tutors say them (lesson, parent, owed, paid). See `BRAND.md`.

## Checking your work

- Serve locally with the `tutortally-local` launch config (python http.server
  on 8765). Signing in is not possible there, so test a component by
  Babel-transforming its slice of `index.html` in the page and rendering it, or
  use `?demo` for whole flows.
- After any edit, reload and confirm the sign-in screen still renders (a JSX
  error blanks the whole app).
- Run the two `node test-*.cjs` files after billing changes.
