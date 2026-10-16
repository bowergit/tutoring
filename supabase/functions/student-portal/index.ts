// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

/**
 * A booking address is safe to put in front of a parent only if it is a plain
 * https page. Anything else - javascript:, data:, a bare word - is either
 * useless or an injection route, and silently dropping it is better than
 * rendering it and hoping.
 */
function safeBookingUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

/**
 * Records that somebody opened a link, and nothing else about them.
 *
 * Whether parents actually look at these pages is the one question nobody has
 * ever been able to answer, and it decides whether the feature is worth
 * anything. Fire and forget on purpose: a failure to write a statistic must
 * never be the reason a parent cannot see their lessons.
 */
function logView_(studentId: string, ownerId: string, view: 'parent' | 'pupil') {
  try {
    const p = supabase.from('tutoring_portal_views')
      .insert({ student_id: studentId, owner_id: ownerId, view })
      .then(() => {}, () => {})
    // Keeps the write alive after the response has been sent, where the
    // runtime supports it, rather than racing the function shutting down.
    ;(globalThis as any).EdgeRuntime?.waitUntil?.(p)
  } catch { /* never fatal */ }
}

// Below this, a tracker link tells the parent more than the chart would.
const MIN_PAPERS_FOR_CHART = 3

// Past papers, the chart and the grade estimate are only shown for these
// tutors' students. The boundary tables cover Edexcel and the big four
// English boards, and the sheets are one particular tracker template.
// Neither assumption holds for someone else's students, so nobody else's
// parents are shown a grade the app is in no position to stand behind.
const MONZO_SETTLE_OWNER = 'babb06b5-b5e0-4436-8b72-bc5556814956'

const PROGRESS_OWNERS = new Set([
  'babb06b5-b5e0-4436-8b72-bc5556814956',
  '46d0cf40-02a3-4767-8662-c3c4b3c125d4',
  '80ee6bad-92f7-4536-8db2-9c645d24f4b1',
])

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const round1 = (n: number) => Math.round(n * 10) / 10

// ─── Grade boundaries ──────────────────────────────────────────────
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

/**
 * The progress half of both pages, worked out once so the pupil's page and the
 * parent's cannot drift into disagreeing about the same papers.
 */
async function loadProgress(student: any) {
  if (!student.show_progress || !PROGRESS_OWNERS.has(student.owner_id)) {
    return { progress: null, grade: null }
  }

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

  let grade = null
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

  // One paper is not a chart, it is a dot, and swapping a working tracker link
  // for it leaves the reader with less than they started with. The view only
  // takes over once there is either enough of a line to read or a whole
  // sitting to put a grade on, and it starts doing that on its own as soon as
  // the papers are there.
  const worthShowing = papers.length >= MIN_PAPERS_FOR_CHART || !!(grade && grade.latest)
  if (!worthShowing) return { progress: null, grade: null }
  return { progress: buildProgress(papers, student), grade }
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const url = new URL(req.url)
  const token = url.searchParams.get('t')
  if (!token) return json({ ok: false, problem: 'missing_token' }, 400)
  // The token is interpolated into a PostgREST or() filter below, whose syntax
  // uses commas and parentheses as separators, so anything that is not plainly
  // a UUID is refused rather than passed through. Every real token is one.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return json({ ok: false, problem: 'not_found' }, 404)
  }

  // Two doors into the same student, and which one was used decides what comes
  // back. The pupil's link is a different token rather than a different path on
  // the parent's, because sharing one token and letting the URL decide is no
  // protection: anyone holding it could change the path and read the money.
  const { data: student, error: studentErr } = await supabase
    .from('tutoring_students')
    .select('id,name,owner_id,pays_in_cash,spreadsheet_url,show_progress,exam_board,exam_tier,school_year,public_token,student_token')
    .or(`public_token.eq.${token},student_token.eq.${token}`)
    .maybeSingle()
  if (studentErr || !student) return json({ ok: false, problem: 'not_found' }, 404)

  const pupilView = student.student_token === token
  if (!['GET','POST'].includes(req.method)) return json({ok:false,problem:'method_not_allowed'},405)
  if (req.method === 'POST') {
    if (pupilView || student.owner_id !== MONZO_SETTLE_OWNER) return json({ok:false,problem:'forbidden'},403)
    if (Number(req.headers.get('content-length') || 0) > 8000) return json({ok:false,problem:'too_large'},413)
    let body: any
    try { const raw=await req.text(); if(raw.length>8000) return json({ok:false,problem:'too_large'},413); body=JSON.parse(raw) }
    catch { return json({ok:false,problem:'invalid_request'},400) }
    if (!body || typeof body!=='object' || typeof body.plan_id!=='string') return json({ok:false,problem:'invalid_request'},400)
    const {data:plan,error:planErr}=await supabase.from('tutoring_weekly_plans').select('*').eq('id',body.plan_id).eq('student_id',student.id).eq('owner_id',student.owner_id).maybeSingle()
    if(planErr || !plan) return json({ok:false,problem:'agreement_not_found'},404)
    if(body.action==='accept') {
      if(plan.status!=='proposed' || body.terms_version!==plan.terms_version || body.agree!==true || typeof body.signer_name!=='string' || body.signer_name.trim().length<2 || body.signer_name.trim().length>150) return json({ok:false,problem:'Please read and accept the current agreement.'},400)
      // The signing trail: where and on what the agreement was accepted.
      const signerIp=(req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')||'').split(',')[0].trim().slice(0,64)||null
      const signerAgent=(req.headers.get('user-agent')||'').slice(0,300)||null
      const {error}=await supabase.from('tutoring_weekly_acceptances').insert({plan_id:plan.id,owner_id:student.owner_id,signer_name:body.signer_name.trim(),terms_version:plan.terms_version,terms_text:plan.terms_text,start_early:body.start_early===true,signer_ip:signerIp,signer_user_agent:signerAgent})
      if(error) return json({ok:false,problem:error.code==='23505'?'This agreement has already been accepted. Refresh to see the record.':(error.message||'Could not accept the agreement. Ask Daniel for help.')},400)
      return json({ok:true})
    }
    if(body.action==='end' || body.action==='cooling_off') {
      const {data:acceptance}=await supabase.from('tutoring_weekly_acceptances').select('accepted_at').eq('plan_id',plan.id).maybeSingle()
      if(!acceptance || plan.status==='ended' || plan.end_requested_at) return json({ok:false,problem:'This arrangement cannot receive another notice request. Contact Daniel.'},400)
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
      const withinCoolingOff=Date.now()<new Date(acceptance.accepted_at).getTime()+14*86400000
      if(body.action==='cooling_off' && !withinCoolingOff) return json({ok:false,problem:'The cooling off period has ended. Please use ordinary notice or contact Daniel.'},400)
      const end=new Date(day+'T12:00:00Z'); end.setUTCDate(end.getUTCDate()+(body.action==='end'?plan.notice_days:0))
      const endsBefore=[end.toISOString().slice(0,10),plan.starts_on].sort().pop()!
      const changes:any={ends_before:plan.ends_before && plan.ends_before<endsBefore ? plan.ends_before : endsBefore,end_requested_at:new Date().toISOString()}
      if(body.action==='cooling_off') { changes.review_required=true; changes.status='ended' }
      // If the tutor has not activated yet, an end request simply withdraws the proposal.
      if(plan.status==='proposed') { changes.status='ended'; changes.ends_before=plan.starts_on }
      const {error}=await supabase.from('tutoring_weekly_plans').update(changes).eq('id',plan.id)
      if(error) return json({ok:false,problem:'Could not record notice. Contact Daniel to give notice directly.'},400)
      return json({ok:true,ends_before:changes.ends_before,review_required:!!changes.review_required})
    }
    return json({ok:false,problem:'invalid_action'},400)
  }

  // Built and returned before anything else is even fetched. Filtering a full
  // payload down in the browser would still have sent the balance and the
  // grades over the wire, where anyone can read them.
  if (pupilView) {
    const todayIso = new Date().toISOString().slice(0, 10)
    const horizon = new Date(Date.now() + 183 * 86400000).toISOString().slice(0, 10)
    const { data: pupilLessons } = await supabase.from('tutoring_lessons')
      .select('lesson_date,start_time,status')
      .eq('student_id', student.id)
      .neq('status', 'cancelled')
      .lte('lesson_date', horizon)
      .order('lesson_date')
    const all = pupilLessons ?? []
    // No pay_status on either list, deliberately. Whether a lesson was paid
    // for is between the tutor and whoever pays, and is none of the pupil's
    // business.
    const shapePupil = (l: any) => ({ date: l.lesson_date, time: l.start_time, status: l.status })
    const { progress, grade } = await loadProgress(student)
    logView_(student.id, student.owner_id, 'pupil')
    return json({
      ok: true,
      view: 'student',
      name: student.name,
      upcoming: all
        .filter((l: any) => l.status === 'scheduled' && l.lesson_date >= todayIso)
        .map(shapePupil),
      recent: all
        .filter((l: any) => l.status !== 'scheduled' && l.lesson_date <= todayIso)
        .sort((a: any, b: any) => b.lesson_date.localeCompare(a.lesson_date))
        .slice(0, 8)
        .map(shapePupil),
      progress,
      grade,
    })
  }

  const accountReads = await Promise.all([
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

  if(accountReads.some(r=>r.error)) return json({ok:false,problem:'Could not load your account. Please try again.'},503)
  const [{data:lessons},{data:rateHistoryRaw},{data:ownerUser}]=accountReads
  let weeklyPlans:any[] = [], weeklyCharges:any[] = [], weeklyAcceptances:any[] = []
  if(student.owner_id===MONZO_SETTLE_OWNER) {
    const results=await Promise.all([
      supabase.from('tutoring_weekly_plans').select('*').eq('student_id',student.id).eq('owner_id',student.owner_id).order('created_at'),
      supabase.from('tutoring_weekly_charges').select('*').eq('student_id',student.id).eq('owner_id',student.owner_id).order('charge_date'),
    ])
    if(results.some(r=>r.error)) return json({ok:false,problem:'Could not load the weekly account. Please try again.'},503)
    weeklyPlans=results[0].data || []; weeklyCharges=results[1].data || []
    if(weeklyPlans.length) {
      const {data,error}=await supabase.from('tutoring_weekly_acceptances').select('plan_id,signer_name,accepted_at,signer_ip,start_early,terms_version,terms_text').in('plan_id',weeklyPlans.map(p=>p.id))
      if(error) return json({ok:false,problem:'Could not load your agreement.'},503)
      weeklyAcceptances=data || []
    }
  }
  const covered=(l:any)=>weeklyPlans.some(p=>p.status!=='proposed' && weeklyAcceptances.some(a=>a.plan_id===p.id) && l.lesson_date>=p.starts_on && (!p.ends_before || l.lesson_date < new Date(new Date(p.starts_on+'T12:00:00Z').getTime()+Math.ceil((new Date(p.ends_before+'T12:00:00Z').getTime()-new Date(p.starts_on+'T12:00:00Z').getTime())/604800000)*604800000).toISOString().slice(0,10)))
  const { progress, grade } = await loadProgress(student)

  const rateHistory = rateHistoryRaw ?? []
  const lessonIds = (lessons ?? []).map((l: any) => l.id)

  const { data: allocations } = lessonIds.length
    ? await supabase.from('tutoring_payment_allocations').select('lesson_id,amount,payment_id').in('lesson_id', lessonIds)
    : { data: [] as any[] }

  const paymentRead = await supabase.from('tutoring_payments')
    .select('id,date_paid,amount')
    .eq('student_id', student.id)
    .is('deleted_at', null)
  if(paymentRead.error) return json({ok:false,problem:'Could not load payments.'},503)
  const payments=paymentRead.data
  const dateByPaymentId = new Map((payments ?? []).map((p: any) => [p.id, p.date_paid]))

  const paidByLesson = new Map<string, number>()
  const datesByLesson = new Map<string, { date: string; amount: number }[]>()
  for (const a of allocations ?? []) {
    paidByLesson.set(a.lesson_id, (paidByLesson.get(a.lesson_id) ?? 0) + Number(a.amount))
    const list = datesByLesson.get(a.lesson_id) ?? []
    list.push({ date: dateByPaymentId.get(a.payment_id) ?? null, amount: Number(a.amount) })
    datesByLesson.set(a.lesson_id, list)
  }

  const todayStr = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
  const sixMonthsOutStr = new Date(Date.now() + 183 * 86400000).toISOString().slice(0, 10)

  function payStatus(l: any): string {
    const rate = rateForLesson(l, rateHistory)
    const paid = paidByLesson.get(l.id) ?? 0
    if (l.pre_settled || l.is_complimentary || paid >= rate - 0.005) return 'paid'
    if (paid > 0.005) return 'partial'
    return 'unpaid'
  }

  const shape = (l: any) => ({
    weekly_included: covered(l),
    date: l.lesson_date,
    time: l.start_time,
    status: l.status,
    pay_status: payStatus(l),
    // What it cost and what has actually landed against it. Without these the
    // page could say a lesson was part paid but never what was still left on
    // it, and a lesson settled in two instalments looked the same as one paid
    // in full on a single day.
    rate: l.is_complimentary || l.pre_settled ? 0 : rateForLesson(l, rateHistory),
    paid: paidByLesson.get(l.id) ?? 0,
    free: !!l.is_complimentary,
    pre_settled: !!l.pre_settled,
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
  const individualCharged = (lessons ?? [])
    .filter((l: any) => l.status === 'completed' && !l.is_complimentary && !l.pre_settled && !covered(l))
    .reduce((sum: number, l: any) => sum + rateForLesson(l, rateHistory), 0)
  const charged=individualCharged+weeklyCharges.filter(c=>c.charge_date<=todayStr).reduce((sum,c)=>sum+Number(c.amount),0)
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
      l.status === 'completed' && !l.is_complimentary && !l.pre_settled && !covered(l) &&
      (paidByLesson.get(l.id) ?? 0) < rateForLesson(l, rateHistory) - 0.005).length,
  }

  const weekly=weeklyPlans.length ? (()=>{
    let remaining=Math.round(paidTotal*100)
    const entries=[...(lessons || []).filter((l:any)=>!covered(l) && !l.pre_settled && !l.is_complimentary && l.status!=='cancelled').map((l:any)=>({date:l.lesson_date,kind:'Individual lesson',amount:rateForLesson(l,rateHistory),waived:false,reason:null})),
      ...weeklyCharges.map(c=>({date:c.charge_date,kind:'Weekly place',amount:Number(c.amount),waived:c.waived,reason:c.reason}))]
      .sort((a,b)=>a.date.localeCompare(b.date)).map(c=>{const paid=Math.min(Math.max(remaining,0),Math.round(c.amount*100));remaining-=paid;return {...c,paid:paid/100,due:c.date<=todayStr}})
    const plan=weeklyPlans.find(p=>p.status!=='ended') || weeklyPlans[weeklyPlans.length-1]
    const acceptance=weeklyAcceptances.find(a=>a.plan_id===plan.id) || null
    return {plan:{id:plan.id,starts_on:plan.starts_on,ends_before:plan.ends_before,weekly_fee:plan.weekly_fee,lesson_slot:plan.lesson_slot,notice_days:plan.notice_days,status:plan.status,terms_version:plan.terms_version,terms_text:plan.terms_text,end_requested_at:plan.end_requested_at,review_required:plan.review_required},acceptance,
      history:weeklyPlans.filter(p=>p.id!==plan.id).map(p=>({terms_text:p.terms_text,acceptance:weeklyAcceptances.find(a=>a.plan_id===p.id)||null})),entries,payments:payments || []}
  })():null
  const tutor = ownerUser?.user
  const tutorMeta = tutor?.user_metadata ?? {}

  logView_(student.id, student.owner_id, 'parent')

  return json({
    ok: true,
    name: student.name,
    upcoming,
    recent,
    progress,
    grade,
    account,
    weekly,
    // Monzo settle up is deliberately limited to Daniel's own tutoring account.
    // Cash students never get a bank transfer button.
    can_settle_up: student.owner_id === MONZO_SETTLE_OWNER && !student.pays_in_cash && !weeklyPlans.some(p=>p.review_required),
    // Still sent when there is no progress view, so those students keep the
    // plain link to their tracker rather than losing it.
    spreadsheet_url: progress ? null : (student.spreadsheet_url || null),
    tutor: {
      name: tutorMeta.display_name || null,
      email: tutorMeta.contact_email || tutor?.email || null,
      phone: tutorMeta.contact_phone || null,
      // Where a parent books an extra lesson. Checked here rather than in the
      // browser, because this address is typed by a tutor and then rendered as
      // a link on a page we serve to that tutor's clients.
      booking_url: safeBookingUrl(tutorMeta.booking_url),
    },
  })
})

