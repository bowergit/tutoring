// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Google only sends people back to a domain the app owner has verified, and
// nobody can verify supabase.co, so the callback lives on our own domain:
// tutortally.co.uk/auth/google, which worker.js forwards to
// google-calendar-auth. It must be listed under the OAuth client's redirect
// URIs in the Google console. GOOGLE_REDIRECT_URI can override it.
// google-calendar-auth uses the same value, and the two MUST agree:
// Google checks it again during the token exchange.
const REDIRECT_URI = Deno.env.get('GOOGLE_REDIRECT_URI') ??
  'https://tutortally.co.uk/auth/google'
// The narrowest scopes that cover what TutorTally does, and nothing else
// (Google's verification insists on least privilege): list the tutor's
// calendars so they can pick one, and read events. calendar.readonly also
// grants settings, sharing and free/busy, none of which is used. Connections
// made before the switch hold calendar.readonly, which covers both calls, so
// they keep working. google-calendar-auth refuses a grant missing either one.
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ')

// Every origin the app is allowed to be served from and returned to. An
// unchecked return_to would turn the OAuth callback into an open redirect -
// anyone could send a victim through a real Google consent screen and land
// them on a site of their choosing - so the browser's value is only ever
// honoured if its origin appears here.
const ALLOWED_ORIGINS = [
  'https://tutortally.co.uk',
  'https://tutoring.bowermaths.co.uk',
  'https://bowermaths.co.uk',
  'https://bowergit.github.io',
]
const DEFAULT_RETURN = 'https://tutortally.co.uk/'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function safeReturnTo_(raw: string | null): string {
  if (!raw) return DEFAULT_RETURN
  try {
    const u = new URL(raw)
    if (!ALLOWED_ORIGINS.includes(u.origin)) return DEFAULT_RETURN
    // Origin + path only. Whatever query string the app happened to have when
    // the tutor hit Connect is stale by the time they come back, and the
    // callback appends its own ?google=... anyway.
    return u.origin + u.pathname
  } catch {
    return DEFAULT_RETURN
  }
}

// Deliberately verify_jwt:false with manual verification inside, not the
// platform flag: a CORS preflight (OPTIONS) never carries an Authorization
// header, and verify_jwt:true would 401 the preflight itself before this
// code ever runs, breaking the browser call entirely. Handling it here means
// OPTIONS always succeeds and only the real GET is checked.
Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization') ?? ''
  const jwt = authHeader.replace(/^Bearer /i, '')
  const { data, error } = await supabase.auth.getUser(jwt)
  if (error || !data.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  const returnTo = safeReturnTo_(new URL(req.url).searchParams.get('return_to'))

  // Opaque and single-use, mapped server-side to this user's id. The state
  // itself is never trusted as an owner_id directly: anyone could otherwise
  // start Google's consent screen by hand with state=<victim-id> and use
  // their OWN Google account to complete it, tricking the callback into
  // filing an attacker's calendar tokens under a victim's account.
  const state = crypto.randomUUID()
  const { error: stateErr } = await supabase.from('tutoring_oauth_state').insert({
    state, owner_id: data.user.id, provider: 'google', return_to: returnTo,
  })
  if (stateErr) return json({ ok: false, problem: 'state_insert_failed', detail: stateErr.message }, 500)

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent') // force a refresh_token every time, not just the first
  url.searchParams.set('state', state)

  // JSON, not a 302: the browser reaches this via an authenticated fetch()
  // (a plain <a href> click can't carry a bearer token), and a cross-origin
  // redirect response is 'opaque' to JS - the Location header would be
  // unreadable. The frontend does window.location.href = authorize_url itself.
  return json({ ok: true, authorize_url: url.toString() })
})
