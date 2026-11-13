import { createClient } from 'jsr:@supabase/supabase-js@2'

const MONZO_CLIENT_ID = Deno.env.get('MONZO_CLIENT_ID')!
const MONZO_CLIENT_SECRET = Deno.env.get('MONZO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Where Monzo sends the browser back to after the user approves access.
const REDIRECT_URI = `${SUPABASE_URL}/functions/v1/monzo-auth`
// Where WE send the browser once we're done, back to the live app. Unlike the
// Google flow there is no state row to carry a return address on, because
// Monzo is Daniel's own bank connection rather than something every tutor
// does — so it reads an APP_URL secret if one is set, and otherwise uses the
// current home of the app. Set APP_URL in Edge Function secrets to move it
// without a redeploy.
const APP_URL = Deno.env.get('APP_URL') ?? 'https://tutoring.bowermaths.co.uk/'

Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const errorParam = url.searchParams.get('error')

  if (errorParam) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${APP_URL}?monzo=denied` },
    })
  }

  if (!code) {
    return new Response('Missing code parameter. This endpoint should only be hit as a redirect from Monzo.', { status: 400 })
  }

  // Exchange the one-time code for an access token + refresh token.
  const tokenRes = await fetch('https://api.monzo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: MONZO_CLIENT_ID,
      client_secret: MONZO_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  })

  if (!tokenRes.ok) {
    const errText = await tokenRes.text()
    console.error('Monzo token exchange failed:', errText)
    return new Response('Token exchange failed: ' + errText, { status: 502 })
  }

  const tokenData = await tokenRes.json()
  // tokenData: { access_token, client_id, expires_in, refresh_token, token_type, user_id }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()

  // Single-user app: wipe any previous connection before storing the new one.
  await supabase.from('tutoring_monzo_auth').delete().not('id', 'is', null)

  const { error: insertError } = await supabase.from('tutoring_monzo_auth').insert({
    refresh_token: tokenData.refresh_token,
    access_token: tokenData.access_token,
    access_token_expires_at: expiresAt,
  })

  if (insertError) {
    console.error('Failed to store Monzo tokens:', insertError)
    return new Response('Failed to store tokens: ' + insertError.message, { status: 500 })
  }

  return new Response(null, {
    status: 302,
    headers: { Location: `${APP_URL}?monzo=connected` },
  })
})
