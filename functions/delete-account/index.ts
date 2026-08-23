// Deletes only the account identified by the caller's authenticated JWT.
// Billing is cancelled first, so a deleted account cannot leave a live charge.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@17.7.0?target=deno'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': 'https://tutoring.bowermaths.co.uk',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function env(name: string) { return (Deno.env.get(name) ?? '').trim() }

let stripeClient: Stripe | null = null
function stripe() {
  if (!stripeClient) {
    stripeClient = new Stripe(env('STRIPE_SECRET_KEY'), {
      httpClient: Stripe.createFetchHttpClient(),
    })
  }
  return stripeClient
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

async function deleteRows(table: string, ownerId: string) {
  const { error } = await supabase.from(table).delete().eq('owner_id', ownerId)
  if (error) throw new Error(`Could not remove account data from ${table}.`)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ ok: false, message: 'Method not allowed.' }, 405)

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: auth, error: authError } = await supabase.auth.getUser(jwt)
  if (authError || !auth.user) return json({ ok: false, message: 'Please sign in again before deleting your account.' }, 401)

  const body = await req.json().catch(() => ({}))
  if (body?.confirm !== 'DELETE') return json({ ok: false, message: 'Confirmation was not accepted.' }, 400)

  const ownerId = auth.user.id
  const { data: subscription, error: subscriptionError } = await supabase
    .from('tutoring_subscriptions')
    .select('stripe_customer_id')
    .eq('owner_id', ownerId)
    .maybeSingle()

  if (subscriptionError) return json({ ok: false, message: 'Could not check your subscription.' }, 500)

  try {
    if (subscription?.stripe_customer_id) {
      if (!env('STRIPE_SECRET_KEY')) {
        return json({ ok: false, message: 'Please contact TutorTally support to cancel billing before deleting this account.' }, 503)
      }
      const subscriptions = await stripe().subscriptions.list({
        customer: subscription.stripe_customer_id,
        status: 'all',
        limit: 20,
      })
      for (const subscription of subscriptions.data) {
        if (!['canceled', 'incomplete_expired'].includes(subscription.status)) {
          await stripe().subscriptions.cancel(subscription.id)
        }
      }
    }

    // Child records are removed first so this also works if a historical
    // database constraint does not cascade from tutoring_students.
    for (const table of [
      'tutoring_payment_allocations',
      'tutoring_bundles',
      'tutoring_payments',
      'tutoring_lessons',
      'tutoring_rate_history',
      'tutoring_past_papers',
      'tutoring_students',
      'tutoring_google_calendar_auth',
      'tutoring_oauth_state',
      'tutoring_subscriptions',
    ]) {
      await deleteRows(table, ownerId)
    }

    const { error: deleteUserError } = await supabase.auth.admin.deleteUser(ownerId)
    if (deleteUserError) throw new Error('Could not remove your sign-in account.')
    return json({ ok: true })
  } catch (error) {
    console.error('delete-account failed', error)
    return json({ ok: false, message: 'Could not delete your account. Please contact TutorTally support.' }, 500)
  }
})
