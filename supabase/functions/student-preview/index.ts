// Returns one thing: the first name behind a parent or pupil link, so a shared
// link can be previewed as "Nilou's Lessons". Deliberately separate from
// student-portal, which also logs a view each time it is opened, and link-preview
// crawlers must not count as a parent looking at the page.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
}
const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...headers, ...extra } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'GET') return json({ ok: false }, 405)
  const token = new URL(req.url).searchParams.get('t') ?? ''
  // Checked as a UUID first because it is interpolated into the or() filter below.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return json({ ok: false }, 404)
  const { data, error } = await supabase.from('tutoring_students').select('name')
    .or(`public_token.eq.${token},student_token.eq.${token}`).maybeSingle()
  if (error || !data) return json({ ok: false }, 404)
  const first = String(data.name ?? '').trim().split(/\s+/)[0].slice(0, 40)
  if (!first) return json({ ok: false }, 404)
  return json({ ok: true, first }, 200, { 'Cache-Control': 'public, max-age=300' })
})
