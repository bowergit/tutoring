# Setting up Djavhan

Superseded 6 Aug 2026 - the calendar-sharing bridge this originally
described is gone. Self-serve Google Calendar OAuth replaced it: he connects
his own calendar himself, from inside the app, and you're not involved.

---

## Send Djavhan this

Hey - here's how to get set up.

**1. Log in.**
Use the password I send you separately (via password.link). Go to
**tutoring.bowermaths.co.uk**, sign in. You'll see an empty app - that's
correct, it's yours alone, I can't see anything you add and you can't see mine.

**2. Add your students.**
Tap **+ Add** for each one. The field that matters most is **"Student's name
in your calendar"** - type exactly the word that'll appear in your Google
Calendar event titles for that student (e.g. if your events are titled "Maths
- Amira", put `Amira` there).

**3. Connect your calendar.**
Tools → **📅 Google Calendar** → **Connect Google Calendar**. Approve
read-only access on your own Google account (you might see an "unverified
app" warning - that's expected for now, not a problem; click through it).
Pick whichever calendar has your lesson bookings on it. Done.

You might see a scary-looking Google warning during that step - expected,
not a mistake, I haven't finished getting the app formally verified by
Google yet.

**4. Tap "Sync now"** to pull your lessons in immediately, rather than
waiting for the automatic overnight sync.

That's genuinely it - no sharing anything with me, no waiting on me to do
anything on my end. Your lessons should just appear.

**What's still manual:** payments - log them yourself (Log a payment on each
student's card). No bank auto-matching for you yet.

---

## Nothing left for Daniel to do

The old "Part 2" here (subscribe to his shared calendar, edit
`tutoring_sync.gs`, add his user id) doesn't apply anymore - none of that
exists in the new flow. If you want to sanity-check his connection worked,
Tools → Google Calendar on your own account won't show his status (it's
per-account), but you can ask me to check `tutoring_google_calendar_auth`
and `tutoring_lessons` for his `owner_id` directly.
