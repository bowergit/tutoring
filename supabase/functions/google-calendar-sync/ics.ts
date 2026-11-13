// deno-lint-ignore-file no-explicit-any
//
// Reading a published calendar feed.
//
// Tutors who keep their diary on an iPhone have no Google account to connect.
// Apple's own API is CalDAV, which needs an Apple ID and a hand-generated
// app-specific password: a credential we would have to store, and six screens
// of instructions for someone who is not technical. Every calendar app,
// Apple's included, will instead publish a read-only .ics feed at a long
// unguessable URL. Nothing to authorise, nothing to store but a link, and it
// cannot be used to change anything.
//
// This turns such a feed into the same shape the Google path already produces,
// so everything downstream - matching titles to students, writing lessons,
// deciding what has been deleted - is shared rather than written twice.
import ICAL from 'npm:ical.js@2.1.0'

// A published diary is a few hundred kilobytes at most. The cap is here
// because the URL is supplied by a user and fetched by our server.
const MAX_FEED_BYTES = 8 * 1024 * 1024
// A malformed or hostile RRULE can iterate for ever, so each series gets its
// own step cap. Deliberately per-series rather than shared: a single weekly
// lesson running since 2015 would otherwise consume a shared budget walking
// through years of history, and every student after it in the file would
// quietly produce no lessons at all - with no error, because nothing failed.
const MAX_STEPS_PER_SERIES = 5000
// What actually costs anything: occurrences kept and written.
const MAX_OCCURRENCES = 5000
const DEFAULT_TZID = 'Europe/London'

export interface FeedEvent {
  id: string
  summary: string
  start: { dateTime?: string; date?: string }
  instant: Date
  // How long it runs, in minutes, when it has both a start and an end time.
  minutes: number | null
}

/**
 * Only public https, and never anything that could be pointed back at our own
 * infrastructure.
 *
 * The server fetches whatever address a tutor pastes in, so without this the
 * feed box is a request forgery hole: a link to a private range or a cloud
 * metadata endpoint would be fetched with our credentials and our network
 * position. webcal:// is the scheme calendar apps hand out and is plain https
 * underneath.
 */
export function normaliseFeedUrl(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed) throw new Error('feed_url_empty')

  const withScheme = trimmed.replace(/^webcal:\/\//i, 'https://')
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    throw new Error('feed_url_invalid')
  }

  if (u.protocol !== 'https:') throw new Error('feed_url_not_https')

  const host = u.hostname.toLowerCase()
  // Bare IP addresses are never how a calendar service publishes a feed, and
  // are how someone would reach a private host.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) throw new Error('feed_url_ip_not_allowed')
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('feed_url_private_host')
  }

  return u.toString()
}

/** A wall-clock reading in the tutor's own timezone, never in UTC. */
function wallClock(instant: Date, tzid: string): { date: string; time: string } {
  // Intl does the DST arithmetic, which is the part that has bitten this app
  // before: going through toISOString expresses the moment in UTC and moves
  // every British Summer Time lesson an hour earlier.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzid,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // Midnight comes back as "24" from some engines.
    time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`,
  }
}

/** Minutes between two timed ICAL values, or null for all-day or missing ends. */
function lengthMinutes(startTime: any, endTime: any): number | null {
  if (!startTime || !endTime || startTime.isDate || endTime.isDate) return null
  try {
    const m = Math.round((endTime.toJSDate().getTime() - startTime.toJSDate().getTime()) / 60000)
    return Number.isFinite(m) ? m : null
  } catch {
    return null
  }
}

function toFeedEvent(uid: string, summary: string, startTime: any, key: string, tzid: string, endTime: any = null): FeedEvent | null {
  if (!startTime) return null

  // An all-day event carries a bare date and no time at all.
  if (startTime.isDate) {
    const iso = startTime.toString().slice(0, 10)
    return { id: key, summary, start: { date: iso }, instant: new Date(iso + 'T00:00:00Z'), minutes: null }
  }

  const minutes = lengthMinutes(startTime, endTime)
  const zone = startTime.zone
  const floating = zone === ICAL.Timezone.localTimezone
  if (floating) {
    // No zone attached, so the written time IS the wall clock and must be
    // taken as-is rather than reinterpreted against the server's clock, which
    // in Deno is UTC.
    const s = startTime.toString()
    const date = s.slice(0, 10)
    const time = s.slice(11, 16)
    return { id: key, summary, start: { dateTime: `${date}T${time}:00` }, instant: new Date(`${date}T${time}:00Z`), minutes }
  }

  const instant = startTime.toJSDate()
  const local = wallClock(instant, tzid)
  return { id: key, summary, start: { dateTime: `${local.date}T${local.time}:00` }, instant, minutes }
}

/**
 * Every occurrence in the window, with repeats expanded.
 *
 * Google's API is asked for singleEvents and hands back each occurrence
 * already worked out. A raw feed does not: a weekly lesson arrives as one
 * entry plus a rule, which is exactly the shape almost every tutoring diary
 * takes, so the rule has to be expanded here or nothing recurring is ever seen.
 */
export async function fetchFeedEvents(url: string, from: Date, to: Date): Promise<FeedEvent[]> {
  const safe = normaliseFeedUrl(url)

  const res = await fetch(safe, {
    headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.8' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`feed_fetch_failed_${res.status}`)

  const size = Number(res.headers.get('content-length') || 0)
  if (size > MAX_FEED_BYTES) throw new Error('feed_too_large')
  const text = await res.text()
  if (text.length > MAX_FEED_BYTES) throw new Error('feed_too_large')
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('feed_not_a_calendar')

  const comp = new ICAL.Component(ICAL.parse(text))

  // The feed's own timezone definitions, so a time written against
  // Europe/London is read as Europe/London and not as UTC.
  for (const vtz of comp.getAllSubcomponents('vtimezone')) {
    try {
      const tz = new ICAL.Timezone(vtz)
      if (tz.tzid && !ICAL.TimezoneService.has(tz.tzid)) ICAL.TimezoneService.register(tz.tzid, tz)
    } catch { /* a broken VTIMEZONE must not take the whole feed down */ }
  }

  const tzid = String(comp.getFirstPropertyValue('x-wr-timezone') || DEFAULT_TZID)

  const masters = new Map<string, any>()
  const overrides: any[] = []
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    let ev: any
    try { ev = new ICAL.Event(vevent) } catch { continue }
    if (ev.isRecurrenceException()) overrides.push(ev)
    else if (ev.uid) masters.set(ev.uid, ev)
  }
  // A single moved or amended instance of a series.
  for (const ex of overrides) {
    const master = ex.uid ? masters.get(ex.uid) : null
    if (master) {
      try { master.relateException(ex) } catch { /* ignore a mismatched override */ }
    } else {
      masters.set(`${ex.uid}:${ex.recurrenceId?.toString() ?? ''}`, ex)
    }
  }

  const out: FeedEvent[] = []
  let emitted = 0

  for (const ev of masters.values()) {
    if (emitted >= MAX_OCCURRENCES) break
    const summary = String(ev.summary || '(untitled)')
    const uid = String(ev.uid || 'no-uid')

    if (!ev.isRecurring()) {
      let end: any = null
      try { end = ev.endDate } catch { /* no end time */ }
      const e = toFeedEvent(uid, summary, ev.startDate, `ics:${uid}`, tzid, end)
      if (e && e.instant >= from && e.instant <= to) { out.push(e); emitted++ }
      continue
    }

    // A series that finished before the window opened cannot contribute a
    // single lesson, and stepping through it week by week to discover that is
    // pure waste. A real tutoring calendar is mostly this: years of finished
    // students. One test feed spent 2005 of its 2141 steps walking through
    // 2022-2024 to reach the one lesson that was actually coming up.
    let until: any = null
    try { until = (ev.component?.getFirstPropertyValue('rrule') as any)?.until ?? null } catch { /* not fatal */ }
    if (until) {
      try { if (until.toJSDate() < from) continue } catch { /* keep the series */ }
    }

    let iterator: any
    try { iterator = ev.iterator() } catch { continue }
    let next: any
    let steps = MAX_STEPS_PER_SERIES
    while ((next = iterator.next())) {
      if (steps-- <= 0) break
      const when = next.toJSDate()
      if (when > to) break
      if (when < from) continue
      let occ: any
      try { occ = ev.getOccurrenceDetails(next) } catch { continue }
      // Keyed on which occurrence it is, not on when it currently sits, so
      // dragging one lesson to a new time updates that lesson rather than
      // deleting it and creating a stranger.
      const key = `ics:${uid}:${occ.recurrenceId?.toString() ?? next.toString()}`
      const e = toFeedEvent(uid, String(occ.item?.summary || summary), occ.startDate, key, tzid, occ.endDate)
      if (e) {
        out.push(e)
        if (++emitted >= MAX_OCCURRENCES) break
      }
    }
  }

  return out
}
