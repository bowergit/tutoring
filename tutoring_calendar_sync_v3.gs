/**
 * Tutoring Calendar → Supabase sync (v3.1)
 *
 * Reads events from the "Tutoring" Google Calendar and inserts/updates
 * matching rows in tutoring_lessons. Student matching patterns are pulled
 * live from tutoring_students.calendar_title_pattern, so new students added
 * via the frontend are picked up automatically without editing this script.
 *
 * NEW IN v3:
 *  - Deletes lessons whose calendar event has been removed (v2 never did this,
 *    so deleted events left orphaned rows behind forever).
 *  - Marks lessons before RESET_DATE as pre_settled, so re-synced history
 *    never reappears as money owing.
 *  - Past window cut to 7 days. A nightly trigger only ever needs to look
 *    back a day or two, and a short window means lessons you deliberately
 *    deleted from the database don't get resurrected from old calendar events.
 *
 * NEW IN v3.1:
 *  - Recurring events are now stored as one row per occurrence. Apps Script's
 *    getId() returns the iCalUID, which Google shares across every occurrence
 *    of a series, so a weekly lesson would otherwise collapse into a single
 *    row. Occurrences of a recurring event get the start time appended to make
 *    the key unique. Non-recurring events keep their plain id, so existing
 *    rows are untouched.
 *  - Fixed the deletion request: UUIDs were wrapped in double quotes, which
 *    are not legal in a URL, so UrlFetchApp rejected it as an invalid
 *    argument. Deletions are also chunked to keep URLs a sane length.
 *
 * SETUP (unchanged):
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
  const options = {
    method: 'get',
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true
  };
  const response = UrlFetchApp.fetch(url, options);
  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to fetch student matchers: ' + response.getContentText());
  }
  const students = JSON.parse(response.getContentText());
  return students.map(s => ({
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
 * Builds the key stored in tutoring_lessons.google_event_id.
 *
 * getId() returns the iCalUID, and Google gives every occurrence of a
 * recurring series the SAME iCalUID — so using it alone would make all
 * occurrences of a weekly lesson upsert over each other, leaving one row.
 * Appending the start time gives each occurrence its own row. Two separate
 * events on the same day are unaffected either way, since they already have
 * different ids.
 */
function lessonKey_(event) {
  const id = event.getId();
  if (!event.isRecurringEvent()) return id;
  const stamp = Utilities.formatDate(
    event.getStartTime(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm");
  return id + '::' + stamp;
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
  const calendar = calendars[0];

  const now = new Date();
  const startDate = new Date(now.getTime() - SYNC_WINDOW_DAYS_PAST * 24 * 60 * 60 * 1000);
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 24 * 60 * 60 * 1000);

  const events = calendar.getEvents(startDate, endDate);
  const unmatched = [];
  const seenKeys = {};
  let inserted = 0;
  let skipped = 0;

  events.forEach(event => {
    const title = event.getTitle();
    const key = lessonKey_(event);

    // Record EVERY event in the window, including ignored and unmatched ones.
    // Deletion below only removes rows whose event is genuinely gone from the
    // calendar — never rows that merely stopped matching a student pattern.
    seenKeys[key] = true;

    const match = matchStudentId_(title, matchers);

    if (match.ignored) return;
    if (match.studentId === null) {
      unmatched.push(title + ' | ' + event.getStartTime());
      return;
    }

    const lessonDate = Utilities.formatDate(event.getStartTime(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const startTime = Utilities.formatDate(event.getStartTime(), Session.getScriptTimeZone(), 'HH:mm');
    const status = event.getStartTime() < now ? 'completed' : 'scheduled';

    const success = upsertLesson_(config, match.studentId, lessonDate, status, key, title, startTime);
    if (success) inserted++; else skipped++;
  });

  const removed = reconcileDeletions_(config, seenKeys, startDate, endDate);

  Logger.log('Synced: ' + inserted + ' | Failed: ' + skipped +
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

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: Object.assign({}, supabaseHeaders_(config), {
      'Prefer': 'resolution=merge-duplicates'
    }),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;

  Logger.log('Failed to upsert lesson for ' + title + ': ' + response.getContentText());
  return false;
}

/**
 * Removes lessons inside the sync window whose calendar event no longer
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
