// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const MONZO_CLIENT_ID = Deno.env.get('MONZO_CLIENT_ID')!
const MONZO_CLIENT_SECRET = Deno.env.get('MONZO_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const RESET_DATE = new Date('2026-07-27T00:00:00Z')

// The Monzo connection is Daniel's own bank account. This endpoint lists who
// has paid him and lets a payment be logged against a student, so it answers
// his signed-in session and nobody else's, and only ever touches his students.
// It used to answer anyone with the URL, which is in the app's public source:
// a list of payer names, amounts and references, and a way to log payments.
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

function counterpartyKey(cp: any): string {
  return cp.account_number ? `${cp.sort_code ?? ''}:${cp.account_number}` : `monzo:${cp.user_id}`
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (!(await callerAllowed(req))) return json({ ok: false, problem: 'unauthorized' }, 401)

  let token: string
  try { token = await getAccessToken() } catch (e) { return json({ ok: false, problem: String(e) }) }

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))

    // Unblock a payer from the managed list.
    if (body.unblock_key) {
      await supabase.from('tutoring_monzo_blocked_payers')
        .delete().eq('counterparty_key', body.unblock_key)
      return json({ ok: true, unblocked: body.unblock_key })
    }

    const txId = body.transaction_id
    if (!txId) return json({ ok: false, problem: 'missing transaction_id' }, 400)

    if (body.dismiss) {
      // Blocking the payer rather than the single transaction is the useful
      // default: money from a given account is either tutoring income or it
      // never is, and dismissing PayPal one payment at a time forever is no
      // use to anyone. body.block === false keeps it to this transaction.
      if (body.block !== false) {
        const r = await fetch(`https://api.monzo.com/transactions/${txId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (r.ok) {
          const t = (await r.json()).transaction
          const cp = t.counterparty ?? {}
          await supabase.from('tutoring_monzo_blocked_payers').upsert({
            counterparty_key: counterpartyKey(cp),
            display_name: cp.name ?? null,
          }, { onConflict: 'counterparty_key' })
        }
      }
      await supabase.from('tutoring_monzo_ignored')
        .upsert({ monzo_transaction_id: txId }, { onConflict: 'monzo_transaction_id' })
      return json({ ok: true, dismissed: txId })
    }

    if (!body.student_id) return json({ ok: false, problem: 'missing student_id' }, 400)

    // Money in Daniel's bank can only ever be logged against Daniel's students.
    const { data: mine } = await supabase.from('tutoring_students')
      .select('id').eq('id', body.student_id).eq('owner_id', MONZO_OWNER_ID).maybeSingle()
    if (!mine) return json({ ok: false, problem: 'unknown_student' }, 400)

    const r = await fetch(`https://api.monzo.com/transactions/${txId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!r.ok) return json({ ok: false, problem: 'transaction_lookup_failed', detail: await r.text() })
    const t = (await r.json()).transaction
    const cp = t.counterparty ?? {}
    const key = counterpartyKey(cp)
    const amount = t.amount / 100
    const datePaid = String(t.created ?? '').slice(0, 10)

    const { data: pay, error: payErr } = await supabase.from('tutoring_payments').insert({
      student_id: body.student_id,
      owner_id: MONZO_OWNER_ID,
      amount,
      date_paid: datePaid,
      method: 'monzo_auto',
      monzo_transaction_id: t.id,
    }).select().single()
    if (payErr) return json({ ok: false, problem: 'payment_insert_failed', detail: payErr.message })

    await supabase.from('tutoring_monzo_transactions').insert({
      monzo_transaction_id: t.id,
      amount,
      description: t.description ?? null,
      transaction_date: datePaid,
      counterparty_name: cp.name ?? null,
      counterparty_key: key,
      matched_student_id: body.student_id,
      matched_payment_id: pay?.id ?? null,
      status: 'matched',
    })

    if (body.remember !== false) {
      await supabase.from('tutoring_students')
        .update({ monzo_counterparty_key: key, monzo_payer_name: cp.name ?? null })
        .eq('id', body.student_id)
    }

    return json({ ok: true, logged: { amount, date: datePaid, from: cp.name ?? null } })
  }

  const accRes = await fetch('https://api.monzo.com/accounts', { headers: { Authorization: `Bearer ${token}` } })
  if (!accRes.ok) return json({ ok: false, problem: 'accounts_failed', detail: await accRes.text() })
  const accounts = (await accRes.json()).accounts ?? []
  const retail = accounts.find((a: any) => a.type === 'uk_retail' && !a.closed)
  if (!retail) return json({ ok: false, problem: 'no_retail_account' })

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
    if (!r.ok) { if (page === 0) return json({ ok: false, problem: 'transactions_failed', detail: await r.text() }); break }
    const batch = (await r.json()).transactions ?? []
    all.push(...batch)
    if (batch.length < 100) break
    cursor = batch[batch.length - 1].id
  }

  const inbound = all.filter((t: any) =>
    t.amount > 0 && !t.decline_reason && t.scheme !== 'uk_retail_pot' &&
    t.counterparty && (t.counterparty.account_number || t.counterparty.user_id) &&
    new Date(t.created) >= RESET_DATE)

  const [{ data: storedRows }, { data: ignoredRows }, { data: blockedRows }, { data: students }] = await Promise.all([
    supabase.from('tutoring_monzo_transactions').select('monzo_transaction_id'),
    supabase.from('tutoring_monzo_ignored').select('monzo_transaction_id'),
    supabase.from('tutoring_monzo_blocked_payers').select('counterparty_key,display_name'),
    supabase.from('tutoring_students').select('id,name,monzo_counterparty_key')
      .eq('active', true).eq('owner_id', MONZO_OWNER_ID),
  ])
  const stored = new Set((storedRows ?? []).map((r: any) => r.monzo_transaction_id))
  const ignored = new Set((ignoredRows ?? []).map((r: any) => r.monzo_transaction_id))
  const blocked = new Set((blockedRows ?? []).map((r: any) => r.counterparty_key))
  const keyToStudent = new Map<string, any>()
  for (const s of students ?? []) {
    if (s.monzo_counterparty_key) keyToStudent.set(s.monzo_counterparty_key, s)
  }

  const pending = inbound
    .filter((t: any) => {
      if (stored.has(t.id) || ignored.has(t.id)) return false
      return !blocked.has(counterpartyKey(t.counterparty ?? {}))
    })
    .map((t: any) => {
      const cp = t.counterparty ?? {}
      const key = counterpartyKey(cp)
      return {
        transaction_id: t.id,
        amount: t.amount / 100,
        date: String(t.created ?? '').slice(0, 10),
        from: cp.name ?? null,
        reference: t.description ?? null,
        suggested_student_id: keyToStudent.get(key)?.id ?? null,
        suggested_student_name: keyToStudent.get(key)?.name ?? null,
      }
    })
    .sort((a: any, b: any) => b.date.localeCompare(a.date))

  return json({
    ok: true,
    count: pending.length,
    pending,
    blocked: (blockedRows ?? []).map((r: any) => ({ key: r.counterparty_key, name: r.display_name })),
  })
})
