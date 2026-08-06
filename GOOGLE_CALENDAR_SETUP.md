# Self-serve Google Calendar — one-time setup

Two things you do once, ever. After this, every future tutor (Djavhan, the
1000th person) connects their own calendar themselves, from inside the app,
with zero involvement from you. No more editing `ACCOUNTS` in Apps Script.

---

## 1. Create the Google OAuth client (~10 minutes)

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)**,
   create a new project (or reuse one) — name doesn't matter, e.g.
   "Bower Tutoring".

2. **APIs & Services → Library** → search **"Google Calendar API"** → **Enable**.

3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (your tutors aren't in a Google Workspace org
     you control)
   - App name: `Bower Tutoring` (or whatever — this is what users see on the
     consent screen)
   - Support email: yours
   - Scopes: add `.../auth/calendar.readonly`
   - **Publishing status: leave in "Testing" for now, or push to
     "Production" — see the note below before deciding.**

4. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: anything
   - Authorized redirect URIs — add exactly this, no trailing slash:
     ```
     https://uilytgubukiinyrqrltj.supabase.co/functions/v1/google-calendar-auth
     ```
   - Create. Copy the **Client ID** and **Client Secret** — shown once.

5. **Supabase dashboard → Edge Functions → Manage secrets** — add two:
   - `GOOGLE_CLIENT_ID` → paste
   - `GOOGLE_CLIENT_SECRET` → paste

   Same as you already did for `MONZO_CLIENT_ID`/`MONZO_CLIENT_SECRET` — I
   never see these values, same as those.

### The "unverified app" decision

With Google, this is a real fork, not a technicality:

- **Testing mode**: works immediately, but caps you at 100 *test users* you
  add by hand in the Cloud Console — which defeats "self-serve" past a
  handful of people. Fine for you + Djavhan right now.
- **Production mode**: works for literally anyone, no cap, no list to
  maintain — but shows a **"Google hasn't verified this app"** warning
  during consent until Google reviews it. Users have to click through an
  extra "Advanced → Go to Bower Tutoring (unsafe)"-style link, which reads
  scarier than it is.
- **Verified**: no warning at all. Requires submitting for Google's review
  (a privacy policy URL, possibly a short demo video) — typically 1–4 weeks,
  can run in parallel with real use.

My recommendation: flip to **Production** now (removes the 100-user cap
immediately, that's the thing that actually blocks "1000 people tomorrow"),
accept the unverified warning for now, and submit for verification whenever
you're ready to stop looking slightly sketchy to a stranger signing up. This
doesn't require rebuilding anything later — it's a setting you can change
independently at any time.

---

## 2. Let the sync actually run (~2 minutes)

The nightly sync is scheduled (2:17am UTC, already active) but needs your
service_role key to call it. I can't see or set this myself — deliberately,
it's your project's master key. In the **Supabase SQL Editor**, run:

```sql
select vault.create_secret('PASTE_YOUR_SERVICE_ROLE_KEY_HERE', 'service_role_key_for_cron');
```

Find the key: **Project Settings → API → service_role** (the legacy JWT one,
same key you already used for the Apps Script). Paste it in place of the
placeholder above, run once, done. The very next 2:17am run picks it up
automatically — nothing else to redeploy or reconnect.

---

## That's it. Here's what "self-serve" actually means now

Any signed-in tutor — you, Djavhan, person 1000 — opens **Tools → 📅 Google
Calendar**, taps **Connect Google Calendar**, approves read-only access on
their own Google account, picks which of their calendars has the lessons on
it, done. Their lessons start appearing that night, or immediately if they
tap **Sync now**.

Nobody shares a calendar with you. Nobody waits for you to edit a script.
Nobody's data touches anyone else's — the isolation is enforced the same way
it now is everywhere else in this app (`owner_id`, no exceptions, no
override — see the note in the tutoring_students migration history if you
want the full story on why that phrasing is deliberate).

## What happens to the old Apps Script

Nothing, unless you want it to. `tutoring_sync.gs` keeps running your own
calendar sync exactly as it does today — I haven't touched it, and it's not
at risk from any of this. Once you've tried the new "Connect Google
Calendar" button yourself and I confirm it's pulling your lessons in
correctly, you can turn off the Apps Script trigger and rely on this instead
— one system, not two. Not urgent; happy to help you do that switch whenever
you're ready, or leave both running in parallel indefinitely if you'd rather.

Past-paper sync (`syncPastPapers_` in the same script) is **not** part of
this change — it still runs via Apps Script only, so it still only works for
your own students' sheets. Extending that to be self-serve too is a smaller
follow-up (same OAuth token, just requesting Sheets read access alongside
Calendar) if you want it — say the word.
