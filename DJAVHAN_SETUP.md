# Setting up Djavhan

Two parts: what to send him, and what you do once he's replied "done".

---

## Part 1 — send Djavhan this (copy from here down)

Hey — here's how to get set up.

**1. Accept the invite and set your password.**
Use the link I sent separately. If you'd rather I just send you a password
directly, I'll do it through [password.link](https://password.link/en) —
open it, view it once, and it's gone.

**2. Log in.**
Go to **bowergit.github.io/tutoring** and sign in with your email and that
password. You'll see an empty app — that's correct, it's yours alone, I can't
see anything you add and you can't see mine.

**3. Add your students.**
Tap **+ Add** for each one. The field that matters most is **"Student's name
in your calendar"** — type exactly the word that'll appear in your Google
Calendar event titles for that student (e.g. if your events are titled "Maths
— Amira", put `Amira` there). That's what links a calendar event to the right
student, so get it close to exact.

**4. Create a dedicated lessons calendar.**
In Google Calendar, make a **new calendar** just for lesson bookings — don't
reuse a calendar you already use for personal or other things. Name it
something clearly yours, like **"Djavhan Lessons"** (not just "Tutoring" —
if we ever both use that name it'll cause problems, so somewhat unique is
important).

Put every lesson on that calendar, titled so it contains the student's name
you set in step 3.

**5. Share that calendar with me.**
In Google Calendar → your new calendar → **Settings and sharing** → **Share
with specific people** → add my email (`danielbowermagic@gmail.com`) → access
level **"See all event details"** (you don't need to give edit access).

**6. Tell me once it's shared.** I'll take it from there — nothing more for
you to do. Your lessons will start appearing in the app automatically
overnight; the same for your students' past-paper trackers, if you use
sheets in a similar format to mine (has a "Date taken" column) and paste the
sheet link into each student's profile.

**What this doesn't do yet:** payments are manual — log them yourself (Log a
payment on each student's card). No bank auto-matching for you at the moment.

---

## Part 2 — what YOU do once he confirms the calendar is shared

1. **Subscribe to his calendar.** Open Google Calendar → under "Other
   calendars" find "Djavhan Lessons" (may take a minute to appear after he
   shares it) → click it once so it's actually added to your calendar list.
   Sharing alone isn't enough — the sync script only sees calendars you've
   added, not merely ones shared with you.

2. **Get his user id.** Supabase dashboard → Authentication → Users → find
   his email → copy the UUID next to it.

3. **Edit `tutoring_sync.gs`.** Uncomment the second entry in `ACCOUNTS` near
   the top and fill in his real user id:

   ```js
   {
     label: 'Djavhan',
     calendarName: 'Djavhan Lessons',
     ownerId: 'PASTE-HIS-ID-HERE',
     resetDate: '2000-01-01',
   },
   ```

   Leave `resetDate` in the past like that — don't copy your own
   `2026-07-27`. That date means "everything before this is already paid
   for and should never show as owing." Copying yours would wipe out his
   real balances the moment his lessons start syncing in.

4. **Save.** Nothing else to do — the one daily trigger you already have
   covers both of you now. No second trigger needed.

5. **Run `syncTutoring` manually once** to pull in his existing lessons
   immediately rather than waiting for the next nightly run, and check the
   execution log for a `[Djavhan]` line confirming it found his calendar and
   matched students.

## Why it works this way (for you, not him)

He never touches Apps Script, never sees your Supabase key, and never gets
any access to your data — the whole bridge runs on your side, through a
calendar share, same as you'd share a calendar with anyone. His lessons are
tagged with his own account id the moment they're written, so the isolation
that keeps his data separate from yours in the app holds here too.

This scales to maybe 2–4 people sharing calendars with you like this before
it gets tedious. Past that, it's worth building a real "connect your own
Google Calendar" button (Phase 1 in `PACKAGING.md`) instead of you manually
subscribing to everyone's calendar.
