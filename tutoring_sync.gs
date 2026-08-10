/**
 * Past-paper sync — Google Sheets → Supabase
 *
 * Calendar syncing used to live here too. It doesn't any more: every tutor's
 * calendar is now synced server-side via their own Google OAuth connection
 * (Tools → Google Calendar in the app), on a schedule, for everyone at once.
 * Two systems both writing and DELETING lessons was a genuine hazard — each
 * could independently decide a lesson was gone and remove it.
 *
 * What's left is past papers, which still needs Apps Script: reading a
 * spreadsheet needs a Sheets scope the calendar connection doesn't ask for.
 *
 * SETUP
 * 1. Script Properties:
 *      SUPABASE_URL           your project URL
 *      SUPABASE_SERVICE_KEY   service_role legacy JWT (not the sb_secret_ one —
 *                             UrlFetchApp gets blocked by Supabase's browser
 *                             detection on the new keys)
 *      TUTOR_OWNER_ID         your own user id, so this only ever touches your
 *                             students. The service key bypasses row-level
 *                             security, so without this filter the script reads
 *                             and writes every tutor's students, not just yours.
 * 2. ONE daily time-driven trigger on syncPastPapers. Daily is right — paper
 *    scores change a few times a week at most, and each run opens every
 *    student's spreadsheet.
 */

const PAPER_HEADER_PATTERN = /date\s*taken/i;

/** The only function the trigger needs to call. */
function syncPastPapers() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY script properties.');
  }
  if (!config.ownerId) {
    throw new Error('Missing TUTOR_OWNER_ID script property — refusing to run ' +
      'unscoped, since the service key would otherwise read every tutor\'s students.');
  }

  const students = fetchStudentsWithSheets_(config);
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

  Logger.log('Papers — updated: ' + updated + ' | failed: ' + failed);
}

/**
 * Kept so a trigger still pointing at the old name keeps working. Without it
 * an un-updated trigger fails silently every run and paper scores just quietly
 * stop updating.
 */
function syncTutoring() {
  syncPastPapers();
}

// ─── Supabase ────────────────────────────────────────────────────────────

function getSupabaseConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    url: props.getProperty('SUPABASE_URL'),
    key: props.getProperty('SUPABASE_SERVICE_KEY'),
    ownerId: props.getProperty('TUTOR_OWNER_ID')
  };
}

function supabaseHeaders_(config) {
  return {
    'apikey': config.key,
    'Authorization': 'Bearer ' + config.key
  };
}

function fetchStudentsWithSheets_(config) {
  const url = config.url + '/rest/v1/tutoring_students' +
    '?select=id,name,spreadsheet_url' +
    '&active=eq.true' +
    '&spreadsheet_url=not.is.null' +
    '&owner_id=eq.' + config.ownerId;
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

function patchStudentPaper_(config, studentId, latest) {
  const response = UrlFetchApp.fetch(
    config.url + '/rest/v1/tutoring_students?id=eq.' + studentId +
      '&owner_id=eq.' + config.ownerId,
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

// ─── Sheets ──────────────────────────────────────────────────────────────

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
            const raw = values[rr][cc];
            // A date in these columns is the exam series ("June 2018"), not a
            // timestamp. Left as-is it stringifies to the full JS date —
            // "Fri Jun 01 2018 00:00:00 GMT+0100 (British Summer Time)" —
            // which then shows up verbatim on the student's card.
            const cell = (raw instanceof Date && !isNaN(raw))
              ? Utilities.formatDate(raw, Session.getScriptTimeZone(), 'MMM yyyy')
              : String(raw || '').trim();
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
