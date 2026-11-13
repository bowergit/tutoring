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
  const { data: userData, error: userErr } = await supabase.auth.getUser(jwt)
  if (userErr || !userData.user) return json({ ok: false, problem: 'not_signed_in' }, 401)

  const body = await req.json().catch(() => ({}))
  if (!body.calendar_id) return json({ ok: false, problem: 'missing calendar_id' }, 400)

  const { error } = await supabase.from('tutoring_google_calendar_auth')
    .update({ calendar_id: body.calendar_id, calendar_summary: body.calendar_summary ?? null })
    .eq('owner_id', userData.user.id)

  if (error) return json({ ok: false, problem: 'update_failed', detail: error.message })
  return json({ ok: true })
})
