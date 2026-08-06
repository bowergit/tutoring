/**
 * Tutoring sync — Google Calendar + past-paper sheets → Supabase
 * Multi-tenant: each tutor's calendar syncs only into their own account.
 *
 * SETUP (once, on Daniel's Apps Script project — this script only ever runs
 * as Daniel; no other tutor logs into Google Apps Script or handles the
 * Supabase key)
 * 1. Script Properties: SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *    Use the service_role legacy JWT key, not the sb_secret_ one — UrlFetchApp
 *    gets blocked by Supabase's browser detection on the new keys.
 * 2. Services (＋) → Google Calendar API → Add, identifier "Calendar".
 * 3. One daily time-driven trigger on syncTutoring.
 *
 * ADDING ANOTHER TUTOR — see DJAVHAN_SETUP.md for the full instructions to
 * send them. Short version:
 * 1. They create a lessons calendar in their OWN Google account, named
 *    something no one else's calendar shares (e.g. "Djavhan Lessons" —
 *    NOT "Tutoring"). getCalendarsByName only ever uses the first match, so
 *    two calendars with the same name silently collide.
 * 2. They share it with Daniel's Google account (Settings and sharing →
 *    Share with specific people → "See all event details" is enough).
 * 3. Daniel opens Google Calendar, finds it under "Other calendars", and
 *    clicks it once to subscribe — sharing alone doesn't make it visible to
 *    getCalendarsByName, only actually adding it does.
 * 4. Once their Supabase account exists (Authentication → Users), copy their
 *    user id and add a row to ACCOUNTS below.
 */

const ACCOUNTS = [
  {
    label: 'Daniel',
    calendarName: 'Tutoring',
    ownerId: 'babb06b5-b5e0-4436-8b72-bc5556814956',
    // Everything before this date was already settled in the 27 Jul 2026
    // clean-slate reset and must never re-appear as owing. A new tutor has
    // had no such reset, so their entry should keep resetDate in the past —
    // see the ACCOUNTS entry template below.
    resetDate: '2026-07-27',
  },
  // Uncomment and fill in once Djavhan's Supabase account exists.
  // resetDate stays in the past (nothing of his should ever read as
  // pre-settled) — do NOT copy Daniel's 2026-07-27, that would wipe out
  // his real balances the moment his lessons start syncing.
  // {
  //   label: 'Djavhan',
  //   calendarName: 'Djavhan Lessons',
  //   ownerId: 'PASTE-HIS-SUPABASE-USER-ID-HERE',
  //   resetDate: '2000-01-01',
  // },
];

const SYNC_WINDOW_DAYS_PAST = 7;
const SYNC_WINDOW_DAYS_FUTURE = 90;

const DELETE_CHUNK_SIZE = 50;
const PAPER_HEADER_PATTERN = /date\s*taken/i;

const IGNORE_PATTERNS = [
  /^cash /i,
  /^maths paper/i,
  /^magic lesson/i,
  /^call /i,
  /^tutoring call/i,
];

/**
 * Kept so a trigger still pointing at the old name keeps working. Without it
 * an un-updated trigger fails nightly with "function not found", and nothing
 * surfaces that — lessons just quietly stop appearing.
 */
function syncTutoringCalendar() {
  syncTutoring();
}

/** The only function the trigger needs to call. Runs every account in turn. */
function syncTutoring() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY script properties.');
  }

  ACCOUNTS.forEach(account => {
    // One account's missing calendar or broken sheet must not take the rest
    // down with it — each is independent.
    try {
      syncCalendar_(config, account);
    } catch (err) {
      Logger.log('[' + account.label + '] Calendar sync failed: ' + err);
    }
    try {
      syncPastPapers_(config, account);
    } catch (err) {
      Logger.log('[' + account.label + '] Past paper sync failed: ' + err);
    }
  });
}

// ─── Shared ──────────────────────────────────────────────────────────────

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

// ─── Calendar ────────────────────────────────────────────────────────────

function syncCalendar_(config, account) {
  const matchers = fetchStudentMatchers_(config, account.ownerId);
  Logger.log('[' + account.label + '] Loaded ' + matchers.length + ' student matchers.');

  const calendars = CalendarApp.getCalendarsByName(account.calendarName);
  if (calendars.length === 0) {
    throw new Error('No calendar found named "' + account.calendarName + '"');
  }

  const tz = Session.getScriptTimeZone();
  const now = new Date();
  const startDate = new Date(now.getTime() - SYNC_WINDOW_DAYS_PAST * 86400000);
  const endDate = new Date(now.getTime() + SYNC_WINDOW_DAYS_FUTURE * 86400000);

  const occurrences = fetchOccurrences_(calendars[0].getId(), startDate, endDate);

  const unmatched = [];
  const seenKeys = {};
  let synced = 0;
  let failed = 0;

  occurrences.forEach(item => {
    const start = occurrenceStart_(item);
    if (!start) return;

    const title = item.summary || '(untitled)';

    // Record every occurrence, including ignored and unmatched ones, so the
    // deletion pass only removes rows whose event is genuinely gone — not
    // rows that merely stopped matching a student pattern.
    seenKeys[item.id] = true;

    const match = matchStudentId_(title, matchers);
    if (match.ignored) return;
    if (match.studentId === null) {
      unmatched.push(title + ' | ' + start);
      return;
    }

    const isAllDay = !(item.start && item.start.dateTime);
    const ok = upsertLesson_(config, {
      studentId: match.studentId,
      ownerId: account.ownerId,
      resetDate: account.resetDate,
      lessonDate: Utilities.formatDate(start, tz, 'yyyy-MM-dd'),
      startTime: isAllDay ? null : Utilities.formatDate(start, tz, 'HH:mm'),
      status: start < now ? 'completed' : 'scheduled',
      eventKey: item.id,
      title: title
    });
    if (ok) synced++; else failed++;
  });

  const removed = reconcileDeletions_(config, seenKeys, startDate, endDate, account.ownerId);

  Logger.log('[' + account.label + '] Lessons — synced: ' + synced + ' | failed: ' + failed +
             ' | deleted: ' + removed + ' | unmatched: ' + unmatched.length);
  if (unmatched.length > 0) {
    Logger.log('[' + account.label + '] Unmatched events:\n' + unmatched.join('\n'));
  }
}

/**
 * Scoped to one tutor's own students. Without this filter, one tutor's
 * calendar could match against another tutor's student — the sync runs on
 * the service key, which bypasses the app's normal per-account isolation, so
 * this filter is the only thing enforcing it here.
 */
function fetchStudentMatchers_(config, ownerId) {
  const url = config.url + '/rest/v1/tutoring_students' +
    '?select=id,name,calendar_title_pattern' +
    '&active=eq.true&calendar_title_pattern=not.is.null' +
    '&owner_id=eq.' + ownerId;
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
 * Every occurrence in the window, recurring series expanded. Uses the advanced
 * service because CalendarApp's getId() returns the iCalUID, which is shared
 * by every occurrence of a series — these ids are per-occurrence and survive
 * an occurrence being moved.
 */
function fetchOccurrences_(calendarId, timeMin, timeMax) {
  if (typeof Calendar === 'undefined' || !Calendar.Events) {
    throw new Error('Google Calendar API advanced service not enabled: ' +
      'Services (＋) → Google Calendar API → Add, identifier "Calendar".');
  }

  const items = [];
  let pageToken = null;
  do {
    const resp = Calendar.Events.list(calendarId, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      maxResults: 2500,
      pageToken: pageToken || undefined
    });
    (resp.items || []).forEach(item => items.push(item));
    pageToken = resp.nextPageToken;
  } while (pageToken);

  return items.filter(item => item.status !== 'cancelled');
}

function occurrenceStart_(item) {
  if (item.start && item.start.dateTime) return new Date(item.start.dateTime);
  if (item.start && item.start.date) return new Date(item.start.date + 'T00:00:00');
  return null;
}

function upsertLesson_(config, l) {
  const response = UrlFetchApp.fetch(
    config.url + '/rest/v1/tutoring_lessons?on_conflict=google_event_id',
    {
      method: 'post',
      contentType: 'application/json',
      headers: Object.assign({}, supabaseHeaders_(config), {
        'Prefer': 'resolution=merge-duplicates'
      }),
      payload: JSON.stringify({
        student_id: l.studentId,
        // Set explicitly, not left to the column default: this runs on the
        // service key, which bypasses the RLS check that would normally
        // catch a missing owner_id. Omitting it wouldn't error here — it
        // would silently file the lesson under the wrong tutor's account.
        owner_id: l.ownerId,
        lesson_date: l.lessonDate,
        status: l.status,
        google_event_id: l.eventKey,
        lesson_notes: l.title,
        start_time: l.startTime,
        pre_settled: l.lessonDate < l.resetDate
      }),
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;
  Logger.log('Failed to upsert ' + l.title + ': ' + response.getContentText());
  return false;
}

/**
 * Deletes lessons in the window whose calendar occurrence is gone. Only rows
 * with a google_event_id are touched, so anything added by hand in the app is
 * safe, and a lesson with a payment attached is kept rather than orphaning it.
 * Scoped to one tutor's own rows, same reasoning as fetchStudentMatchers_.
 */
function reconcileDeletions_(config, seenKeys, startDate, endDate, ownerId) {
  const tz = Session.getScriptTimeZone();
  const url = config.url + '/rest/v1/tutoring_lessons'
    + '?select=id,google_event_id,lesson_date,bundle_id,lesson_notes'
    + '&google_event_id=not.is.null'
    + '&owner_id=eq.' + ownerId
    + '&lesson_date=gte.' + Utilities.formatDate(startDate, tz, 'yyyy-MM-dd')
    + '&lesson_date=lte.' + Utilities.formatDate(endDate, tz, 'yyyy-MM-dd');

  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    Logger.log('Could not load lessons for deletion check: ' + response.getContentText());
    return 0;
  }

  const orphans = JSON.parse(response.getContentText())
    .filter(r => !seenKeys[r.google_event_id]);
  if (orphans.length === 0) return 0;

  const deletable = orphans.filter(r => !r.bundle_id);
  orphans.filter(r => r.bundle_id).forEach(r => {
    Logger.log('KEPT (event gone but payment linked): ' + r.lesson_date + ' — ' + r.lesson_notes);
  });
  if (deletable.length === 0) return 0;

  let deleted = 0;
  for (let i = 0; i < deletable.length; i += DELETE_CHUNK_SIZE) {
    const chunk = deletable.slice(i, i + DELETE_CHUNK_SIZE);
    // Unquoted UUIDs: quotes are not valid URL characters and UrlFetchApp
    // rejects the whole request as an invalid argument.
    const idList = chunk.map(r => r.id).join(',');

    const delRes = UrlFetchApp.fetch(
      config.url + '/rest/v1/tutoring_lessons?id=in.(' + idList + ')',
      { method: 'delete', headers: supabaseHeaders_(config), muteHttpExceptions: true }
    );
    if (delRes.getResponseCode() >= 300) {
      Logger.log('Deletion failed: ' + delRes.getContentText());
      continue;
    }
    chunk.forEach(r => Logger.log('DELETED: ' + r.lesson_date + ' — ' + r.lesson_notes));
    deleted += chunk.length;
  }
  return deleted;
}

// ─── Past papers ─────────────────────────────────────────────────────────

function syncPastPapers_(config, account) {
  const students = fetchStudentsWithSheets_(config, account.ownerId);
  let updated = 0;
  let failed = 0;

  students.forEach(s => {
    try {
      const latest = latestPaperFromSheet_(s.spreadsheet_url);
      if (patchStudentPaper_(config, s.id, latest)) updated++; else failed++;
    } catch (err) {
      failed++;
      Logger.log('Could not read ' + s.name + "'s sheet: " + err);
    }
  });

  Logger.log('[' + account.label + '] Papers — updated: ' + updated + ' | failed: ' + failed);
}

function fetchStudentsWithSheets_(config, ownerId) {
  const url = config.url + '/rest/v1/tutoring_students' +
    '?select=id,name,spreadsheet_url&active=eq.true&spreadsheet_url=not.is.null' +
    '&owner_id=eq.' + ownerId;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: supabaseHeaders_(config),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to fetch students: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

function sheetIdFromUrl_(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('Not a Google Sheets URL: ' + url);
  return m[1];
}

/**
 * Trackers record dates as "26/4" with no year, so each is resolved to its
 * most recent occurrence on or before today.
 */
function resolvePaperDate_(value, today) {
  if (value instanceof Date && !isNaN(value)) return value;

  const text = String(value || '').trim();
  if (!text) return null;

  const m = text.match(/^(\d{1,2})\s*[\/\.\-]\s*(\d{1,2})(?:\s*[\/\.\-]\s*(\d{2,4}))?$/);
  if (!m) return null;

  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;

  if (m[3]) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return new Date(year, month - 1, day);
  }

  let candidate = new Date(today.getFullYear(), month - 1, day);
  if (candidate > today) candidate = new Date(today.getFullYear() - 1, month - 1, day);
  return candidate;
}

/** Most recent completed paper across every tab, or null. */
function latestPaperFromSheet_(spreadsheetUrl) {
  const ss = SpreadsheetApp.openById(sheetIdFromUrl_(spreadsheetUrl));
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  let best = null;

  ss.getSheets().forEach(sheet => {
    const values = sheet.getDataRange().getValues();

    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        if (!PAPER_HEADER_PATTERN.test(String(values[r][c] || ''))) continue;

        // Column to the left of "Date taken" holds the score.
        for (let rr = r + 1; rr < values.length; rr++) {
          const when = resolvePaperDate_(values[rr][c], today);
          if (!when || when > today) continue;
          if (best && when <= best.when) continue;

          const score = parseFloat(String(c > 0 ? values[rr][c - 1] : '').replace('%', ''));

          const nameParts = [];
          for (let cc = 0; cc < Math.min(c - 1, 4); cc++) {
            const cell = String(values[rr][cc] || '').trim();
            if (cell) nameParts.push(cell);
          }

          best = {
            when: when,
            date: Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
            score: isNaN(score) ? null : score,
            name: nameParts.join(' ').slice(0, 80) || 'Past paper'
          };
        }
      }
    }
  });

  return best;
}

function patchStudentPaper_(config, studentId, latest) {
  const response = UrlFetchApp.fetch(
    config.url + '/rest/v1/tutoring_students?id=eq.' + studentId,
    {
      method: 'patch',
      contentType: 'application/json',
      headers: supabaseHeaders_(config),
      payload: JSON.stringify({
        last_paper_date:  latest ? latest.date  : null,
        last_paper_score: latest ? latest.score : null,
        last_paper_name:  latest ? latest.name  : null,
        papers_synced_at: new Date().toISOString()
      }),
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;
  Logger.log('Failed to update student ' + studentId + ': ' + response.getContentText());
  return false;
}
