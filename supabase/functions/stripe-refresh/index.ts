// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const LIVE = ['active', 'trialing', 'past_due']
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function env(name: string) { return (Deno.env.get(name) ?? '').trim() }

let _stripe: Stripe | null = null
function stripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(env('STRIPE_SECRET_KEY'), { httpClient: Stripe.createFetchHttpClient() })
  return _stripe
}

function periodEndOf(sub: any): string | null {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null
  return ts ? new Date(ts * 1000).toISOString() : null
}

function addonPriceMap(): Record<string, string> {
  let raw: Record<string, string> = {}
  try { raw = JSON.parse(Deno.env.get('STRIPE_ADDON_PRICES') ?? '{}') } catch { raw = {} }
  const byPrice: Record<string, string> = {}
  for (const [key, price] of Object.entries(raw)) byPrice[String(price).trim()] = key
  return byPrice
}

function addonsOf(sub: any): string[] {
  const byPrice = addonPriceMap()
  const items = sub?.items?.data ?? []
  const keys = items.map((i: any) => byPrice[i?.price?.id]).filter(Boolean)
  return [...new Set(keys)] as string[]
}

function hasPro(sub: any): boolean {
  const priceId = env('STRIPE_PRICE_ID')
  if (!priceId) return true
  return (sub?.items?.data ?? []).some((i: any) => i?.price?.id === priceId)
}

function pickSubscription(subs: any[]): any | null {
  const proSubs = subs.filter(hasPro)
  return proSubs.find(s => LIVE.includes(s.status)) ?? proSubs[0] ?? null
}

Deno.serve(async (req) => {
  const json = (body: any, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, problem: 'method_not_allowed' }, 405)

  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID'].filter(n => !env(n))
  if (missing.length) return json({ ok: false, problem: 'config_missing', missing }, 503)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: auth, error: authErr } = await supabase.auth.getUser(jwt)
  if (authErr || !auth.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  const { data: row, error: rowErr } = await supabase.from('tutoring_subscriptions')
    .select('*')
    .eq('owner_id', auth.user.id)
    .maybeSingle()

  if (rowErr) return json({ ok: false, problem: 'subscription_read_failed', message: rowErr.message }, 500)
  if (!row?.stripe_customer_id) return json({ ok: true, changed: false, entitlement: row ?? null, problem: 'no_customer' })

  const subs = await stripe().subscriptions.list({
    customer: row.stripe_customer_id,
    status: 'all',
    limit: 10,
    expand: ['data.items.data.price'],
  })
  const sub = pickSubscription(subs.data)
  if (!sub) return json({ ok: true, changed: false, entitlement: row, problem: 'no_subscription' })

  const live = LIVE.includes(sub.status)
  const patch: Record<string, any> = {
    stripe_subscription_id: sub.id,
    stripe_status: sub.status,
    current_period_end: periodEndOf(sub),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    addons: live ? addonsOf(sub) : [],
  }
  if (row.plan !== 'comp') patch.plan = live && hasPro(sub) ? 'pro' : 'free'

  const { data: updated, error: updateErr } = await supabase.from('tutoring_subscriptions')
    .update(patch)
    .eq('owner_id', auth.user.id)
    .select('*')
    .single()

  if (updateErr) return json({ ok: false, problem: 'subscription_write_failed', message: updateErr.message }, 500)
  return json({ ok: true, changed: true, entitlement: updated })
})
