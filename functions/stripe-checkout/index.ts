// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

let _stripe: Stripe | null = null
function stripe(): Stripe {
  if (!_stripe) _stripe = new Stripe((Deno.env.get('STRIPE_SECRET_KEY') ?? '').trim(), { httpClient: Stripe.createFetchHttpClient() })
  return _stripe
}
function env(name: string) { return (Deno.env.get(name) ?? '').trim() }
function addonPrices(): Record<string, string> {
  try {
    const raw = JSON.parse(Deno.env.get('STRIPE_ADDON_PRICES') ?? '{}')
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v).trim()]))
  } catch { return {} }
}

const ALLOWED_ORIGINS = ['https://tutoring.bowermaths.co.uk', 'https://tutortally.pages.dev', 'http://localhost:8000']
const DEFAULT_ORIGIN = ALLOWED_ORIGINS[0]
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, problem: 'method_not_allowed' }, 405)

  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID'].filter(n => !env(n))
  if (missing.length) return json({ ok: false, problem: 'config_missing', message: `Billing is not set up yet. Missing Supabase secret${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.` }, 503)
  const STRIPE_PRICE_ID = env('STRIPE_PRICE_ID')

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: auth, error: authErr } = await supabase.auth.getUser(jwt)
  if (authErr || !auth.user) return json({ ok: false, problem: 'not_signed_in' }, 401)
  const user = auth.user

  let body: any = {}
  try { body = await req.json() } catch { body = {} }
  const wantedAddons: string[] = Array.isArray(body.addons) ? body.addons : []
  const origin = req.headers.get('Origin') ?? ''
  const base = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN

  try {
    const { data: sub } = await supabase.from('tutoring_subscriptions')
      .select('stripe_customer_id, stripe_status, pro_free_until, plan')
      .eq('owner_id', user.id).maybeSingle()

    if (sub?.plan === 'comp') return json({ ok: false, problem: 'comped', message: 'This account has Pro permanently. There is nothing to pay.' }, 400)
    if (sub?.stripe_status === 'active' || sub?.stripe_status === 'trialing') {
      return json({ ok: false, problem: 'already_subscribed', message: 'You already have Pro. Use Manage billing to change it.' }, 400)
    }

    const PRICES = addonPrices()
    const line_items: any[] = [{ price: STRIPE_PRICE_ID, quantity: 1 }]
    const unknown: string[] = []
    for (const key of wantedAddons) {
      const price = PRICES[key]
      if (price) line_items.push({ price, quantity: 1 })
      else unknown.push(key)
    }
    if (unknown.length) return json({ ok: false, problem: 'unknown_addon', message: `Not on sale yet: ${unknown.join(', ')}` }, 400)

    let customerId = sub?.stripe_customer_id ?? null
    if (!customerId) {
      const customer = await stripe().customers.create({ email: user.email ?? undefined, name: (user.user_metadata as any)?.display_name ?? undefined, metadata: { owner_id: user.id } })
      customerId = customer.id
      await supabase.from('tutoring_subscriptions').update({ stripe_customer_id: customerId }).eq('owner_id', user.id)
    }

    const subscription_data: Record<string, any> = { metadata: { owner_id: user.id } }
    if (sub?.pro_free_until) {
      const endsAt = Math.floor(new Date(sub.pro_free_until + 'T00:00:00Z').getTime() / 1000)
      if (endsAt > Math.floor(Date.now() / 1000) + 60 * 60 * 48) subscription_data.trial_end = endsAt
    }

    const session = await stripe().checkout.sessions.create({
      mode: 'subscription', customer: customerId, client_reference_id: user.id,
      line_items, subscription_data, allow_promotion_codes: true,
      billing_address_collection: 'auto', success_url: `${base}/?billing=done`, cancel_url: `${base}/?billing=cancelled`,
    })
    return json({ ok: true, url: session.url })
  } catch (e) {
    console.error('stripe-checkout failed', e)
    return json({ ok: false, problem: 'stripe_error', message: String((e as any)?.message ?? e) }, 500)
  }
})
