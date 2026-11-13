// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MONZO_CLIENT_ID = Deno.env.get('MONZO_CLIENT_ID')!
const MONZO_CLIENT_SECRET = Deno.env.get('MONZO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Clean-slate date: nothing before this is ever pulled in. Once it drifts
// past Monzo's 90-day limit the limit takes over naturally.
const RESET_DATE = new Date('2026-07-27T00:00:00Z')

// The Monzo connection is Daniel's own bank account and nobody else's. Every
// payment it finds belongs to his tutoring, so matching runs against his
// students only, and only his signed-in session may ask. This function used to
// answer anyone who had the URL, which sits in the app's public source, and
// matched payer names against every tutor's students on the platform.
const MONZO_OWNER_ID = 'babb06b5-b5e0-4436-8b72-bc5556814956'
const MONZO_USERS = new Set(['danielbowermagic@gmail.com', 'daniel@bowermagic.co.uk'])

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

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

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF'])
function tokenise(s?: string | null): string[] {
  if (!s) return []
  return s.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(/\s+/)
    .filter((t) => t.length > 0 && !TITLES.has(t))
}

function nameMatches(expected: string, cpName?: string | null, description?: string | null): boolean {
  const exp = tokenise(expected)
  if (exp.length === 0) return false
  const surname = exp[exp.length - 1]
  const first = exp[0]

  const cp = tokenise(cpName)
  if (cp.includes(surname)) {
    if (exp.length === 1) return true
    if (cp.some((t) => t === first || t[0] === first[0])) return true
  }
  if (surname.length >= 4 && tokenise(description).includes(surname)) return true
  return false
}

function counterpartyKey(cp: any): string {
  return cp.account_number ? `${cp.sort_code ?? ''}:${cp.account_number}` : `monzo:${cp.user_id}`
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b, null, 2), {
      status: s,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (!(await callerAllowed(req))) return json({ ok: false, problem: 'unauthorized' }, 401)

  let token: string
  try { token = await getAccessToken() } catch (e) { return json({ ok: false, problem: String(e) }) }

  const accRes = await fetch('https://api.monzo.com/accounts', { headers: { Authorization: `Bearer ${token}` } })
  if (!accRes.ok) return json({ ok: false, problem: 'accounts_failed', detail: await accRes.text() })
  const accounts = (await accRes.json()).accounts ?? []
  const retail = accounts.find((a: any) => a.type === 'uk_retail' && !a.closed)
  if (!retail) return json({ ok: false, problem: 'no_retail_account' })

  const { data: authRow } = await supabase
    .from('tutoring_monzo_auth').select('id').limit(1).maybeSingle()

  const monzoFloor = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000)
  const since = RESET_DATE > monzoFloor ? RESET_DATE : monzoFloor

  const all: any[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page++) {
    const u = new URL('https://api.monzo.com/transactions')
    u.searchParams.set('account_id', retail.id)
    u.searchParams.set('limit', '100')
    if (cursor) u.searchParams.set('since', cursor)
    else u.searchParams.set('since', since.toISOString())
    const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) {
      const detail = await r.text()
      if (page === 0) return json({ ok: false, problem: 'transactions_failed', detail })
      break
    }
    const batch = (await r.json()).transactions ?? []
    all.push(...batch)
    if (batch.length < 100) break
    cursor = batch[batch.length - 1].id
  }

  const inbound = all.filter((t: any) =>
    t.amount > 0 && !t.decline_reason && t.scheme !== 'uk_retail_pot' &&
    t.counterparty && (t.counterparty.account_number || t.counterparty.user_id) &&
    new Date(t.created) >= RESET_DATE)

  const { data: storedRows } = await supabase
    .from('tutoring_monzo_transactions').select('monzo_transaction_id')
  const stored = new Set((storedRows ?? []).map((r: any) => r.monzo_transaction_id))

  const { data: students } = await supabase
    .from('tutoring_students').select('id,name,monzo_payer_name,monzo_counterparty_key')
    .eq('owner_id', MONZO_OWNER_ID)
  const roster: any[] = students ?? []

  let autoLogged = 0
  let unmatched = 0
  const logged: any[] = []

  for (const t of inbound) {
    if (stored.has(t.id)) continue

    const cp = t.counterparty ?? {}
    const key = counterpartyKey(cp)

    let student = roster.find((s) => s.monzo_counterparty_key && s.monzo_counterparty_key === key)
    let learned = false
    if (!student) {
      student = roster.find((s) => s.monzo_payer_name && nameMatches(s.monzo_payer_name, cp.name, t.description))
      if (student) learned = true
    }

    if (!student) { unmatched++; continue }

    const amount = t.amount / 100
    const datePaid = String(t.created ?? '').slice(0, 10)

    const { data: pay } = await supabase.from('tutoring_payments').insert({
      student_id: student.id,
      owner_id: MONZO_OWNER_ID,
      amount,
      date_paid: datePaid,
      method: 'monzo_auto',
      monzo_transaction_id: t.id,
    }).select().single()

    await supabase.from('tutoring_monzo_transactions').insert({
      monzo_transaction_id: t.id,
      amount,
      description: t.description ?? null,
      transaction_date: datePaid,
      counterparty_name: cp.name ?? null,
      counterparty_key: key,
      matched_student_id: student.id,
      matched_payment_id: pay?.id ?? null,
      status: 'matched',
    })

    if (learned) {
      await supabase.from('tutoring_students')
        .update({ monzo_counterparty_key: key }).eq('id', student.id)
      student.monzo_counterparty_key = key
    }

    autoLogged++
    logged.push({ date: datePaid, amount, from: cp.name ?? null, student: student.name })
  }

  if (authRow?.id) {
    await supabase.from('tutoring_monzo_auth')
      .update({ last_synced: new Date().toISOString() }).eq('id', authRow.id)
  }

  return json({
    ok: true,
    inbound_transfers_seen: inbound.length,
    newly_logged: autoLogged,
    unrecognised_awaiting_review: unmatched,
    logged,
  })
})
