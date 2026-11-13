// deno-lint-ignore-file no-explicit-any
//
// The admin panel's only way in.
//
// Everything here reads across tenants, which is exactly what the rest of the
// app spends its RLS policies preventing. So this function holds the service
// key, and the first thing it does on every single request is establish who is
// asking and whether they are on the admins table. There is no path through
// this file that touches another tutor's data before that check has passed.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

// A comped account is granted in whole months and never silently for ever. If
// someone needs longer, that is a second deliberate grant.
const MAX_GRANT_MONTHS = 12
const NOTE_MAX = 4000
// Enough for every note any tester will write; a cap only so one chatty account
// cannot make the panel unloadable for everyone.
const NOTE_FETCH_LIMIT = 2000
// Same reasoning for demo visitors: a cap so a burst of spam rows can never
// make the panel unloadable.
const LEAD_FETCH_LIMIT = 2000

const SEGMENT_LABEL: Record<string, string> = {
  tester: 'Beta testers',
  team: 'Team',
  test: 'Test accounts',
}

// Stripe statuses where the customer is on the hook for money. Trialing is not
// income yet, and counting it would make the headline number a forecast.
const PAYING = new Set(['active', 'past_due'])
// Long enough for a slow Stripe day, short enough that the rest of the panel
// never waits on it. Income is useful; the account list is essential.
const STRIPE_TIMEOUT_MS = 7000

const json = (b: any, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

function env(name: string) { return (Deno.env.get(name) ?? '').trim() }

function addMonths(from: Date, months: number): string {
  const d = new Date(from.getTime())
  const day = d.getDate()
  d.setMonth(d.getMonth() + months)
  // Granting on the 31st for a month that has 30 days would otherwise roll
  // into the following month and quietly hand out an extra day or two.
  if (d.getDate() < day) d.setDate(0)
  return d.toISOString().slice(0, 10)
}

function isUuid(s: unknown): boolean {
  return typeof s === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

function isPhone(s: unknown): boolean {
  return typeof s === 'string' && /^[1-9][0-9]{9,14}$/.test(s)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('stripe timeout')), ms)),
  ])
}

// What one subscription line is worth per month, from the price Stripe actually
// charges rather than a figure typed into this file. A yearly plan or a second
// add-on then shows up correctly without anyone remembering to update it here.
function monthlyPence(item: any): number {
  const price = item?.price
  const r = price?.recurring
  if (!r) return 0
  const unit = Number(price.unit_amount ?? 0) * Number(item?.quantity ?? 1)
  const every = Number(r.interval_count || 1)
  switch (r.interval) {
    case 'month': return unit / every
    case 'year': return unit / (12 * every)
    case 'week': return (unit * 52) / 12 / every
    case 'day': return (unit * 365) / 12 / every
  }
  return 0
}

const DAY = 86400000

/**
 * Straight from Stripe, every time the panel loads. The database only knows
 * what the webhook last told it, and a missed webhook would otherwise show as
 * money that never arrived. Started in parallel with the account query and
 * never allowed to fail the page: if Stripe is slow or down, the panel says so
 * and everything else still loads.
 */
async function fetchStripe(): Promise<any> {
  const key = env('STRIPE_SECRET_KEY')
  if (!key) return { available: false, problem: 'Stripe is not connected yet.' }
  const stripe = new Stripe(key, { httpClient: Stripe.createFetchHttpClient() })
  const priceId = env('STRIPE_PRICE_ID')
  try {
    const [charges, subs, price] = await withTimeout(Promise.all([
      stripe.charges.list({ limit: 100 }).autoPagingToArray({ limit: 5000 }),
      stripe.subscriptions.list({ status: 'all', limit: 100 }).autoPagingToArray({ limit: 2000 }),
      priceId ? stripe.prices.retrieve(priceId).catch(() => null) : Promise.resolve(null),
    ]), STRIPE_TIMEOUT_MS)
    return {
      available: true,
      // From the key rather than from any one charge, so an account with no
      // payments yet still says which mode it is in.
      live: /^(sk|rk)_live_/.test(key),
      charges,
      subs,
      pro_price_pence: price?.unit_amount ?? null,
    }
  } catch (e) {
    console.error('admin-portal: stripe fetch failed', (e as any)?.message)
    return { available: false, problem: 'Could not reach Stripe just now.' }
  }
}

function summariseIncome(raw: any, customerToOwner: Map<string, string>, segmentOf: Map<string, string>) {
  if (!raw.available) return { income: { available: false, problem: raw.problem }, byOwner: new Map() }

  const byOwner = new Map<string, any>()
  const entry = (ownerId: string) => {
    let e = byOwner.get(ownerId)
    if (!e) {
      e = { collected_pence: 0, refunded_pence: 0, charges: 0, first_paid_at: null, last_paid_at: null }
      byOwner.set(ownerId, e)
    }
    return e
  }
  const ownerOfCustomer = (c: any) =>
    customerToOwner.get(typeof c === 'string' ? c : c?.id ?? '') ?? null

  // Money that came from our own test logins is real money moving, but it is
  // us paying ourselves. It is shown, and left out of the headline.
  const isTest = (ownerId: string | null) => !!ownerId && segmentOf.get(ownerId) === 'test'

  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const monthStartSec = monthStart.getTime() / 1000

  let collected = 0, thisMonth = 0, excludedPence = 0, excludedCount = 0
  const recent: any[] = []

  for (const ch of raw.charges as any[]) {
    if (ch.status !== 'succeeded' || !ch.paid) continue
    if (String(ch.currency).toLowerCase() !== 'gbp') continue
    const net = Number(ch.amount_captured ?? ch.amount ?? 0) - Number(ch.amount_refunded ?? 0)
    const ownerId = ownerOfCustomer(ch.customer)
    if (ownerId) {
      const e = entry(ownerId)
      e.collected_pence += net
      e.refunded_pence += Number(ch.amount_refunded ?? 0)
      e.charges += 1
      const at = new Date(ch.created * 1000).toISOString()
      if (!e.first_paid_at || at < e.first_paid_at) e.first_paid_at = at
      if (!e.last_paid_at || at > e.last_paid_at) e.last_paid_at = at
    }
    if (isTest(ownerId)) { excludedPence += net; excludedCount += 1; continue }
    collected += net
    if (ch.created >= monthStartSec) thisMonth += net
    if (recent.length < 8) {
      recent.push({
        owner_id: ownerId,
        amount_pence: Number(ch.amount_captured ?? ch.amount ?? 0),
        refunded_pence: Number(ch.amount_refunded ?? 0),
        at: new Date(ch.created * 1000).toISOString(),
      })
    }
  }

  let mrr = 0, paying = 0, trialing = 0
  for (const sub of raw.subs as any[]) {
    const ownerId = sub.metadata?.owner_id || ownerOfCustomer(sub.customer)
    const monthly = Math.round((sub.items?.data ?? []).reduce((t: number, i: any) => t + monthlyPence(i), 0))
    if (ownerId) {
      const e = entry(ownerId)
      // One account can have an old cancelled subscription and a new live one.
      // The live one is the one that describes them.
      const rank = (s: string) => PAYING.has(s) ? 3 : s === 'trialing' ? 2 : 1
      if (!e.status || rank(sub.status) > rank(e.status)) {
        e.status = sub.status
        e.mrr_pence = PAYING.has(sub.status) ? monthly : 0
        e.cancel_at_period_end = !!sub.cancel_at_period_end
        const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end ?? null
        e.current_period_end = end ? new Date(end * 1000).toISOString() : null
        e.since = sub.start_date ? new Date(sub.start_date * 1000).toISOString() : null
      }
    }
    if (isTest(ownerId)) continue
    if (PAYING.has(sub.status)) { mrr += monthly; paying += 1 }
    else if (sub.status === 'trialing') trialing += 1
  }

  return {
    byOwner,
    income: {
      available: true,
      live: raw.live,
      mrr_pence: mrr,
      paying,
      trialing,
      collected_pence: collected,
      this_month_pence: thisMonth,
      excluded_pence: excludedPence,
      excluded_count: excludedCount,
      pro_price_pence: raw.pro_price_pence,
      recent,
    },
  }
}

/**
 * Demo visitors who left a number without opting out, one entry per
 * phone however many times they came back. Matched to an account when a tutor
 * has the same number in their settings, so a visitor who has since signed up
 * shows as that tutor rather than as a stranger to chase.
 */
function summariseLeads(rows: any[], accounts: any[]) {
  const ownerByPhone = new Map<string, any>()
  for (const a of accounts) if (a.contact_phone) ownerByPhone.set(String(a.contact_phone), a)
  const byPhone = new Map<string, any>()
  for (const r of rows) {
    let e = byPhone.get(r.phone)
    if (!e) {
      e = { phone: r.phone, first_seen: r.created_at, last_seen: r.created_at, visits: 0, consent_text: r.consent_text }
      byPhone.set(r.phone, e)
    }
    e.visits += 1
    if (r.created_at < e.first_seen) e.first_seen = r.created_at
    if (r.created_at > e.last_seen) { e.last_seen = r.created_at; e.consent_text = r.consent_text }
  }
  return [...byPhone.values()].map(e => {
    const acct = ownerByPhone.get(e.phone)
    return {
      ...e,
      owner_id: acct?.owner_id ?? null,
      owner_name: acct ? (acct.display_name || acct.email || null) : null,
    }
  }).sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1))
}

// Names the calendar app behind a pasted link from its address alone. Only
// the label comes back, never any part of the link that grants access.
function calendarFeedKind(url: string | null): string {
  let host = ''
  try { host = new URL(String(url ?? '').trim().replace(/^webcals?:\/\//i, 'https://')).hostname.toLowerCase() } catch { return 'Other' }
  if (/(^|\.)icloud\.com$|(^|\.)me\.com$/.test(host)) return 'Apple'
  if (/outlook\.|office365\.|office\.com$|live\.com$|hotmail\.|microsoft/.test(host)) return 'Outlook'
  if (/(^|\.)google\.com$|googleusercontent\.com$/.test(host)) return 'Google (link)'
  if (/yahoo\./.test(host)) return 'Yahoo'
  if (/proton\./.test(host)) return 'Proton'
  if (/fastmail\./.test(host)) return 'Fastmail'
  // Anything else is named by its site, minus the www, which is enough to
  // spot a booking tool (Calendly, TutorCruncher...) worth supporting.
  return host ? 'Other: ' + host.replace(/^www\./, '') : 'Other'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  if (!bearer) return json({ ok: false, problem: 'unauthorized' }, 401)

  const { data: userData, error: userErr } = await supabase.auth.getUser(bearer)
  const me = userData?.user
  if (userErr || !me) return json({ ok: false, problem: 'unauthorized' }, 401)

  const { data: adminRow } = await supabase.from('tutoring_admins')
    .select('user_id').eq('user_id', me.id).maybeSingle()
  // Deliberately the same answer as an unknown route. An account that is not an
  // admin should not be able to learn that this endpoint exists and matters.
  if (!adminRow) return json({ ok: false, problem: 'not_found' }, 404)

  let body: any = {}
  if (req.method === 'POST') {
    try { body = await req.json() } catch { body = {} }
  }
  const action = String(body.action ?? 'list')

  // ---- Everything below this line runs only for a confirmed admin. ----

  if (action === 'list') {
    // Counted in the database rather than by fetching every row and counting in
    // here: PostgREST caps a response at db-max-rows, so the fetch-and-count
    // version would have started under-reporting usage for everyone, silently,
    // as soon as there were a few thousand lessons across all tenants.
    const stripeP = fetchStripe()
    const [{ data: rows, error: rowsErr }, { data: notes }, { data: leadRows }, { data: feedRows }] = await Promise.all([
      supabase.rpc('tutoring_admin_accounts'),
      supabase.from('tutoring_account_notes')
        .select('owner_id,body,created_at,author_id')
        .order('created_at', { ascending: false })
        .limit(NOTE_FETCH_LIMIT),
      // Never allowed to fail the page: before the table exists, or if it
      // errors, the panel simply shows no demo visitors.
      supabase.from('tutoring_demo_leads')
        .select('phone,consent_text,created_at')
        .order('created_at', { ascending: false })
        .limit(LEAD_FETCH_LIMIT),
      // Read only to say whose calendar it is (Apple, Outlook...). The link
      // itself is a password to their whole calendar, so it never leaves here.
      supabase.from('tutoring_calendar_feeds').select('owner_id,url'),
    ])
    if (rowsErr) return json({ ok: false, problem: 'list_failed', detail: rowsErr.message })

    const feedKindOf = new Map<string, string>(
      (feedRows ?? []).map((f: any) => [f.owner_id, calendarFeedKind(f.url)]),
    )

    // Who wrote each note. Built from the accounts already loaded rather than a
    // second lookup, since every admin is also a user in that list. With two
    // people working the same list, "who said this" is most of the value of a
    // note: it is the difference between a record and a rumour.
    const whoById = new Map<string, string>(
      (rows ?? []).map((r: any) => [r.owner_id, r.display_name || r.email || 'Unknown']),
    )

    const notesByOwner = new Map<string, any[]>()
    for (const nt of notes ?? []) {
      const list = notesByOwner.get(nt.owner_id) ?? []
      list.push({
        body: nt.body,
        created_at: nt.created_at,
        // Null once an admin's own account is deleted, since the column is set
        // null rather than taking the note with it.
        author: nt.author_id ? (whoById.get(nt.author_id) ?? 'Removed account') : 'Unknown',
      })
      notesByOwner.set(nt.owner_id, list)
    }

    const customerToOwner = new Map<string, string>()
    const segmentOf = new Map<string, string>()
    for (const r of rows ?? []) {
      if (r.stripe_customer_id) customerToOwner.set(r.stripe_customer_id, r.owner_id)
      segmentOf.set(r.owner_id, r.segment)
    }
    const { income, byOwner } = summariseIncome(await stripeP, customerToOwner, segmentOf)

    const todayMs = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')

    const accounts = (rows ?? []).map((r: any) => {
      const activeStudents = Number(r.active_students)
      const limit = Number(r.free_student_limit)
      const stripeSide = byOwner.get(r.owner_id)
      return {
        owner_id: r.owner_id,
        email: r.email,
        name: r.display_name,
        segment: r.segment,
        is_admin: !!r.is_admin,
        // Stored as international digits by the app, which is exactly the shape
        // a wa.me link wants.
        phone: r.contact_phone,
        joined: r.joined,
        // When the app was last actually open, which is not the same thing as
        // the last time they typed their password. Both are sent: one is the
        // useful number, the other is occasionally worth knowing.
        last_seen: r.last_seen,
        last_sign_in_at: r.last_sign_in_at,
        last_entry: r.last_entry,
        live_sessions: Number(r.live_sessions),
        confirmed: r.confirmed,
        plan: r.plan,
        pro_free_until: r.pro_free_until,
        // Negative means it lapsed, which is a different situation from never
        // having been granted anything at all.
        free_days_left: r.pro_free_until
          ? Math.round((Date.parse(r.pro_free_until + 'T00:00:00Z') - todayMs) / DAY)
          : null,
        free_student_limit: limit,
        // The only question that matters for conversion: if the free access
        // stopped today, would this tutor actually have to do something? A
        // tester with two students never will. One with ten has no choice.
        over_limit_by: Math.max(0, activeStudents - limit),
        // What they pay us. Stripe's own answer when it could be reached, the
        // webhook's last word when it could not.
        billing: {
          status: stripeSide?.status ?? r.stripe_status ?? null,
          mrr_pence: stripeSide?.mrr_pence ?? null,
          cancel_at_period_end: stripeSide?.cancel_at_period_end ?? !!r.cancel_at_period_end,
          current_period_end: stripeSide?.current_period_end ?? r.current_period_end ?? null,
          since: stripeSide?.since ?? null,
          collected_pence: stripeSide?.collected_pence ?? null,
          refunded_pence: stripeSide?.refunded_pence ?? 0,
          last_paid_at: stripeSide?.last_paid_at ?? null,
        },
        active_students: activeStudents,
        total_students: Number(r.total_students),
        total_lessons: Number(r.total_lessons),
        lessons_last_30: Number(r.lessons_last_30),
        lessons_upcoming: Number(r.lessons_upcoming),
        payments_logged: Number(r.payments_logged),
        money_logged: Number(r.money_logged),
        last_payment_date: r.last_payment_date,
        taught_chargeable: Number(r.taught_chargeable),
        taught_paid: Number(r.taught_paid),
        has_name: !!r.has_name,
        has_phone: !!r.has_phone,
        calendar: r.calendar,
        // Which calendar app: 'Google' when connected through Google sign-in,
        // otherwise read off the link's address. Null when nothing connected.
        calendar_kind: r.calendar === 'google' ? 'Google'
          : r.calendar === 'link' ? (feedKindOf.get(r.owner_id) ?? 'Calendar link') : null,
        calendar_synced_at: r.calendar_synced_at,
        // Surfaced because a broken calendar is silent: the tutor sees lessons
        // stop appearing and has no reason to connect that to anything.
        calendar_error: r.calendar_error,
        parent_views_30d: Number(r.parent_views_30d),
        parent_days_30d: Number(r.parent_days_30d),
        parent_views_ever: Number(r.parent_views_ever),
        last_parent_view: r.last_parent_view,
        notes: notesByOwner.get(r.owner_id) ?? [],
      }
    })

    const leads = summariseLeads(leadRows ?? [], rows ?? [])
    return json({ ok: true, me: whoById.get(me.id) ?? me.email, me_id: me.id, accounts, income, leads })
  }

  if (action === 'grant') {
    if (!isUuid(body.owner_id)) return json({ ok: false, problem: 'bad_owner' }, 400)
    const months = Number(body.months)
    if (!Number.isInteger(months) || months < 1 || months > MAX_GRANT_MONTHS) {
      return json({ ok: false, problem: 'bad_months' }, 400)
    }

    const { data: existing } = await supabase.from('tutoring_subscriptions')
      .select('pro_free_until').eq('owner_id', body.owner_id).maybeSingle()

    // Extended from whichever is later: today, or the end of a grant that has
    // not run out yet. Counting from today would shorten an active grant every
    // time someone pressed the button meaning to add to it.
    const todayStr = new Date().toISOString().slice(0, 10)
    const base = existing?.pro_free_until && existing.pro_free_until > todayStr
      ? new Date(existing.pro_free_until + 'T00:00:00Z')
      : new Date()
    const until = addMonths(base, months)

    const { error } = await supabase.from('tutoring_subscriptions').upsert({
      owner_id: body.owner_id,
      plan: 'comp',
      pro_free_until: until,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_id' })
    if (error) return json({ ok: false, problem: 'grant_failed', detail: error.message })

    await supabase.from('tutoring_account_notes').insert({
      owner_id: body.owner_id,
      author_id: me.id,
      body: `Free access granted: ${months} month${months === 1 ? '' : 's'}, now runs to ${until}.`,
    })

    return json({ ok: true, pro_free_until: until })
  }

  if (action === 'revoke') {
    if (!isUuid(body.owner_id)) return json({ ok: false, problem: 'bad_owner' }, 400)
    const { error } = await supabase.from('tutoring_subscriptions').upsert({
      owner_id: body.owner_id,
      plan: 'free',
      pro_free_until: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'owner_id' })
    if (error) return json({ ok: false, problem: 'revoke_failed', detail: error.message })

    await supabase.from('tutoring_account_notes').insert({
      owner_id: body.owner_id,
      author_id: me.id,
      body: 'Free access ended.',
    })
    return json({ ok: true })
  }

  if (action === 'segment') {
    if (!isUuid(body.owner_id)) return json({ ok: false, problem: 'bad_owner' }, 400)
    const segment = String(body.segment ?? '')
    if (!SEGMENT_LABEL[segment]) return json({ ok: false, problem: 'bad_segment' }, 400)
    const { error } = await supabase.from('tutoring_account_segments').upsert({
      owner_id: body.owner_id,
      segment,
      set_by: me.id,
      set_at: new Date().toISOString(),
    }, { onConflict: 'owner_id' })
    if (error) return json({ ok: false, problem: 'segment_failed', detail: error.message })

    // On the record, because moving someone out of the tester numbers changes
    // what every total on the panel means.
    await supabase.from('tutoring_account_notes').insert({
      owner_id: body.owner_id,
      author_id: me.id,
      body: `Moved to ${SEGMENT_LABEL[segment]}.`,
    })
    return json({ ok: true })
  }

  if (action === 'note') {
    if (!isUuid(body.owner_id)) return json({ ok: false, problem: 'bad_owner' }, 400)
    const text = String(body.body ?? '').trim()
    if (!text) return json({ ok: false, problem: 'empty_note' }, 400)
    const { error } = await supabase.from('tutoring_account_notes').insert({
      owner_id: body.owner_id,
      author_id: me.id,
      body: text.slice(0, NOTE_MAX),
    })
    if (error) return json({ ok: false, problem: 'note_failed', detail: error.message })
    return json({ ok: true })
  }

  // A demo visitor asked not to be contacted, or the number is no longer
  // wanted: every row for that phone goes, not just the latest.
  if (action === 'forget-lead') {
    if (!isPhone(body.phone)) return json({ ok: false, problem: 'bad_phone' }, 400)
    const { error } = await supabase.from('tutoring_demo_leads').delete().eq('phone', body.phone)
    if (error) return json({ ok: false, problem: 'forget_failed', detail: error.message })
    return json({ ok: true })
  }

  return json({ ok: false, problem: 'unknown_action' }, 400)
})
