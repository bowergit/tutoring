// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

// No login system: security is the token itself being unguessable (a v4
// UUID), same trust model as a Stripe invoice link. Deliberately returns
// only a student's own name, lessons, payment status and past papers -
// nothing else on their row, and nothing about any other student or the
// tutor's business as a whole. The tutor's own contact details ARE included,
// since they are the point of the "message the tutor" buttons.
function rateForLesson(lesson: any, rateHistory: any[]): number {
  if (lesson.rate_charged != null) return Number(lesson.rate_charged)
  let rate = 90
  for (const rh of rateHistory) {
    if (rh.effective_from_date <= lesson.lesson_date) rate = Number(rh.rate)
    else break
  }
  return rate
}

// Below this, a tracker link tells the parent more than the chart would.
const MIN_PAPERS_FOR_CHART = 3

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const round1 = (n: number) => Math.round(n * 10) / 10

// ─── Grade boundaries ────────────────────────────────────────────────────
//
// The tracker records a percentage per paper. Boundaries are published as raw
// marks for a whole set. Those meet in the middle because every paper in a
// set carries the same maximum (2 × 100 for International GCSE, 3 × 80 for
// most GCSEs, 3 × 100 for OCR), so the set percentage is the mean of the
// paper percentages, and a boundary converts to a percentage by dividing by
// the set's maximum. That works whether the sheet holds raw marks or
// percentages, which is the whole point: some do, some don't.

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  jun: 6, june: 6, may: 6, summer: 6,
  nov: 11, november: 11, oct: 11, autumn: 11, winter: 11,
}

/** "June 2024", "Nov 2020", "Jan 2019", "2024 June" → { year, month }. */
function parseSeries(setName: string): { year: number; month: number } | null {
  const s = String(setName || '').toLowerCase()
  const year = s.match(/(20\d{2})/)
  if (!year) return null
  let month: number | null = null
  for (const key of Object.keys(MONTHS)) {
    if (new RegExp(`\\b${key}`).test(s)) { month = MONTHS[key]; break }
  }
  if (month == null) return null
  return { year: parseInt(year[1], 10), month }
}

/**
 * Which published table applies. The board comes off the student record; the
 * tier is read off the paper codes first, because "1H / 2H" is a fact about
 * the papers actually sat and the tier field is one the tutor may never have
 * filled in.
 */
function examIdentity(student: any, papers: any[]) {
  const raw = String(student.exam_board || '').trim()
  if (!raw) return null

  const lower = raw.toLowerCase()
  const international = /\bi\s*gcse\b|international/.test(lower)
  // Cambridge sits on a different scale entirely and is not in the table.
  if (/cambridge|cie/.test(lower)) return null

  let board: string | null = null
  if (/aqa/.test(lower)) board = 'AQA'
  else if (/edexcel|pearson/.test(lower)) board = 'Edexcel'
  else if (/eduqas|wjec/.test(lower)) board = 'Eduqas'
  else if (/ocr/.test(lower)) board = 'OCR'
  if (!board) return null
  // Only Edexcel publishes the International GCSE table held here.
  if (international && board !== 'Edexcel') return null

  const codes = papers.map((p) => String(p.paper_code || '').toUpperCase())
  let tier: string | null = null
  if (codes.some((c) => /H\b|H$|HR$/.test(c))) tier = 'higher'
  else if (codes.some((c) => /F\b|F$|FR$/.test(c))) tier = 'foundation'
  if (!tier) {
    const t = String(student.exam_tier || '').toLowerCase()
    if (t === 'higher' || t === 'foundation') tier = t
  }
  if (!tier) return null

  return { qualification: international ? 'International GCSE' : 'GCSE', board, tier }
}

const seriesLabel = (year: number, month: number) =>
  `${month === 1 ? 'Jan' : month === 6 ? 'June' : 'Nov'} ${year}`

/** Highest grade whose boundary the score reaches. */
function gradeFor(pct: number, pcts: Record<string, number>) {
  const order = Object.keys(pcts).map(Number).sort((a, b) => b - a)
  for (const g of order) {
    if (pct >= pcts[String(g)] - 0.0001) {
      const idx = order.indexOf(g)
      const next = idx > 0 ? order[idx - 1] : null
      return { grade: String(g), next: next == null ? null : String(next) }
    }
  }
  return { grade: 'U', next: String(order[order.length - 1]) }
}

function toPcts(grades: Record<string, number>, maxMark: number) {
  const out: Record<string, number> = {}
  for (const [g, m] of Object.entries(grades)) out[g] = round1((Number(m) / maxMark) * 100)
  return out
}

/**
 * A grade per completed set, plus the table it was read off. Sets that are
 * still missing a paper are reported as in progress rather than graded on a
 * partial score, which would flatter or punish depending on which paper is
 * outstanding.
 */
function buildGrade(papers: any[], student: any, rows: any[]) {
  const identity = examIdentity(student, papers)
  if (!identity || rows.length === 0) return null

  const papersPerSet = rows[0].papers_in_set
  const maxMark = rows[0].max_mark

  const byKey = new Map<string, any>()
  for (const r of rows) {
    byKey.set(`${r.series_year}-${r.series_month}`, {
      year: r.series_year,
      month: r.series_month,
      label: seriesLabel(r.series_year, r.series_month),
      max_mark: r.max_mark,
      grades: r.boundaries,
      pcts: toPcts(r.boundaries, r.max_mark),
    })
  }

  // Series like June 2021, where papers exist but no boundaries were ever
  // published, fall back to the average of every published series rather than
  // showing nothing. Flagged so the page can say which it used.
  const allGrades: Record<string, number[]> = {}
  for (const r of rows) {
    for (const [g, m] of Object.entries(r.boundaries)) {
      (allGrades[g] ||= []).push(Number(m))
    }
  }
  const typicalGrades: Record<string, number> = {}
  for (const [g, xs] of Object.entries(allGrades)) typicalGrades[g] = Math.round(mean(xs))
  const typical = {
    label: 'typical',
    max_mark: maxMark,
    grades: typicalGrades,
    pcts: toPcts(typicalGrades, maxMark),
  }

  // "1H/2H" and "1HR/2HR" are two different sittings of the same series: the R
  // papers are the international replacement set. Pooling all four averages
  // between them and can report a grade neither sitting actually earned. Sam's
  // June 2024 is the case in point: 160 marks on H is a grade 8, 166 on HR is
  // a 9, and the pooled 163 reads as a 9 the H papers never reached.
  const sets = new Map<string, any>()
  for (const p of papers) {
    const variant = /R$/i.test(String(p.paper_code || '')) ? 'R' : ''
    const key = `${p.sheet_tab}|${p.paper_set}|${variant}`
    if (!sets.has(key)) {
      sets.set(key, {
        set: variant ? `${p.paper_set} (R)` : p.paper_set,
        series: p.paper_set,
        tab: p.sheet_tab,
        papers: [],
      })
    }
    sets.get(key).papers.push(p)
  }

  const out: any[] = []
  for (const s of sets.values()) {
    // Parsed off the series, not the label, so the "(R)" suffix never stops a
    // set from finding its own published boundaries.
    const parsed = parseSeries(s.series)
    const done = s.papers.length
    const pct = round1(mean(s.papers.map((p: any) => Number(p.percentage))))
    const lastDate = s.papers.map((p: any) => p.date_taken).sort().slice(-1)[0]

    const entry: any = {
      set: s.set,
      tab: s.tab,
      date: lastDate,
      papers_done: done,
      papers_needed: papersPerSet,
      complete: done >= papersPerSet,
      mean_pct: pct,
      total_marks: Math.round((pct / 100) * maxMark),
      max_mark: maxMark,
      grade: null,
      next_grade: null,
      marks_to_next: null,
      series_used: null,
      exact_series: false,
    }

    if (entry.complete) {
      const table = (parsed && byKey.get(`${parsed.year}-${parsed.month}`)) || typical
      entry.exact_series = table !== typical
      entry.series_used = table.label
      const g = gradeFor(pct, table.pcts)
      entry.grade = g.grade
      entry.next_grade = g.next
      if (g.next != null) {
        const needPct = table.pcts[g.next]
        entry.marks_to_next = Math.max(1, Math.ceil(((needPct - pct) / 100) * maxMark))
      }
    }
    out.push(entry)
  }

  out.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const completed = out.filter((e) => e.complete)

  return {
    ...identity,
    spec_code: rows[0].spec_code,
    papers_per_set: papersPerSet,
    max_mark: maxMark,
    sets: out,
    latest: completed.length ? completed[completed.length - 1] : null,
    // Newest first, which is the order anyone reads a boundary table in.
    boundaries: [...byKey.values()].sort((a, b) =>
      b.year - a.year || b.month - a.month),
    typical,
  }
}

// Everything a parent needs to read the shape of the last few months without
// being handed a spreadsheet. Computed here so the page stays a renderer and
// the same figures back both the chart and the summary line.
function buildProgress(papers: any[], student: any) {
  if (papers.length === 0) return null

  const pcts = papers.map((p) => Number(p.percentage))
  const latest = papers[papers.length - 1]
  const best = papers.reduce((a, b) => (Number(b.percentage) > Number(a.percentage) ? b : a))

  // Enough papers to compare two windows fairly; otherwise fall back to the
  // plain distance travelled, which is the only honest thing to say about
  // three data points.
  let trend: number | null = null
  let trendBasis = ''
  if (papers.length >= 6) {
    const recent = mean(pcts.slice(-3))
    const prior = mean(pcts.slice(-6, -3))
    trend = round1(recent - prior)
    trendBasis = 'last 3 papers vs the 3 before'
  } else if (papers.length >= 2) {
    trend = round1(pcts[pcts.length - 1] - pcts[0])
    trendBasis = 'since the first paper'
  }

  // How many papers make up one sitting, read off the data rather than assumed:
  // an IGCSE series is two papers, a GCSE series is three.
  const bySet = new Map<string, Set<string>>()
  for (const p of papers) {
    const k = `${p.sheet_tab}|${p.paper_set}`
    if (!bySet.has(k)) bySet.set(k, new Set())
    bySet.get(k)!.add(p.paper_code)
  }
  const papersPerSeries = Math.max(...[...bySet.values()].map((s) => s.size))

  const board = [student.exam_board, student.exam_tier]
    .filter(Boolean)
    .map((s: string) => String(s).trim())
    .join(' · ')

  return {
    exam_label: board || null,
    count: papers.length,
    latest: { pct: round1(Number(latest.percentage)), date: latest.date_taken, label: `${latest.paper_set} ${latest.paper_code}`.trim() },
    best: { pct: round1(Number(best.percentage)), date: best.date_taken, label: `${best.paper_set} ${best.paper_code}`.trim() },
    average: round1(mean(pcts)),
    trend,
    trend_basis: trendBasis,
    papers_per_series: papersPerSeries,
    papers: papers.map((p) => ({
      date: p.date_taken,
      label: `${p.paper_set} ${p.paper_code}`.trim(),
      set: p.paper_set,
      code: p.paper_code,
      pct: round1(Number(p.percentage)),
      // Kept so the page can show "20 / 80" where the tracker recorded a raw
      // mark, rather than only ever a percentage the parent can't check.
      raw: p.score_raw == null ? null : Number(p.score_raw),
      max: p.max_score == null ? null : Number(p.max_score),
      tab: p.sheet_tab,
    })),
  }
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const token = url.searchParams.get('t')
  if (!token) return json({ ok: false, problem: 'missing_token' }, 400)

  const { data: student, error: studentErr } = await supabase
    .from('tutoring_students')
    .select('id,name,owner_id,spreadsheet_url,show_progress,exam_board,exam_tier,school_year')
    .eq('public_token', token)
    .maybeSingle()
  if (studentErr || !student) return json({ ok: false, problem: 'not_found' }, 404)

  const [{ data: lessons }, { data: rateHistoryRaw }, { data: ownerUser }] = await Promise.all([
    supabase.from('tutoring_lessons')
      .select('id,lesson_date,start_time,status,is_complimentary,pre_settled,rate_charged')
      .eq('student_id', student.id)
      .neq('status', 'cancelled')
      .order('lesson_date'),
    supabase.from('tutoring_rate_history')
      .select('rate,effective_from_date')
      .eq('student_id', student.id)
      .order('effective_from_date'),
    supabase.auth.admin.getUserById(student.owner_id),
  ])

  // Only fetched when this student is opted in, so the view can be proved out
  // on one account before anyone else's parents see it.
  let progress = null
  let grade = null
  if (student.show_progress) {
    const { data: papersRaw } = await supabase.from('tutoring_past_papers')
      .select('paper_set,paper_code,percentage,score_raw,max_score,date_taken,sheet_tab')
      .eq('student_id', student.id)
      // Two papers sat on the same day are common, and a tie with no defined
      // order lets "latest" and the trend arrow change between refreshes on
      // identical data. The extra keys only ever break ties.
      .order('date_taken')
      .order('paper_set')
      .order('paper_code')
    const papers = papersRaw ?? []

    const identity = examIdentity(student, papers)
    if (identity) {
      const { data: rows } = await supabase.from('exam_grade_boundaries')
        .select('qualification,board,spec_code,tier,series_year,series_month,max_mark,papers_in_set,boundaries')
        .eq('qualification', identity.qualification)
        .eq('board', identity.board)
        .eq('tier', identity.tier)
        .order('series_year')
      grade = buildGrade(papers, student, rows ?? [])
    }

    // One paper is not a chart, it is a dot, and swapping a working tracker
    // link for it leaves the parent with less than they started with. The view
    // only takes over once there is either enough of a line to read or a whole
    // sitting to put a grade on, and it starts doing that on its own as soon
    // as the papers are there. Nothing to remember, nothing to switch on.
    const worthShowing = papers.length >= MIN_PAPERS_FOR_CHART || !!(grade && grade.latest)
    if (worthShowing) progress = buildProgress(papers, student)
    else grade = null
  }

  const rateHistory = rateHistoryRaw ?? []
  const lessonIds = (lessons ?? []).map((l: any) => l.id)

  const { data: allocations } = lessonIds.length
    ? await supabase.from('tutoring_payment_allocations').select('lesson_id,amount,payment_id').in('lesson_id', lessonIds)
    : { data: [] as any[] }

  const { data: payments } = await supabase.from('tutoring_payments')
    .select('id,date_paid,amount')
    .eq('student_id', student.id)
    .is('deleted_at', null)
  const dateByPaymentId = new Map((payments ?? []).map((p: any) => [p.id, p.date_paid]))

  const paidByLesson = new Map<string, number>()
  const datesByLesson = new Map<string, { date: string; amount: number }[]>()
  for (const a of allocations ?? []) {
    paidByLesson.set(a.lesson_id, (paidByLesson.get(a.lesson_id) ?? 0) + Number(a.amount))
    const list = datesByLesson.get(a.lesson_id) ?? []
    list.push({ date: dateByPaymentId.get(a.payment_id) ?? null, amount: Number(a.amount) })
    datesByLesson.set(a.lesson_id, list)
  }

  const todayStr = new Date().toISOString().slice(0, 10)
  const sixMonthsOutStr = new Date(Date.now() + 183 * 86400000).toISOString().slice(0, 10)

  function payStatus(l: any): string {
    const rate = rateForLesson(l, rateHistory)
    const paid = paidByLesson.get(l.id) ?? 0
    if (l.pre_settled || l.is_complimentary || paid >= rate - 0.005) return 'paid'
    if (paid > 0.005) return 'partial'
    return 'unpaid'
  }

  const shape = (l: any) => ({
    date: l.lesson_date,
    time: l.start_time,
    status: l.status,
    pay_status: payStatus(l),
    paid_dates: (datesByLesson.get(l.id) ?? []).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
  })

  const upcoming = (lessons ?? [])
    .filter((l: any) => l.status === 'scheduled' && l.lesson_date <= sixMonthsOutStr)
    .map(shape)

  const recent = (lessons ?? [])
    .filter((l: any) => l.status !== 'scheduled' && l.lesson_date <= todayStr)
    .sort((a: any, b: any) => b.lesson_date.localeCompare(a.lesson_date))
    .slice(0, 8)
    .map(shape)

  // Deliberately the same sum the tutor sees on the student card: lessons
  // actually taught, minus everything ever paid. Lessons before the July 2026
  // reset are declared settled and free lessons were never chargeable, so
  // neither counts. A negative balance is money paid ahead, which is why the
  // page can say "in credit" rather than only ever nagging.
  const charged = (lessons ?? [])
    .filter((l: any) => l.status === 'completed' && !l.is_complimentary && !l.pre_settled)
    .reduce((sum: number, l: any) => sum + rateForLesson(l, rateHistory), 0)
  const paidTotal = (payments ?? []).reduce((sum: number, p: any) => sum + Number(p.amount), 0)
  const balance = Math.round((charged - paidTotal) * 100) / 100

  const nextRate = rateForLesson(
    { lesson_date: todayStr, rate_charged: null }, rateHistory,
  )
  const account = {
    balance,
    owed: balance > 0.005 ? balance : 0,
    credit: balance < -0.005 ? -balance : 0,
    // Only meaningful while they are ahead, and only as a rough count.
    credit_covers: balance < -0.005 && nextRate > 0 ? Math.floor(-balance / nextRate) : 0,
    unpaid_lessons: (lessons ?? []).filter((l: any) =>
      l.status === 'completed' && !l.is_complimentary && !l.pre_settled &&
      (paidByLesson.get(l.id) ?? 0) < rateForLesson(l, rateHistory) - 0.005).length,
  }

  const tutor = ownerUser?.user
  const tutorMeta = tutor?.user_metadata ?? {}

  return json({
    ok: true,
    name: student.name,
    upcoming,
    recent,
    progress,
    grade,
    account,
    // Still sent when there is no progress view, so those students keep the
    // plain link to their tracker rather than losing it.
    spreadsheet_url: progress ? null : (student.spreadsheet_url || null),
    tutor: {
      name: tutorMeta.display_name || null,
      email: tutorMeta.contact_email || tutor?.email || null,
      phone: tutorMeta.contact_phone || null,
    },
  })
})
