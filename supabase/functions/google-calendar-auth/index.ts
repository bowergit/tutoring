// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// MUST match the value google-calendar-connect sent to Google, because Google
// checks it a second time during the token exchange. Both read the same
// variable so they cannot drift apart. See that function for why the callback
// moves onto our own domain.
const REDIRECT_URI = Deno.env.get('GOOGLE_REDIRECT_URI') ??
  `${SUPABASE_URL}/functions/v1/google-calendar-auth`
// Only used when a connection predates return_to being recorded, or if the
// row somehow lacks one. The live value comes from the state row, so the app
// can move domain without this function being redeployed.
const FALLBACK_APP_URL = 'https://tutoring.bowermaths.co.uk/'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function back(appUrl: string, status: string) {
  const sep = appUrl.includes('?') ? '&' : '?'
  return new Response(null, { status: 302, headers: { Location: `${appUrl}${sep}google=${status}` } })
}

// Public entry point: Google's own redirect lands here and carries no
// Supabase auth of any kind. Identity comes entirely from the state param,
// which was minted server-side in google-calendar-connect and is looked up
// here, not trusted as-is.
Deno.serve(async (req) => {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const errorParam = url.searchParams.get('error')

  if (errorParam) {
    // No state to look up a return address from, so this one has to fall back.
    return back(FALLBACK_APP_URL, 'denied')
  }
  if (!code || !state) {
    return new Response('Missing code or state.', { status: 400 })
  }

  const { data: stateRow, error: stateErr } = await supabase
    .from('tutoring_oauth_state')
    .select('*')
    .eq('state', state)
    .is('used_at', null)
    .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .maybeSingle()

  if (stateErr || !stateRow) {
    return new Response('This connection link has expired or was already used. Go back to the app and try again.', { status: 400 })
  }

  // Whichever domain the tutor actually started from, already checked against
  // an allowlist when the state row was created.
  const APP_URL = stateRow.return_to || FALLBACK_APP_URL

  // Burn it immediately so it can't be replayed even if something below fails.
  await supabase.from('tutoring_oauth_state').update({ used_at: new Date().toISOString() }).eq('id', stateRow.id)

  const ownerId = stateRow.owner_id

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    }),
  })

  if (!tokenRes.ok) {
    console.error('Google token exchange failed:', await tokenRes.text())
    return back(APP_URL, 'error')
  }

  const tokenData = await tokenRes.json()
  // { access_token, refresh_token?, expires_in, scope, token_type }
  // refresh_token is only issued when prompt=consent forced a fresh grant
  // (which google-calendar-connect always sets) - absent on some retries if
  // Google decides consent was already fresh enough; if that happens there's
  // no way to refresh later and the user will need to reconnect when the
  // short-lived access token expires.
  if (!tokenData.refresh_token) {
    console.error('No refresh_token returned for owner', ownerId, '- Google did not force fresh consent.')
  }

  const expiresAt = new Date(Date.now() + tokenData.expires_in * 1000).toISOString()

  const { data: existing } = await supabase
    .from('tutoring_google_calendar_auth')
    .select('refresh_token')
    .eq('owner_id', ownerId)
    .maybeSingle()

  const { error: upsertErr } = await supabase.from('tutoring_google_calendar_auth').upsert({
    owner_id: ownerId,
    // Keep the previous refresh_token if Google didn't issue a new one this
    // time, rather than overwriting a working credential with null.
    refresh_token: tokenData.refresh_token ?? existing?.refresh_token,
    access_token: tokenData.access_token,
    access_token_expires_at: expiresAt,
    connected_at: new Date().toISOString(),
  }, { onConflict: 'owner_id' })

  if (upsertErr) {
    console.error('Failed to store Google tokens:', upsertErr)
    return back(APP_URL, 'error')
  }

  return back(APP_URL, 'connected')
})
