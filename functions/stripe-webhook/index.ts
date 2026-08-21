// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function env(name: string) { return (Deno.env.get(name) ?? '').trim() }
let _stripe: Stripe | null = null
function stripe(): Stripe {
  if (!_stripe) _stripe = new Stripe(env('STRIPE_SECRET_KEY'), { httpClient: Stripe.createFetchHttpClient() })
  return _stripe
}
let _crypto: any = null
function cryptoProvider() { if (!_crypto) _crypto = Stripe.createSubtleCryptoProvider(); return _crypto }

function addonPriceMap(): Record<string, string> {
  let raw: Record<string, string> = {}
  try { raw = JSON.parse(Deno.env.get('STRIPE_ADDON_PRICES') ?? '{}') } catch { raw = {} }
  const byPrice: Record<string, string> = {}
  for (const [key, price] of Object.entries(raw)) byPrice[String(price).trim()] = key
  return byPrice
}
const LIVE = ['active', 'trialing', 'past_due']
function periodEndOf(sub: any): string | null {
  const ts = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null
  return ts ? new Date(ts * 1000).toISOString() : null
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
async function ownerIdFor(sub: any): Promise<string | null> {
  const fromMeta = sub?.metadata?.owner_id
  if (fromMeta) return fromMeta
  const customerId = typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id
  if (!customerId) return null
  const { data } = await supabase.from('tutoring_subscriptions').select('owner_id').eq('stripe_customer_id', customerId).maybeSingle()
  return data?.owner_id ?? null
}
async function writeSubscription(sub: any) {
  const ownerId = await ownerIdFor(sub)
  if (!ownerId) { console.error('no owner_id for stripe subscription', sub?.id); return }
  const { data: current } = await supabase.from('tutoring_subscriptions').select('plan').eq('owner_id', ownerId).maybeSingle()
  const live = LIVE.includes(sub.status)
  const customerId = typeof sub?.customer === 'string' ? sub.customer : sub?.customer?.id
  const patch: Record<string, any> = {
    stripe_customer_id: customerId ?? undefined,
    stripe_subscription_id: sub.id,
    stripe_status: sub.status,
    current_period_end: periodEndOf(sub),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    addons: live ? addonsOf(sub) : [],
  }
  if (current?.plan !== 'comp') patch.plan = live && hasPro(sub) ? 'pro' : 'free'
  const { error } = await supabase.from('tutoring_subscriptions').update(patch).eq('owner_id', ownerId)
  if (error) console.error('failed writing subscription for', ownerId, error.message)
  else console.log('subscription updated', ownerId, sub.status, patch.plan ?? '(comp kept)')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  const missing = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'].filter(n => !env(n))
  if (missing.length) return new Response(JSON.stringify({ ok: false, problem: 'config_missing', missing }), { status: 503, headers: { 'Content-Type': 'application/json' } })
  const signature = req.headers.get('stripe-signature')
  if (!signature) return new Response('missing signature', { status: 400 })
  const body = await req.text()
  let event: Stripe.Event
  try {
    event = await stripe().webhooks.constructEventAsync(body, signature, env('STRIPE_WEBHOOK_SECRET'), undefined, cryptoProvider())
  } catch (e) {
    console.error('bad stripe signature', (e as any)?.message)
    return new Response('bad signature', { status: 400 })
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any
        if (session.mode !== 'subscription' || !session.subscription) break
        const sub = await stripe().subscriptions.retrieve(typeof session.subscription === 'string' ? session.subscription : session.subscription.id)
        if (session.client_reference_id && !(sub as any).metadata?.owner_id) (sub as any).metadata = { ...(sub as any).metadata, owner_id: session.client_reference_id }
        await writeSubscription(sub)
        break
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed':
        await writeSubscription(event.data.object)
        break
      case 'invoice.payment_failed':
      case 'invoice.paid': {
        const invoice = event.data.object as any
        const subId = invoice.subscription ?? invoice.parent?.subscription_details?.subscription ?? null
        if (!subId) break
        const sub = await stripe().subscriptions.retrieve(typeof subId === 'string' ? subId : subId.id)
        await writeSubscription(sub)
        break
      }
    }
  } catch (e) {
    console.error('stripe-webhook failed on', event.type, e)
    return new Response('handler failed', { status: 500 })
  }
  return new Response(JSON.stringify({ received: true }), { headers: { 'Content-Type': 'application/json' } })
})
