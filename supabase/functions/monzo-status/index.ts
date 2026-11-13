// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MONZO_CLIENT_ID = Deno.env.get('MONZO_CLIENT_ID')!
const MONZO_CLIENT_SECRET = Deno.env.get('MONZO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// The Monzo connection is Daniel's own bank account. Only his signed-in
// session may ask about it; see monzo-sync for why this was added.
const MONZO_USERS = new Set(['danielbowermagic@gmail.com', 'daniel@bowermagic.co.uk'])

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// Without these the browser refuses to let the app read the response, and the
// panel misreports a perfectly healthy connection as "Not connected".
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

async function callerAllowed(req: Request): Promise<boolean> {
  const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  if (!bearer) return false
  const { data, error } = await supabase.auth.getUser(bearer)
  return !error && MONZO_USERS.has((data?.user?.email ?? '').toLowerCase())
}

async function getAccessToken(): Promise<string> {
  const { data: row, error } = await supabase
    .from('tutoring_monzo_auth').select('*').limit(1).maybeSingle()
  if (error) throw new Error('db_error: ' + error.message)
  if (!row) throw new Error('not_connected')

  const expiresAt = row.access_token_expires_at
    ? new Date(row.access_token_expires_at).getTime() : 0
  if (row.access_token && expiresAt > Date.now() + 5 * 60 * 1000) return row.access_token

  const res = await fetch('https://api.monzo.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: MONZO_CLIENT_ID,
      client_secret: MONZO_CLIENT_SECRET,
      refresh_token: row.refresh_token,
    }),
  })
  if (!res.ok) throw new Error('refresh_failed: ' + (await res.text()))
  const t = await res.json()
  await supabase.from('tutoring_monzo_auth').update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    access_token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('id', row.id)
  return t.access_token
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b, null, 2), {
      status: s,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (!(await callerAllowed(req))) return json({ connected: false, problem: 'unauthorized' }, 401)

  let token: string
  try { token = await getAccessToken() } catch (e) { return json({ connected: false, problem: String(e) }) }

  const accRes = await fetch('https://api.monzo.com/accounts', {
    headers: { Authorization: `Bearer ${token}` },
  })
  const accBody = await accRes.text()

  if (accRes.status === 403) {
    return json({
      connected: true,
      data_access_approved: false,
      next_step: 'Open the Monzo app and approve data access for this app, then reload.',
    })
  }
  if (!accRes.ok) return json({ connected: true, data_access_approved: false, monzo_error: accBody })

  const accounts = JSON.parse(accBody).accounts ?? []
  const retail = accounts.find((a: any) => a.type === 'uk_retail' && !a.closed)

  const { data: authRow } = await supabase
    .from('tutoring_monzo_auth').select('last_synced').limit(1).maybeSingle()

  return json({
    connected: true,
    data_access_approved: true,
    account_found: !!retail,
    last_synced: authRow?.last_synced ?? null,
  })
})
