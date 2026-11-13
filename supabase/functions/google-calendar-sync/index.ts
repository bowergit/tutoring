// deno-lint-ignore-file no-explicit-any
import { createClient } from 'jsr:@supabase/supabase-js@2'

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const SYNC_WINDOW_DAYS_PAST = 7
const SYNC_WINDOW_DAYS_FUTURE = 90
const DELETE_CHUNK = 50

// How often a name has to turn up in the sync window before the app offers it
// as a new student. One, by choice: a new pupil's first lesson is often booked
// on its own before anything recurring is set up, and that first booking is
// exactly when the tutor wants to be asked. A one-off dentist appointment gets
// offered too, and Ignore puts it away for good.
const CANDIDATE_MIN_EVENTS = 1
const CANDIDATE_TITLE_MAX = 300

// Lessons read from a subscribed feed carry keys beginning with this. It is
// what keeps the two sources from deleting each other's work: a tutor with a
// Google calendar AND an Apple feed would otherwise have every feed lesson
// treated as an orphan by the Google pass, and removed.
const FEED_KEY_PREFIX = 'ics:'

// Shared across every tutor for now, not per-tenant configurable - same
// defaults as the old Apps Script version. Fine as a starting point; a
// per-tutor ignore list is a reasonable later addition, not needed yet.
const IGNORE_PATTERNS = [/^cash /i, /^maths paper/i, /^magic lesson/i, /^call /i, /^tutoring call/i]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

async function getAccessToken_(row: any): Promise<string> {
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
  await supabase.from('tutoring_google_calendar_auth').update({
    access_token: t.access_token,
    access_token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('owner_id', row.owner_id)
  return t.access_token
}

function escapeRegex_(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Matcher { studentId: string; regex: RegExp; rank: number; len: number; active: boolean }

// Which events belong to which student.
//
// A blank pattern must never become new RegExp(''), which matches every title
// and hands one arbitrary student the entire calendar - that is exactly what
// happened to the first tutor who added students without filling the field in.
// Blank now means "no pattern set", and the student's own name is used
// instead, which is what tutors put in event titles anyway.
//
// Archived students are loaded too, deliberately. Leaving them out does not
// make their events unmatched - it makes them match somebody else whose name
// happens to be contained in theirs, so archiving "Dexter Porter" would hand
// his lessons, and the money owed on them, to "Dexter".
async function fetchStudentMatchers_(ownerId: string): Promise<Matcher[]> {
  const { data, error } = await supabase.from('tutoring_students')
    .select('id,name,calendar_title_pattern,active')
    .eq('owner_id', ownerId)
  if (error) throw new Error('matcher_fetch_failed: ' + error.message)

  const matchers: Matcher[] = []

  for (const s of data ?? []) {
    const pattern = String(s.calendar_title_pattern ?? '').trim()
    const name = String(s.name ?? '').trim()
    const active = s.active !== false

    if (pattern) {
      // Deliberately set, so trusted as a regex and always outranks a guess.
      // Wrapped in try/catch: a malformed pattern typed by hand must not take
      // the whole sync down for every other student.
      try {
        matchers.push({ studentId: s.id, regex: new RegExp(pattern, 'i'), rank: 0, len: pattern.length, active })
        continue
      } catch {
        // Fall through to the name-based guess below.
      }
    }
    if (!name) continue

    // Escaped: a name is a literal, and something like "O'Neil (Jr.)" would
    // otherwise be read as regex syntax and either throw or mis-match.
    matchers.push({ studentId: s.id, regex: new RegExp(escapeRegex_(name), 'i'), rank: 1, len: name.length, active })

    const first = name.split(/\s+/)[0]
    if (first && first !== name) {
      // "Issy Hirons" is booked as "Issy Maths Lesson". Every first-name guess
      // ranks below every full-name one, so "Dexter maths lesson" still goes
      // to the student called Dexter rather than to Dexter Porter.
      matchers.push({ studentId: s.id, regex: new RegExp(escapeRegex_(first), 'i'), rank: 2, len: first.length, active })
    }
  }

  // Most specific wins: explicit patterns, then longer names before shorter,
  // so "Dexter Porter" beats "Dexter" on a title containing both.
  matchers.sort((a, b) => a.rank - b.rank || b.len - a.len)
  return matchers
}

function matchStudent_(title: string, matchers: Matcher[]) {
  for (const p of IGNORE_PATTERNS) if (p.test(title)) return { studentId: null, ignored: true }
  for (const m of matchers) {
    if (!m.regex.test(title)) continue
    // An archived student still claims their own events - they are simply
    // skipped rather than passed down the list. Letting the search continue
    // would give the event to the next-best name match, quietly moving their
    // lessons onto a different student.
    if (!m.active) return { studentId: null, ignored: true }
    return { studentId: m.studentId, ignored: false }
  }
  return { studentId: null, ignored: false }
}

// Google's REST events.list is the same API Apps Script's Advanced Calendar
// Service wrapped, so ids produced here are identical in form to whatever a
// tutor's previous Apps-Script-based sync may have written - no re-key if
// someone switches from the old system to this one.
async function fetchEvents_(token: string, calendarId: string, timeMin: Date, timeMax: Date) {
  const items: any[] = []
  let pageToken: string | undefined
  do {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`)
    url.searchParams.set('timeMin', timeMin.toISOString())
    url.searchParams.set('timeMax', timeMax.toISOString())
    url.searchParams.set('singleEvents', 'true')
    url.searchParams.set('maxResults', '2500')
    if (pageToken) url.searchParams.set('pageToken', pageToken)

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error('events_fetch_failed: ' + (await res.text()))
    const body = await res.json()
    items.push(...(body.items ?? []))
    pageToken = body.nextPageToken
  } while (pageToken)

  return items.filter((e: any) => e.status !== 'cancelled')
}

// The absolute instant, used only to decide whether a lesson has happened yet.
function eventStart_(item: any): Date | null {
  // A subscribed feed has already resolved the absolute moment, including any
  // timezone the feed declared. Its dateTime string is deliberately written
  // without an offset, because it is a wall clock reading, so parsing that
  // string here would read it against the server's clock instead.
  if (item.instant instanceof Date) return item.instant
  if (item.start?.dateTime) return new Date(item.start.dateTime)
  if (item.start?.date) return new Date(item.start.date + 'T00:00:00Z')
  return null
}

// The wall-clock date and time as they appear in the tutor's own calendar.
//
// Google returns timed events in the calendar's own timezone with the offset
// attached - "2026-08-11T10:00:00+01:00" - so the leading characters already
// ARE the local time, and are read straight off. Going via a Date and
// toISOString() instead re-expresses the moment in UTC, which silently moves
// every lesson an hour earlier for the whole of British Summer Time (and can
// roll a late-evening lesson onto the wrong day).
function eventLocal_(item: any): { date: string; time: string | null } | null {
  const dt = item.start?.dateTime
  if (typeof dt === 'string' && dt.length >= 16) {
    return { date: dt.slice(0, 10), time: dt.slice(11, 16) }
  }
  const d = item.start?.date
  // All-day events carry a bare "2026-08-22", but slice defensively so a
  // fuller timestamp could never reach a DATE column and fail the insert.
  if (typeof d === 'string' && d.length >= 10) return { date: d.slice(0, 10), time: null }
  return null
}

// How long the event runs, from its start to its end, in minutes. Hourly
// tuition is priced by lesson length, and this is where that length comes
// from unless the tutor sets one by hand. All-day events have no length.
function eventMinutes_(item: any): number | null {
  let m: number | null = null
  if (typeof item.minutes === 'number') m = Math.round(item.minutes)
  else {
    const s = item.start?.dateTime, e = item.end?.dateTime
    if (typeof s === 'string' && typeof e === 'string') m = Math.round((new Date(e).getTime() - new Date(s).getTime()) / 60000)
  }
  return m != null && Number.isFinite(m) && m >= 5 && m <= 600 ? m : null
}

async function upsertLesson_(l: any) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tutoring_lessons?on_conflict=google_event_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify(l),
  })
  return res.ok
}

/**
 * Remembers which unmatched names keep turning up, so the home screen can say
 * "new student in your calendar" after the overnight sync, not only after
 * someone presses Sync in Settings and reads a list.
 *
 * Names that stop appearing are cleared, so a student added by hand or a term
 * that ended does not linger. Names the tutor dismissed are kept for good,
 * because that is what ignoring means, and are returned so the Settings list
 * can leave them out too.
 *
 * Never allowed to fail the sync. Lessons are the job; this is a convenience.
 */
async function recordCandidates_(
  ownerId: string, counts: Map<string, number>, nextDates: Map<string, string>,
): Promise<Set<string>> {
  const dismissed = new Set<string>()
  try {
    const { data: existing, error } = await supabase.from('tutoring_calendar_candidates')
      .select('id,title,dismissed_at').eq('owner_id', ownerId)
    if (error) throw new Error(error.message)
    for (const r of existing ?? []) if (r.dismissed_at) dismissed.add(r.title)

    const seenAt = new Date().toISOString()
    const current = [...counts]
      .filter(([title, count]) => count >= CANDIDATE_MIN_EVENTS && title !== '(untitled)')
      .map(([title, count]) => ({
        owner_id: ownerId,
        title: title.slice(0, CANDIDATE_TITLE_MAX),
        event_count: count,
        next_date: nextDates.get(title) ?? null,
        last_seen_at: seenAt,
      }))
    if (current.length) {
      // dismissed_at and first_seen_at are left out of the payload on purpose,
      // so an upsert never un-ignores a name or resets when it first appeared.
      const { error: upErr } = await supabase.from('tutoring_calendar_candidates')
        .upsert(current, { onConflict: 'owner_id,title' })
      if (upErr) throw new Error(upErr.message)
    }

    const stillThere = new Set(current.map((c) => c.title))
    const stale = (existing ?? [])
      .filter((r: any) => !r.dismissed_at && !stillThere.has(r.title))
      .map((r: any) => r.id)
    for (let i = 0; i < stale.length; i += DELETE_CHUNK) {
      await supabase.from('tutoring_calendar_candidates').delete().in('id', stale.slice(i, i + DELETE_CHUNK))
    }
  } catch (e) {
    console.error('calendar candidates not recorded for', ownerId, (e as any)?.message ?? e)
  }
  return dismissed
}

/**
 * How many lessons this sync would have added if the account were not over
 * the free student limit: events that belong to a student but have no lesson
 * yet. "Lessons are paused" is abstract; "6 lessons in your calendar are
 * waiting" is about their own diary, and is the honest reason to upgrade.
 *
 * Existing keys are read by date range rather than by listing every event id
 * in the query string, which for a feed with long ids would outgrow a URL.
 */
async function countHeldBack_(ownerId: string, events: any[], matchers: Matcher[]): Promise<number> {
  const from = new Date(Date.now() - SYNC_WINDOW_DAYS_PAST * 86400000).toISOString().slice(0, 10)
  const wanted: string[] = []
  for (const item of events) {
    const local = eventLocal_(item)
    if (!local || local.date < from) continue
    const match = matchStudent_(item.summary || '(untitled)', matchers)
    if (match.studentId) wanted.push(item.id)
  }
  if (!wanted.length) return 0

  const { data, error } = await supabase.from('tutoring_lessons')
    .select('google_event_id')
    .eq('owner_id', ownerId)
    .gte('lesson_date', from)
    .not('google_event_id', 'is', null)
  if (error) throw new Error(error.message)
  const have = new Set((data ?? []).map((r: any) => r.google_event_id))
  return wanted.filter((k) => !have.has(k)).length
}

// Written only when it changes, so the two-hourly sync does not touch every
// tutor's billing row for nothing.
async function recordHeld_(ownerId: string, held: number) {
  try {
    let q = supabase.from('tutoring_subscriptions')
      .update({ held_lessons: held, held_checked_at: new Date().toISOString() })
      .eq('owner_id', ownerId)
    q = held > 0 ? q.neq('held_lessons', held) : q.gt('held_lessons', 0)
    await q
  } catch (e) {
    console.error('held lessons not recorded for', ownerId, (e as any)?.message ?? e)
  }
}

async function reconcileDeletions_(
  ownerId: string, seenKeys: Set<string>, startDate: Date, endDate: Date, fromFeed: boolean,
) {
  let q = supabase.from('tutoring_lessons')
    .select('id,google_event_id,lesson_date,bundle_id')
    .eq('owner_id', ownerId)
    .not('google_event_id', 'is', null)
    .gte('lesson_date', startDate.toISOString().slice(0, 10))
    .lte('lesson_date', endDate.toISOString().slice(0, 10))

  // Each source only ever reconciles its own lessons. A tutor running both a
  // Google calendar and a subscribed feed would otherwise have every feed
  // lesson look like an orphan to the Google pass, and be deleted by it.
  q = fromFeed
    ? q.like('google_event_id', `${FEED_KEY_PREFIX}%`)
    : q.not('google_event_id', 'like', `${FEED_KEY_PREFIX}%`)

  const { data: rows, error } = await q
  if (error) throw new Error('reconcile_fetch_failed: ' + error.message)

  const orphans = (rows ?? []).filter((r: any) => !seenKeys.has(r.google_event_id))
  if (orphans.length === 0) return 0

  // Money already attached to a lesson is a record of something that actually
  // happened. If its calendar event disappears the lesson is kept, not
  // deleted - deleting it would cascade the allocation away with it and
  // silently un-pay money the tutor has genuinely received.
  const paidLessonIds = new Set<string>()
  const orphanIds = orphans.map((r: any) => r.id)
  for (let i = 0; i < orphanIds.length; i += DELETE_CHUNK) {
    const { data: allocs } = await supabase.from('tutoring_payment_allocations')
      .select('lesson_id').in('lesson_id', orphanIds.slice(i, i + DELETE_CHUNK))
    for (const a of allocs ?? []) paidLessonIds.add(a.lesson_id)
  }

  const deletable = orphans.filter((r: any) => !r.bundle_id && !paidLessonIds.has(r.id))
  if (deletable.length === 0) return 0

  let deleted = 0
  for (let i = 0; i < deletable.length; i += DELETE_CHUNK) {
    const chunk = deletable.slice(i, i + DELETE_CHUNK)
    const { error: delErr } = await supabase.from('tutoring_lessons')
      .delete().in('id', chunk.map((r: any) => r.id))
    if (!delErr) deleted += chunk.length
  }
  return deleted
}

/**
 * Everything that happens once the events are in hand, which is the same
 * whether they came from Google's API or from a subscribed feed: work out who
 * each one belongs to, write the lessons, and decide what has genuinely been
 * deleted. Written once on purpose - the deletion rules below took three
 * separate bugs to get right and must not exist in two copies.
 */
async function runSync_(opts: {
  ownerId: string
  resetDate: string | null
  events: any[]
  statusTable: string
  fromFeed: boolean
  emptyNote: string
}) {
  const { ownerId, resetDate, events, statusTable, fromFeed } = opts
  const matchers = await fetchStudentMatchers_(ownerId)
  const studentsMatched = new Set(matchers.filter((m) => m.active).map((m) => m.studentId)).size

  // An account over the free student limit cannot take new lessons: a database
  // trigger refuses them, and this function's service key does not bypass it.
  // So every write below would be refused one at a time, each refusal swallowed,
  // and the sync would finish reporting a clean success having written precisely
  // nothing. Checked once, up front, so the tutor is told why their diary
  // stopped moving instead of quietly watching it go stale.
  const { data: canWrite } = await supabase.rpc('tutoring_can_write_account', { p_owner: ownerId })
  if (canWrite === false) {
    let held = 0
    try { held = await countHeldBack_(ownerId, events, matchers) } catch (e) {
      console.error('could not count held lessons for', ownerId, (e as any)?.message ?? e)
    }
    await recordHeld_(ownerId, held)
    const waiting = held > 0
      ? `${held} new lesson${held === 1 ? ' is' : 's are'} waiting in your calendar. `
      : ''
    await supabase.from(statusTable).update({
      last_synced_at: new Date().toISOString(),
      last_sync_error: `Your account is over the free student limit, so new lessons from your calendar are not being saved. ${waiting}Archive a student or start Pro, and the next sync will catch up on everything it missed. Recording payments still works in the meantime.`,
    }).eq('owner_id', ownerId)
    return {
      synced: 0, deleted: 0, locked: true, held_back: held,
      unmatched: 0, students_matched: studentsMatched, unmatched_titles: [],
    }
  }
  // Back under the limit or on Pro: nothing is being held any more.
  await recordHeld_(ownerId, 0)

  const now = new Date()
  const reconcileFrom = new Date(now.getTime() - SYNC_WINDOW_DAYS_PAST * 86400000)
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 86400000)

  // An empty read must never be treated as "every lesson was cancelled". A
  // calendar can come back empty for reasons that have nothing to do with the
  // diary being empty - renamed, unshared, a revoked scope, a transient fault
  // - and reconciling against that would delete every synced lesson in the
  // window in one pass. Keep what exists and record why nothing was done.
  if (events.length === 0) {
    await supabase.from(statusTable).update({
      last_synced_at: new Date().toISOString(),
      last_sync_error: opts.emptyNote,
    }).eq('owner_id', ownerId)
    return {
      synced: 0, deleted: 0, skipped_deletions: true,
      unmatched: 0, students_matched: studentsMatched, unmatched_titles: [],
    }
  }

  const seenKeys = new Set<string>()
  // Distinct unmatched event titles, with how many events carry each one -
  // surfaced to the frontend so a tutor can turn a recurring lesson nobody's
  // claimed yet straight into a student, instead of guessing calendar text
  // blind before ever connecting.
  const unmatchedTitles = new Map<string, number>()
  // The soonest upcoming date for each of those, so the home screen can say
  // "next on Tuesday" and the tutor recognises the lesson at a glance.
  const nextDateByTitle = new Map<string, string>()
  let synced = 0
  // Counted rather than ignored. A write can be refused for reasons this
  // function cannot see, and reporting success while silently dropping lessons
  // is the worst of the available behaviours.
  let failed = 0

  for (const item of events) {
    const start = eventStart_(item)
    const local = eventLocal_(item)
    if (!start || !local) continue
    const title = item.summary || '(untitled)'
    // Recorded for every event, including ignored and unmatched ones, so the
    // deletion pass only removes lessons whose event is genuinely gone rather
    // than ones that merely stopped matching a student.
    seenKeys.add(item.id)

    const match = matchStudent_(title, matchers)
    if (match.ignored) continue
    if (!match.studentId) {
      unmatchedTitles.set(title, (unmatchedTitles.get(title) || 0) + 1)
      if (start >= now) {
        const prev = nextDateByTitle.get(title)
        if (!prev || local.date < prev) nextDateByTitle.set(title, local.date)
      }
      continue
    }

    const ok = await upsertLesson_({
      student_id: match.studentId,
      owner_id: ownerId,
      lesson_date: local.date,
      status: start < now ? 'completed' : 'scheduled',
      google_event_id: item.id,
      lesson_notes: title,
      start_time: local.time,
      calendar_minutes: eventMinutes_(item),
      pre_settled: resetDate ? local.date < resetDate : false,
    })
    if (ok) synced++
    else failed++
  }

  // If lessons would not save, do not then go looking for lessons to remove.
  // Whatever is refusing the writes will refuse the deletes too, and a half
  // applied sync is a worse state to leave someone in than an untouched one.
  const deleted = failed > 0
    ? 0
    : await reconcileDeletions_(ownerId, seenKeys, reconcileFrom, endDate, fromFeed)

  await supabase.from(statusTable).update({
    last_synced_at: new Date().toISOString(),
    last_sync_error: failed > 0
      ? `${failed} lesson${failed === 1 ? '' : 's'} could not be saved, so nothing was changed or removed this time.`
      : null,
  }).eq('owner_id', ownerId)

  const dismissed = await recordCandidates_(ownerId, unmatchedTitles, nextDateByTitle)

  // Ignored once on the home screen means ignored here too.
  const unmatched_titles = Array.from(unmatchedTitles, ([title, count]) => ({ title, count }))
    .filter((u) => !dismissed.has(u.title.slice(0, CANDIDATE_TITLE_MAX)))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25)

  return { synced, deleted, failed, unmatched: unmatchedTitles.size, students_matched: studentsMatched, unmatched_titles }
}

/** A subscribed .ics feed: Apple's iCloud, Outlook, Fastmail and the rest. */
async function syncOneFeed_(row: any) {
  const now = new Date()
  const fetchFrom = new Date(now.getTime() - (SYNC_WINDOW_DAYS_PAST + 1) * 86400000)
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 86400000)
  // Imported here rather than at the top on purpose. This pulls in an iCalendar
  // parser from npm; if that ever fails to load, a static import would take the
  // whole function down with it and stop the Google sync too, which is the one
  // every existing tutor depends on. A feed problem stays a feed problem.
  const { fetchFeedEvents } = await import('./ics.ts')
  const events = await fetchFeedEvents(row.url, fetchFrom, endDate)
  return runSync_({
    ownerId: row.owner_id,
    resetDate: row.reset_date ?? null,
    events,
    statusTable: 'tutoring_calendar_feeds',
    fromFeed: true,
    emptyNote: 'Your calendar link returned no lessons, so existing ones were kept rather than deleted. If the calendar really is empty this is harmless; otherwise check it is still shared.',
  })
}

async function syncOneTutor_(row: any) {
  const token = await getAccessToken_(row)
  const now = new Date()

  // Two windows, deliberately different sizes.
  //
  // Deletion compares stored lessons against the events that came back, so
  // anything it is allowed to delete MUST have been inside the fetch. Google
  // filters by an exact instant, while a lesson only stores a date - so a
  // fetch starting "7 days ago at 12:17" misses an 11:00 lesson on that day,
  // while the date-based deletion query still counts it as a candidate and
  // removes a lesson whose event is alive and well. That quietly deleted every
  // lesson about a week after it happened, taking its payment history with it.
  //
  // Fetching a day wider than the deletion window closes the gap.
  const fetchFrom = new Date(now.getTime() - (SYNC_WINDOW_DAYS_PAST + 1) * 86400000)
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 86400000)

  const events = await fetchEvents_(token, row.calendar_id, fetchFrom, endDate)

  return runSync_({
    ownerId: row.owner_id,
    resetDate: row.reset_date ?? null,
    events,
    statusTable: 'tutoring_google_calendar_auth',
    fromFeed: false,
    emptyNote: 'Your calendar returned no events, so existing lessons were kept rather than deleted. If your calendar really is empty this is harmless; otherwise try reconnecting it.',
  })
}

Deno.serve(async (req) => {
  const json = (b: any, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const authHeader = req.headers.get('Authorization') ?? ''
  const bearer = authHeader.replace(/^Bearer /i, '')

  // null = sync every connected tutor (a scheduled run); otherwise the single
  // owner making the request.
  let ownerFilter: string | null = null
  let scheduled = false

  if (bearer && bearer === SUPABASE_SERVICE_ROLE_KEY) {
    // The platform's own master key. Nothing further to check.
    scheduled = true
  } else if (bearer) {
    // The pg_cron scheduler cannot hold the service_role key - it runs inside
    // Postgres, which has no access to Edge Function environment variables -
    // so it presents a shared secret generated in-database instead, and
    // Postgres confirms it here. The secret itself never travels back to this
    // function; verify_cron_secret only answers yes or no.
    const { data: isCron } = await supabase.rpc('verify_cron_secret', { candidate: bearer })
    if (isCron === true) {
      scheduled = true
    } else {
      // Otherwise it must be a real user's own session, syncing only
      // themselves - this is what the app's "Sync now" button calls. Looping
      // every tutor for an ordinary user request would let one tutor force a
      // full-project sync (and burn everyone else's Google API quota) just by
      // hitting this endpoint from their browser.
      const { data, error } = await supabase.auth.getUser(bearer)
      if (error || !data.user) return json({ ok: false, problem: 'unauthorized' }, 401)
      ownerFilter = data.user.id
    }
  } else {
    return json({ ok: false, problem: 'unauthorized' }, 401)
  }

  let q = supabase.from('tutoring_google_calendar_auth').select('*').not('calendar_id', 'is', null)
  if (ownerFilter) q = q.eq('owner_id', ownerFilter)
  const { data: rows, error: rowsErr } = await q
  if (rowsErr) return json({ ok: false, problem: 'fetch_failed', detail: rowsErr.message })

  let fq = supabase.from('tutoring_calendar_feeds').select('*')
  if (ownerFilter) fq = fq.eq('owner_id', ownerFilter)
  const { data: feedRows } = await fq

  const results: any[] = []
  for (const row of rows ?? []) {
    try {
      const r = await syncOneTutor_(row)
      results.push({ owner_id: row.owner_id, source: 'google', ok: true, ...r })
    } catch (e) {
      results.push({ owner_id: row.owner_id, source: 'google', ok: false, problem: String(e) })
      await supabase.from('tutoring_google_calendar_auth')
        .update({ last_sync_error: String(e).slice(0, 500) })
        .eq('owner_id', row.owner_id)
    }
  }

  // One diary per tutor, never two. The same lesson coming from both a Google
  // calendar and a subscribed link arrives under two different keys, so the
  // app would show every lesson twice and neither copy would look wrong. If
  // both are set up, Google wins and the link is left dormant rather than
  // writing a duplicate of everything.
  const googleOwners = new Set((rows ?? []).map((r: any) => r.owner_id))

  for (const row of feedRows ?? []) {
    if (googleOwners.has(row.owner_id)) {
      await supabase.from('tutoring_calendar_feeds').update({
        last_sync_error: 'Not being used, because Google Calendar is connected and takes precedence. Disconnect Google if you would rather TutorTally read this link instead.',
      }).eq('owner_id', row.owner_id)
      results.push({ owner_id: row.owner_id, source: 'feed', ok: true, skipped_for_google: true, synced: 0, deleted: 0 })
      continue
    }
    try {
      const r = await syncOneFeed_(row)
      results.push({ owner_id: row.owner_id, source: 'feed', ok: true, ...r })
    } catch (e) {
      results.push({ owner_id: row.owner_id, source: 'feed', ok: false, problem: String(e) })
      await supabase.from('tutoring_calendar_feeds')
        .update({ last_sync_error: String(e).slice(0, 500) })
        .eq('owner_id', row.owner_id)
    }
  }

  return json({ ok: true, scheduled, tutors_synced: results.length, results })
})
