// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const DANIEL_EMAILS = new Set([
  'daniel@bowermagic.co.uk',
  'danielbowermagic@gmail.com',
])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
    if (req.method !== 'GET') return json({ ok: false, problem: 'method_not_allowed' }, 405)

    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '')
    const { data: auth, error: authErr } = await supabase.auth.getUser(jwt)
    const email = (auth.user?.email ?? '').toLowerCase()
    if (authErr || !auth.user) return json({ ok: false, problem: 'not_signed_in' }, 401)
    if (!DANIEL_EMAILS.has(email)) return json({ ok: false, problem: 'not_allowed' }, 403)

    const users: any[] = []
    for (let page = 1; page < 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw error
      users.push(...(data.users ?? []))
      if (!data.users || data.users.length < 1000) break
    }

    const tutorUsers = users.filter(u => {
      const e = String(u.email ?? '').toLowerCase()
      return e && !DANIEL_EMAILS.has(e)
    })
    const tutorIds = new Set(tutorUsers.map(u => u.id))

    const { data: students, error: studentsErr } = await supabase
      .from('tutoring_students')
      .select('id, owner_id, active')
    if (studentsErr) throw studentsErr

    const externalStudents = (students ?? []).filter((s: any) => tutorIds.has(s.owner_id))
    const activeExternalStudents = externalStudents.filter((s: any) => s.active === true)
    const studentIds = activeExternalStudents.map((s: any) => s.id)
    const activeTutorIds = new Set(activeExternalStudents.map((s: any) => s.owner_id))

    let weeklyGross = 0
    if (studentIds.length > 0) {
      const today = new Date().toISOString().slice(0, 10)
      const { data: rates, error: ratesErr } = await supabase
        .from('tutoring_rate_history')
        .select('student_id, rate, effective_from_date')
        .in('student_id', studentIds)
        .lte('effective_from_date', today)
        .order('student_id', { ascending: true })
        .order('effective_from_date', { ascending: false })
      if (ratesErr) throw ratesErr

      const currentRates = new Map<string, number>()
      for (const row of rates ?? []) {
        if (!currentRates.has(row.student_id)) currentRates.set(row.student_id, Number(row.rate) || 0)
      }
      weeklyGross = studentIds.reduce((sum: number, id: string) => sum + (currentRates.get(id) ?? 0), 0)
    }

    return json({
      ok: true,
      tutors_using_it: activeTutorIds.size,
      students_total: externalStudents.length,
      active_students: activeExternalStudents.length,
      annualised_gross: Math.round(weeklyGross * 40),
      calculated_at: new Date().toISOString(),
    })
  } catch (e) {
    console.error('platform-stats failed', e)
    return json({ ok: false, problem: 'server_error', message: String((e as any)?.message ?? e) }, 500)
  }
})
