# Getting a tutor onto Tutortally

Written 21 Aug 2026. Covers the one-time setup you do once, then the two ways a
tutor gets an account, then the admin commands for everything after.

The short version: a tutor can now sign themselves up at
`tutoring.bowermaths.co.uk/?signup=1`, land on the free plan, and use the app
without you touching anything. You only get involved if you want to.

---

## Part 1 - the one-time setup

Four things. The first two are needed before anyone can sign up. The Stripe ones
are only needed before anyone goes past 3 students.

### 1a. Supabase Auth (needed before the first signup)

Dashboard → **Authentication**:

- **Sign In / Providers → Email**: confirm "Allow new users to sign up" is on.
  It already is, which is how the signup form works at all.
- **Confirm email**: leave on. It stops someone signing up with a stranger's
  address. The app already handles the "check your email" state.
- **URL Configuration → Site URL**: `https://tutoring.bowermaths.co.uk`
- **URL Configuration → Redirect URLs**: add `https://tutoring.bowermaths.co.uk/**`

That last pair matters more than it looks. If a redirect does not match the
allowlist, Supabase silently falls back to the Site URL, and this project's Site
URL has previously pointed at a different app entirely. Password resets and
confirmation links both go through it.

### 1b. Email delivery (needed before the first real signup)

**This is the one that will bite you.** Supabase's built-in email sender is
rate limited to a handful of messages an hour and is explicitly not for
production. If two tutors sign up in the same hour, the second one never gets
their confirmation link and simply thinks the product is broken.

Set up custom SMTP before you send the link to anyone: Dashboard →
**Project Settings → Authentication → SMTP Settings**. Resend or Postmark both
take about ten minutes and are free at this volume. Send from
`noreply@bowermaths.co.uk` so it does not land in spam.

While you are there, edit the **Confirm signup** template. The default says
"Confirm your signup" with no mention of Tutortally, which reads like phishing.

### 1c. Stripe (needed before anyone goes past 3 students)

In the Stripe dashboard, in **test mode** first:

1. **Products → Add product.** Name it `Tutortally Pro`. Price **£5.00 GBP**,
   **recurring, monthly**. Save it and copy the price ID, which looks like
   `price_1Q...`.
2. **Developers → API keys.** Copy the **secret key** (`sk_test_...`).
3. **Developers → Webhooks → Add event destination.**
   Stripe used to call this **Add endpoint**. If your dashboard says
   **Event destination**, that is the right screen.
   - URL: `https://uilytgubukiinyrqrltj.supabase.co/functions/v1/stripe-webhook`
   - Events to send:
     - `checkout.session.completed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.paid`
     - `invoice.payment_failed`
   - Save, then copy the **signing secret** (`whsec_...`).
4. **Settings → Billing → Customer portal → activate it.** Easy to miss, and
   without it the "Manage card, invoices and cancelling" button returns an
   error. While you are there, allow customers to cancel their own
   subscriptions and update payment methods.
5. **Settings → Billing → Automatic collection.** Turn on Smart Retries and the
   emails about failed payments, so dunning is not your job.

Then repeat 1 to 3 in **live mode** when you are ready for real money. The IDs
are different between the two modes.

### 1d. Put the Stripe keys into Supabase

Dashboard → **Project Settings → Edge Functions → Secrets**. Add:

| Name | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` then `sk_live_...` |
| `STRIPE_PRICE_ID` | the `price_...` for Tutortally Pro |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_...` from the event destination |

Paste them straight into the dashboard. Do not put them in a file in this repo,
do not paste them into a chat, and do not email them to yourself.

The three Edge Functions (`stripe-checkout`, `stripe-portal`, `stripe-webhook`)
are already deployed and will start working the moment those secrets exist.

### 1e. Test the money path before a real tutor touches it

With test-mode keys set:

1. Sign in as a test account with 4 or more active students, so the upgrade bar
   appears.
2. Tools → Billing → **Go Pro**.
3. Use Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC.
4. You should come back to `/?billing=done`, see "your subscription is active",
   and the bar should disappear within a few seconds as the webhook lands.
5. Check the row moved:

```sql
select email, plan, stripe_status, current_period_end
from tutoring_account_overview where email = 'the-test-account@example.com';
```

If `stripe_status` stays null, the webhook is not arriving. Stripe's webhook
page shows the delivery attempts and the response body, which is the fastest
way to see why.

---

## Part 2 - how a tutor actually gets in

### The self-serve path (what you want)

1. They land on `tutoring.bowermaths.co.uk/app`.
2. They press **Try the demo** and have a poke around, or go straight to
   **Create my free account**.
3. They enter name, email, password. The account is created, the database
   trigger gives them a free-plan row, and they get a confirmation email.
4. They confirm, sign in, and the walkthrough starts.
5. They connect Google Calendar from Tools, pick their teaching calendar, and
   their lessons appear.
6. Free forever up to 3 active students. On the fourth they hit the upgrade
   prompt.

Nothing on that list needs you.

### The hand-held path (for the first few)

For someone you actually want to keep, do it with them on a call. It takes
about twenty minutes and you will learn more from watching one tutor try to
connect their calendar than from any amount of guessing.

Send them this:

> Go to tutoring.bowermaths.co.uk/app and press "Create my free account".
> Once you're in, share your screen and I'll get your calendar connected.

Then, on the call, the only genuinely fiddly bit is the calendar: their lesson
events need a recognisable student name in the title. If their titles are odd,
set the "calendar title pattern" on each student.

### If you would rather create the account yourself

Dashboard → **Authentication → Users → Add user**. Tick "Auto Confirm User" so
they skip the email. Then send them to the sign-in page and have them use
"Forgot password?" to set their own, so you never know their password.

The subscription row is created automatically by the trigger either way.

---

## Part 3 - admin commands

All of these run in the Supabase SQL editor.

### Who is on what

```sql
select email, plan, active_students, free_student_limit,
       pro_free_until, stripe_status, addons, last_sign_in_at
from tutoring_account_overview
order by joined desc;
```

### Give someone Pro free, permanently (friends, family, you)

```sql
update tutoring_subscriptions set plan = 'comp'
where owner_id = (select id from auth.users where email = 'them@example.com');
```

A comped account never sees a payment prompt, and the Stripe webhook will not
downgrade it.

### Give someone free Pro for a while (beta, referral months, goodwill)

```sql
select tutoring_grant_pro_months(
  (select id from auth.users where email = 'them@example.com'), 3);
```

Adds three months to whatever they already have and returns the new date. They
keep the free plan underneath, so when it runs out they drop back to 3 students
rather than being locked out, unless they are over the limit.

### Change someone's free student limit

```sql
update tutoring_subscriptions set free_student_limit = 10
where owner_id = (select id from auth.users where email = 'them@example.com');
```

Useful for a tutor you want to keep sweet without comping them entirely.

### Take Pro back off someone

```sql
update tutoring_subscriptions
set plan = 'free', pro_free_until = null
where owner_id = (select id from auth.users where email = 'them@example.com');
```

If they have a live Stripe subscription, cancel it in Stripe as well or the
webhook will put them straight back.

---

## Part 4 - how the paywall behaves

Worth knowing so you can answer questions without reading the code.

| Situation | What they get |
|---|---|
| 3 or fewer active students, free plan | Everything. No prompts beyond a quiet bar at exactly 3. |
| At 3, pressing "+ Add" | A modal explaining Pro, with archive suggested as the alternative. |
| Over 3, no Pro | Read-only. They can look and export, but not change. |
| Pro via Stripe | Everything, no limit. |
| Card failed (`past_due`) | Everything, still. Stripe retries for days; locking them out over an expired card is worse. |
| Comped | Everything, forever, no billing UI. |
| Billing row unreadable | Everything. It fails open on purpose. |

That last row matters: a bug in billing must never lock a paying tutor out of
their own records. The code errs towards giving away access.

---

## Part 5 - adding a paid add-on later

The plumbing is built. To sell the Monzo add-on at £5 a month:

1. Create a second Stripe price for it, monthly, £5.
2. Add a secret `STRIPE_ADDON_PRICES` with `{"monzo":"price_ABC123"}`.
3. In `index.html`, find the `ADDONS` array and set `available: true` on it.
4. Build the actual multi-tenant Monzo support, which is the real work and is
   not started. See `PACKAGING.md` for why bank connections are a regulatory
   wall rather than a technical one.

Add-ons ride as extra line items on the same Stripe subscription, so a tutor
gets one invoice however many they have, and the webhook reads the plan and the
add-on list back off the subscription's actual line items. Changing an add-on
after the fact happens in the Stripe billing portal, which handles proration.

---

## Still outstanding

- **Your trading address** on `/terms` and `/privacy`. UK distance selling rules
  expect a geographic address, not just an email.
- **ICO registration.** Processing personal data for a business usually means
  paying the annual data protection fee. Worth ten minutes on their site to
  check whether you are exempt.
- **Custom SMTP**, per 1b. Do this one before you send the link to anybody.
