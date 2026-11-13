// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

async function getAccessToken_(ownerId: string): Promise<string> {
  const { data: row, error } = await supabase
    .from('tutoring_google_calendar_auth').select('*').eq('owner_id', ownerId).maybeSingle()
  if (error) throw new Error('db_error: ' + error.message)
  if (!row) throw new Error('not_connected')

  const expiresAt = row.access_token_expires_at ? new Date(row.access_token_expires_at).getTime() : 0
  if (row.access_token && expiresAt > Date.now() + 5 * 60 * 1000) return row.access_token

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: row.refresh_token,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error('refresh_failed: ' + (await res.text()))
  const t = await res.json()
  // Google does not rotate the refresh_token on a refresh call — only
  // access_token and its expiry change.
  await supabase.from('tutoring_google_calendar_auth').update({
    access_token: t.access_token,
    access_token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('owner_id', ownerId)
  return t.access_token
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
  if (userErr || !userData.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  let token: string
  try { token = await getAccessToken_(userData.user.id) }
  catch (e) { return json({ ok: false, problem: String(e) }) }

  const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) return json({ ok: false, problem: 'calendar_list_failed', detail: await res.text() })

  const body = await res.json()
  const calendars = (body.items ?? []).map((c: any) => ({
    id: c.id,
    summary: c.summary,
    primary: !!c.primary,
  }))

  return json({ ok: true, calendars })
})
