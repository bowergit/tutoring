/**
 * Past paper sync — Google Sheets → Supabase
 *
 * Reads each active student's tracker sheet, finds the most recent past paper
 * they've completed, and writes it back to tutoring_students. The app then
 * shows a ✨ against anyone who has done one in the last week.
 *
 * SETUP
 * 1. Paste into the SAME Apps Script project as the calendar sync, so it
 *    shares the SUPABASE_URL / SUPABASE_SERVICE_KEY script properties.
 * 2. Add a second time-driven trigger on syncPastPapers, daily.
 *    (Or call it from syncTutoringCalendar if you'd rather have one trigger.)
 *
 * HOW IT FINDS THE DATA
 * It looks for a header cell reading "Date taken" on any tab, then reads the
 * column beneath it. The column immediately to its left is treated as the
 * score, and the paper name is taken from the first two columns of the row —
 * which matches the layout of the existing trackers ("Nov 2025", "1H").
 *
 * DATES WITHOUT YEARS
 * The trackers record dates as "26/4" with no year, so each is resolved to its
 * most recent occurrence on or before today. A paper marked 28/7 when today is
 * 30 July reads as two days ago; one marked 26/4 reads as this April. The only
 * way this misreads is a date typed for the future, which resolves to last
 * year — harmless for a "did they do one recently" flag.
 */

const PAPER_HEADER_PATTERN = /date\s*taken/i;

function syncPastPapers() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY script properties.');
  }

  const students = fetchStudentsWithSheets_(config);
  Logger.log('Checking ' + students.length + ' student sheet(s).');

  let updated = 0;
  let failed = 0;

  students.forEach(function (s) {
    try {
      const latest = latestPaperFromSheet_(s.spreadsheet_url);
      const ok = patchStudentPaper_(config, s.id, latest);
      if (ok) {
        updated++;
        Logger.log(s.name + ': ' + (latest
          ? latest.name + ' — ' + latest.score + '% on ' + latest.date
          : 'no completed papers found'));
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      Logger.log('Could not read ' + s.name + "'s sheet: " + err);
    }
  });

  Logger.log('Updated: ' + updated + ' | Failed: ' + failed);
}

function fetchStudentsWithSheets_(config) {
  const url = config.url +
    '/rest/v1/tutoring_students?select=id,name,spreadsheet_url' +
    '&active=eq.true&spreadsheet_url=not.is.null';
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

/** Pulls the spreadsheet id out of a normal Google Sheets share URL. */
function sheetIdFromUrl_(url) {
  const m = String(url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!m) throw new Error('Not a Google Sheets URL: ' + url);
  return m[1];
}

/**
 * Resolves a "26/4" style date to its most recent occurrence on or before
 * today. Also accepts a real Date, which is what Sheets gives when the cell
 * was entered as a date rather than text.
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

  // No year given: take the most recent time this day/month happened.
  let candidate = new Date(today.getFullYear(), month - 1, day);
  if (candidate > today) candidate = new Date(today.getFullYear() - 1, month - 1, day);
  return candidate;
}

/**
 * Scans every tab for a "Date taken" header and returns the most recent
 * completed paper found beneath it, or null.
 */
function latestPaperFromSheet_(spreadsheetUrl) {
  const ss = SpreadsheetApp.openById(sheetIdFromUrl_(spreadsheetUrl));
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  let best = null;

  ss.getSheets().forEach(function (sheet) {
    const values = sheet.getDataRange().getValues();

    for (let r = 0; r < values.length; r++) {
      for (let c = 0; c < values[r].length; c++) {
        if (!PAPER_HEADER_PATTERN.test(String(values[r][c] || ''))) continue;

        // Found the header. Everything below it in this column is a date.
        for (let rr = r + 1; rr < values.length; rr++) {
          const when = resolvePaperDate_(values[rr][c], today);
          if (!when || when > today) continue;

          const scoreRaw = c > 0 ? values[rr][c - 1] : '';
          const score = parseFloat(String(scoreRaw).replace('%', ''));

          // Paper name from the leftmost filled cells of the row, e.g. "Nov 2025 1H".
          const nameParts = [];
          for (let cc = 0; cc < Math.min(c - 1, 4); cc++) {
            const cell = String(values[rr][cc] || '').trim();
            if (cell) nameParts.push(cell);
          }

          if (!best || when > best.when) {
            best = {
              when: when,
              date: Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
              score: isNaN(score) ? null : score,
              name: nameParts.join(' ').slice(0, 80) || 'Past paper'
            };
          }
        }
      }
    }
  });

  return best;
}

function patchStudentPaper_(config, studentId, latest) {
  const payload = {
    last_paper_date:  latest ? latest.date  : null,
    last_paper_score: latest ? latest.score : null,
    last_paper_name:  latest ? latest.name  : null,
    papers_synced_at: new Date().toISOString()
  };

  const response = UrlFetchApp.fetch(
    config.url + '/rest/v1/tutoring_students?id=eq.' + studentId,
    {
      method: 'patch',
      contentType: 'application/json',
      headers: supabaseHeaders_(config),
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );

  const code = response.getResponseCode();
  if (code >= 200 && code < 300) return true;
  Logger.log('Failed to update student ' + studentId + ': ' + response.getContentText());
  return false;
}
