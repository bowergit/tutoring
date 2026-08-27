// deno-lint-ignore-file no-explicit-any
// Hands the tutor to Stripe's own billing portal to change a card, see
// invoices or cancel. Building any of that in-app would be a week of work to
// reproduce something Stripe already hosts.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Lazy, so a missing key is a readable error rather than a boot crash.
let _stripe: Stripe | null = null
function stripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
      httpClient: Stripe.createFetchHttpClient(),
    })
  }
  return _stripe
}

const ALLOWED_ORIGINS = [
  'https://tutoring.bowermaths.co.uk',
  'https://tutortally.pages.dev',
  'http://localhost:8000',
]
const DEFAULT_ORIGIN = ALLOWED_ORIGINS[0]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, problem: 'method_not_allowed' }, 405)

  if (!Deno.env.get('STRIPE_SECRET_KEY')) {
    return json({
      ok: false, problem: 'config_missing',
      message: 'Billing is not set up yet. Missing Supabase secret: STRIPE_SECRET_KEY.',
    }, 503)
  }

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: auth, error: authErr } = await supabase.auth.getUser(jwt)
  if (authErr || !auth.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  const origin = req.headers.get('Origin') ?? ''
  const base = ALLOWED_ORIGINS.includes(origin) ? origin : DEFAULT_ORIGIN

  try {
    const { data: sub } = await supabase
      .from('tutoring_subscriptions')
      .select('stripe_customer_id')
      .eq('owner_id', auth.user.id)
      .maybeSingle()

    if (!sub?.stripe_customer_id) {
      return json({ ok: false, problem: 'no_customer', message: 'There is no billing account to manage yet.' }, 400)
    }

    const session = await stripe().billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${base}/`,
    })

    return json({ ok: true, url: session.url })
  } catch (e) {
    console.error('stripe-portal failed', e)
    const msg = String((e as any)?.message ?? e)
    // The single most common setup mistake, worth naming outright.
    const hint = /configuration/i.test(msg)
      ? ' Activate the customer portal in Stripe: Settings, Billing, Customer portal.'
      : ''
    return json({ ok: false, problem: 'stripe_error', message: msg + hint }, 500)
  }
})
