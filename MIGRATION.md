# Moving to tutoring.bowermaths.co.uk

The code side is done. Nothing in the app or the edge functions refers to
`bowergit.github.io` any more — student links are built from whatever domain
is serving the app, and the Google callback returns to whichever domain
started the connection. So both URLs can be live at once, and the switch is
config rather than code.

What's left is four things in dashboards, in this order.

---

## 1. Cloudflare Pages (~5 min)

Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
→ pick `bowergit/tutoring`.

- Production branch: **master**
- Framework preset: **None**
- Build command: **leave empty**
- Output directory: **/** (the repo root)

There is no build step — it's a single HTML file that compiles itself in the
browser. Anything Cloudflare offers to run will only get in the way.

Deploy. You'll get a `*.pages.dev` URL. Open it and check the app loads and
you can sign in before going further.

## 2. Point the subdomain at it (~2 min)

In that Pages project → **Custom domains** → **Set up a custom domain** →
`tutoring.bowermaths.co.uk`.

Because the domain is already on Cloudflare, it creates the DNS record itself.
Certificate takes a couple of minutes. Your existing site at the apex is not
touched.

## 3. Supabase auth URLs (~2 min)

Supabase → **Authentication** → **URL Configuration** → **Redirect URLs**, add:

```
https://tutoring.bowermaths.co.uk/**
```

This matters: "Forgot password?" passes its own return URL, and Supabase
refuses any that isn't on this list. Without it, password resets from the new
domain fail.

**Leave Site URL alone.** It points at the CEO dashboard, and changing it
would break that app's emails instead. See the note at the bottom.

## 4. Retire the old URL (~2 min) — only once step 2 works

GitHub → repo **Settings** → **Pages** → change the source branch from
`master` to **`legacy-redirect`**.

That branch holds two small redirect pages instead of the app. Every link
already sent to a parent keeps working: `student.html` passes the `?t=<token>`
straight through, so the new page still knows whose lessons to show.

Do not merge that branch into master — Cloudflare builds the real app from
master, and these stubs would replace it.

---

## Not affected — don't change these

**The Google OAuth redirect URI.** It points at
`…supabase.co/functions/v1/google-calendar-auth`, not at the app, so the
domain move doesn't touch it. Leave Google Cloud alone entirely.

**The Monzo redirect.** Same reasoning. If you ever do want to change where
Monzo lands you afterwards, set an `APP_URL` secret in Edge Functions rather
than editing code.

---

## Check it worked

1. `tutoring.bowermaths.co.uk` loads and signs in.
2. Tools → Google Calendar → **Sync now** returns a lesson count.
3. A student's **More tools → Copy link** now gives a
   `tutoring.bowermaths.co.uk/student.html?t=…` link — the app builds it from
   the current domain, so this is the proof the move is complete.
4. An old `bowergit.github.io/tutoring/student.html?t=…` link forwards to the
   new one and still shows the right student.
5. Sign out → **Forgot password?** → the email lands you back on
   `tutoring.bowermaths.co.uk`.

---

## The invite email problem

Supabase allows **one** Site URL per project, and yours points at the CEO
dashboard. The dashboard's **Invite user** button always uses it, which is why
inviting a tutor sends them to the wrong app.

Password resets started from inside the tutoring app are fine — the app sends
its own return URL, which is why step 3 above matters.

So for now: **don't use Invite.** Authentication → Users → **Add user**, set a
password, tick auto-confirm, and send the password separately. That's what you
did for Djavhan and it works.

The real fix is giving the tutoring app **its own Supabase project**, which is
also what you'd want before selling this to anyone. That's a genuine migration
— data, RLS policies, seven edge functions, the cron job and its vault secret
— so it belongs with the SaaS rebrand rather than with a domain change.
