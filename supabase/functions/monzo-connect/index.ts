const MONZO_CLIENT_ID = Deno.env.get('MONZO_CLIENT_ID')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/monzo-auth`

// Visiting this URL sends the browser straight to Monzo's own login/approve
// screen. Monzo then redirects to monzo-auth with a one-time code.
Deno.serve(async (req) => {
  const state = crypto.randomUUID()
  const authorizeUrl = new URL('https://auth.monzo.com/')
  authorizeUrl.searchParams.set('client_id', MONZO_CLIENT_ID)
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('state', state)

  return new Response(null, {
    status: 302,
    headers: { Location: authorizeUrl.toString() },
  })
})
