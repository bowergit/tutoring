/**
 * Tutoring Calendar → Supabase sync (v4 — Advanced Calendar Service)
 *
 * Reads events from the "Tutoring" Google Calendar and inserts/updates
 * matching rows in tutoring_lessons. Student matching patterns are pulled
 * live from tutoring_students.calendar_title_pattern, so new students added
 * via the frontend are picked up automatically without editing this script.
 *
 * ── EXTRA SETUP REQUIRED FOR v4 ──────────────────────────────────────────
 * In the Apps Script editor: click "Services" (＋ icon, left sidebar),
 * choose "Google Calendar API", leave the identifier as "Calendar", Add.
 * Then run syncTutoringCalendar once manually and approve the permission
 * prompt. Without this, Calendar.Events.list is undefined and the script
 * throws immediately.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY v4 EXISTS
 * v3 identified lessons by CalendarApp's getId(), which returns the iCalUID.
 * Google gives every occurrence of a recurring series the same iCalUID, so v3
 * had to append the start time to tell occurrences apart. That worked until an
 * occurrence was moved: the key changed, so the sync deleted the old row and
 * inserted a new one. Harmless for an untouched lesson, but destructive when a
 * payment was attached — reconciliation refuses to delete a paid lesson, so
 * the old row survived alongside the new one and the lesson was counted twice.
 *
 * The Advanced Calendar Service returns a genuine per-occurrence id, built
 * from the occurrence's ORIGINAL start time. Moving a lesson therefore leaves
 * its id untouched, so the row is updated in place: no duplicates, and
 * anything set by hand on that lesson (a "free" mark, a linked payment)
 * survives being rescheduled.
 *
 * NOTE ON UPGRADING: these ids differ from the iCalUIDs v2/v3 stored, so on
 * the first run every lesson inside the sync window is re-keyed — the old row
 * is deleted and a fresh one inserted. Do this while no lessons have payments
 * linked or "free" marks set, otherwise the re-key causes exactly the
 * duplication it is meant to prevent.
 *
 * SETUP (unchanged from v2/v3):
 * 1. Script Properties: SUPABASE_URL, SUPABASE_SERVICE_KEY (use the
 *    service_role legacy JWT key, NOT the new sb_secret_ key — Apps Script's
 *    UrlFetchApp gets blocked by Supabase's browser-detection on new keys).
 * 2. Time-driven trigger on syncTutoringCalendar, nightly.
 */

const CALENDAR_NAME = 'Tutoring';
const SYNC_WINDOW_DAYS_PAST = 7;
const SYNC_WINDOW_DAYS_FUTURE = 90;

// Everything before this date is declared already paid for. The tutoring app
// excludes pre_settled lessons from outstanding balances.
const RESET_DATE = '2026-07-27';

// How many ids to put in a single delete request.
const DELETE_CHUNK_SIZE = 50;

// Titles to explicitly ignore (not lessons) — kept in code since these are
// structural, not student-specific. Add more if you spot other non-lesson
// entries in the calendar.
const IGNORE_PATTERNS = [
  /^cash /i,
  /^maths paper/i,
  /^magic lesson/i,
  /^call /i,
  /^tutoring call/i,
];

function getSupabaseConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: props.getProperty('SUPABASE_URL'),
    key: props.getProperty('SUPABASE_SERVICE_KEY')
  };
}

function supabaseHeaders_(config) {
  return {
    'apikey': config.key,
    'Authorization': 'Bearer ' + config.key
  };
}

function fetchStudentMatchers_(config) {
  const url = config.url + '/rest/v1/tutoring_students?select=id,name,calendar_title_pattern&active=eq.true&calendar_title_pattern=not.is.null';
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to fetch student matchers: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText()).map(s => ({
    studentId: s.id,
    name: s.name,
    regex: new RegExp(s.calendar_title_pattern, 'i')
  }));
}

function matchStudentId_(title, matchers) {
  for (const ignore of IGNORE_PATTERNS) {
    if (ignore.test(title)) return { studentId: null, ignored: true };
  }
  for (const matcher of matchers) {
    if (matcher.regex.test(title)) return { studentId: matcher.studentId, ignored: false };
  }
  return { studentId: null, ignored: false };
}

/**
 * Pulls every occurrence in the window, expanding recurring series into
 * individual instances. Paginates, because a busy term can exceed one page.
 */
function fetchOccurrences_(calendarId, timeMin, timeMax) {
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    throw new Error(
      'The Google Calendar API advanced service is not enabled. In the Apps ' +
      'Script editor: Services (＋) → Google Calendar API → Add, keeping the ' +
      'identifier "Calendar".');
  }

  const items = [];
  let pageToken = null;
  do {
    const resp = Calendar.Events.list(calendarId, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,   // expand recurring series into one entry per occurrence
      maxResults: 2500,
      pageToken: pageToken || undefined
    });
    (resp.items || []).forEach(item => items.push(item));
    pageToken = resp.nextPageToken;
  } while (pageToken);

  // Deleted occurrences of a series can still surface; never treat them as lessons.
  return items.filter(item => item.status !== 'cancelled');
}

/** All-day events have start.date; timed ones have start.dateTime. */
function occurrenceStart_(item) {
  if (item.start && item.start.dateTime) return new Date(item.start.dateTime);
  if (item.start && item.start.date) return new Date(item.start.date + 'T00:00:00');
  return null;
}

function syncTutoringCalendar() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY script properties.');
  }

  const matchers = fetchStudentMatchers_(config);
  Logger.log('Loaded ' + matchers.length + ' student matchers from Supabase.');

  const calendars = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (calendars.length === 0) {
    throw new Error('No calendar found named "' + CALENDAR_NAME + '"');
  }
  const calendarId = calendars[0].getId();

  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const startDate = new Date(now.getTime() - SYNC_WINDOW_DAYS_PAST * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 24 * 60 * 60 * 1000);

  const occurrences = fetchOccurrences_(calendarId, startDate, endDate);

  const unmatched = [];
  const seenKeys = {};
  let synced = 0;
  let failed = 0;

  occurrences.forEach(item => {
    const start = occurrenceStart_(item);
    if (!start) return;

    const title = item.summary || '(untitled)';

    // Record EVERY occurrence in the window, including ignored and unmatched
    // ones. Deletion below only removes rows whose occurrence is genuinely
    // gone from the calendar — never rows that merely stopped matching a
    // student pattern.
    seenKeys[item.id] = true;

    const match = matchStudentId_(title, matchers);
    if (match.ignored) return;
    if (match.studentId === null) {
      unmatched.push(title + ' | ' + start);
      return;
    }

    const lessonDate = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    const isAllDay = !(item.start && item.start.dateTime);
    const startTime = isAllDay ? null : Utilities.formatDate(start, tz, 'HH:mm');
    const status = start < now ? 'completed' : 'scheduled';

    const ok = upsertLesson_(config, match.studentId, lessonDate, status, item.id, title, startTime);
    if (ok) synced++; else failed++;
  });

  const removed = reconcileDeletions_(config, seenKeys, startDate, endDate);

  Logger.log('Synced: ' + synced + ' | Failed: ' + failed +
             ' | Deleted (event gone): ' + removed +
             ' | Unmatched: ' + unmatched.length);
  if (unmatched.length > 0) {
    Logger.log('Unmatched events (add a calendar_title_pattern for these students, or add IGNORE_PATTERNS):\n' + unmatched.join('\n'));
  }
}

function upsertLesson_(config, studentId, lessonDate, status, eventKey, title, startTime) {
  const url = config.url + '/rest/v1/tutoring_lessons?on_conflict=google_event_id';
  const payload = {
    student_id: studentId,
    lesson_date: lessonDate,
    status: status,
    google_event_id: eventKey,
    lesson_notes: title,
    start_time: startTime,
    // Anything taught before the reset date is already paid for, so it must
    // never come back as an outstanding balance.
    pre_settled: lessonDate < RESET_DATE
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: Object.assign({}, supabaseHeaders_(config), {
      'Prefer': 'resolution=merge-duplicates'
    }),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;

  Logger.log('Failed to upsert lesson for ' + title + ': ' + response.getContentText());
  return false;
}

/**
 * Removes lessons inside the sync window whose calendar occurrence no longer
 * exists. Only touches rows that came from the calendar (google_event_id set),
 * so lessons added by hand in the app are never affected.
 */
function reconcileDeletions_(config, seenKeys, startDate, endDate) {
  const tz = Session.getScriptTimeZone();
  const fromStr = Utilities.formatDate(startDate, tz, 'yyyy-MM-dd');
  const toStr = Utilities.formatDate(endDate, tz, 'yyyy-MM-dd');

  const url = config.url + '/rest/v1/tutoring_lessons'
    + '?select=id,google_event_id,lesson_date,bundle_id,lesson_notes'
    + '&google_event_id=not.is.null'
    + '&lesson_date=gte.' + fromStr
    + '&lesson_date=lte.' + toStr;

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log('Could not load lessons for deletion check: ' + response.getContentText());
    return 0;
  }

  const rows = JSON.parse(response.getContentText());
  const orphans = rows.filter(r => !seenKeys[r.google_event_id]);
  if (orphans.length === 0) return 0;

  // A lesson attached to a payment is never silently binned — deleting it
  // would leave the payment covering nothing.
  const deletable = orphans.filter(r => !r.bundle_id);
  orphans.filter(r => r.bundle_id).forEach(r => {
    Logger.log('KEPT (calendar event gone, but a payment is linked to it): ' +
               r.lesson_date + ' — ' + r.lesson_notes);
  });

  if (deletable.length === 0) return 0;

  let deleted = 0;
  for (let i = 0; i < deletable.length; i += DELETE_CHUNK_SIZE) {
    const chunk = deletable.slice(i, i + DELETE_CHUNK_SIZE);
    // No quotes around the UUIDs: quotes are not valid URL characters and
    // UrlFetchApp rejects the whole request as an invalid argument.
    const idList = chunk.map(r => r.id).join(',');

    const delRes = UrlFetchApp.fetch(
      config.url + '/rest/v1/tutoring_lessons?id=in.(' + idList + ')',
      {
        method: 'delete',
        headers: supabaseHeaders_(config),
        muteHttpExceptions: true
      }
    );

    if (delRes.getResponseCode() >= 300) {
      Logger.log('Deletion failed: ' + delRes.getContentText());
      continue;
    }

    chunk.forEach(r => {
      Logger.log('DELETED (removed from calendar): ' + r.lesson_date + ' — ' + r.lesson_notes);
    });
    deleted += chunk.length;
  }

  return deleted;
}
