// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
  const { data, error } = await supabase.auth.getUser(jwt)
  if (error || !data.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  const { data: row } = await supabase
    .from('tutoring_google_calendar_auth')
    .select('refresh_token')
    .eq('owner_id', data.user.id)
    .maybeSingle()

  if (row?.refresh_token) {
    // Best-effort revoke with Google — proceed regardless of the result so a
    // Google-side hiccup never blocks disconnecting locally.
    try {
      await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(row.refresh_token), {
        method: 'POST',
      })
    } catch (e) {
      console.error('Google revoke failed (continuing):', e)
    }
  }

  await supabase.from('tutoring_google_calendar_auth').delete().eq('owner_id', data.user.id)

  return json({ ok: true })
})
