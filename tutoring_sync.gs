/**
 * Past-paper sync - Google Sheets → Supabase
 *
 * Calendar syncing used to live here too. It doesn't any more: every tutor's
 * calendar is now synced server-side via their own Google OAuth connection
 * (Tools → Google Calendar in the app), on a schedule, for everyone at once.
 * Two systems both writing and DELETING lessons was a genuine hazard.
 *
 * What's left is past papers, which still needs Apps Script: reading a
 * spreadsheet needs a Sheets scope the calendar connection doesn't ask for.
 *
 * SETUP
 * 1. Script Properties:
 *      SUPABASE_URL           your project URL
 *      SUPABASE_SERVICE_KEY   service_role legacy JWT (not the sb_secret_ one -
 *                             UrlFetchApp gets blocked by Supabase's browser
 *                             detection on the new keys)
 *      TUTOR_OWNER_ID         your own user id, so this only ever touches your
 *                             students. The service key bypasses row-level
 *                             security, so without this filter the script reads
 *                             and writes every tutor's students, not just yours.
 * 2. ONE daily time-driven trigger on syncPastPapers. This is the backstop:
 *    it catches anything the change triggers missed, and it is the only thing
 *    running if you never install them.
 * 3. Optional, for near-instant updates: run installSheetTriggers() once by
 *    hand. It puts a change trigger on each student's tracker so a score typed
 *    into a sheet reaches the parent page within seconds instead of by the
 *    next morning. Run it again whenever you add a student or change whose
 *    sheet is whose, since it works off the current list.
 */

const PAPER_HEADER_PATTERN = /date\s*taken/i;

/** The only function the trigger needs to call. */
function syncPastPapers() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY script properties.');
  }
  if (!config.ownerId) {
    throw new Error('Missing TUTOR_OWNER_ID script property - refusing to run ' +
      'unscoped, since the service key would otherwise read every tutor of ' +
      'every account, not just yours.');
  }

  const students = fetchStudentsWithSheets_(config);
  let updated = 0, failed = 0, papers = 0;

  students.forEach(s => {
    const result = syncOneStudent_(config, s);
    papers += result.papers;
    if (result.ok) updated++; else failed++;
  });

  Logger.log('Papers - students updated: ' + updated + ' | failed: ' + failed +
             ' | papers recorded: ' + papers);
}

/** Kept so a trigger still pointing at an older name keeps working. */
function syncTutoring() { syncPastPapers(); }

/** One student's tracker, read and written wholesale. */
function syncOneStudent_(config, student) {
  try {
    const found = papersFromSheet_(student.spreadsheet_url);
    replacePapers_(config, student.id, found);
    // Newest first, so the chip on the student card stays as it was.
    const latest = found.length
      ? found.slice().sort(function (a, b) { return b.date.localeCompare(a.date); })[0]
      : null;
    return { ok: patchStudentPaper_(config, student.id, latest), papers: found.length };
  } catch (err) {
    Logger.log('Could not read ' + student.name + ' sheet: ' + err);
    return { ok: false, papers: 0 };
  }
}

// ─── Change triggers ──────────────────────────────────────────────

/**
 * Puts a change trigger on every tracker currently linked to a student, so
 * typing a score updates the parent page straight away.
 *
 * Safe to run repeatedly: it clears its own old triggers first, so re-running
 * after adding a student leaves exactly one trigger per sheet rather than a
 * growing pile. Google caps a script at 20 triggers per user, which is the
 * real limit on how many trackers this can watch; the daily sync still covers
 * everything either way.
 */
function installSheetTriggers() {
  const config = getSupabaseConfig_();
  if (!config.url || !config.key || !config.ownerId) {
    throw new Error('Set SUPABASE_URL, SUPABASE_SERVICE_KEY and TUTOR_OWNER_ID first.');
  }

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetChanged') ScriptApp.deleteTrigger(t);
  });

  const seen = {};
  fetchStudentsWithSheets_(config).forEach(function (s) {
    try { seen[sheetIdFromUrl_(s.spreadsheet_url)] = true; } catch (err) { /* not a sheet URL */ }
  });
  const ids = Object.keys(seen);

  let made = 0;
  ids.forEach(function (id) {
    try {
      ScriptApp.newTrigger('onSheetChanged').forSpreadsheet(id).onChange().create();
      made++;
    } catch (err) {
      Logger.log('No trigger for ' + id + ': ' + err);
    }
  });

  Logger.log('Watching ' + made + ' of ' + ids.length + ' trackers for changes.');
}

/** Undoes installSheetTriggers, leaving only the daily sync. */
function removeSheetTriggers() {
  let gone = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetChanged') { ScriptApp.deleteTrigger(t); gone++; }
  });
  Logger.log('Removed ' + gone + ' change triggers.');
}

/**
 * Fires when one tracker changes. Syncs only that student, so a single typed
 * score costs one sheet read rather than a sweep of everybody's.
 */
function onSheetChanged(e) {
  const id = e && e.source ? e.source.getId() : null;
  if (!id) return;

  // Google fires this more than once for what feels like one edit, and a
  // person entering marks types several in a row. Collapsing anything inside
  // the window turns a burst into a single round trip.
  const cache = CacheService.getScriptCache();
  if (cache.get('synced:' + id)) return;
  cache.put('synced:' + id, '1', 45);

  const config = getSupabaseConfig_();
  if (!config.url || !config.key || !config.ownerId) return;

  fetchStudentsWithSheets_(config).forEach(function (s) {
    let sheetId = null;
    try { sheetId = sheetIdFromUrl_(s.spreadsheet_url); } catch (err) { return; }
    if (sheetId === id) syncOneStudent_(config, s);
  });
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
  return { 'apikey': config.key, 'Authorization': 'Bearer ' + config.key };
}

function fetchStudentsWithSheets_(config) {
  const url = config.url + '/rest/v1/tutoring_students' +
    '?select=id,name,spreadsheet_url' +
    '&active=eq.true' +
    '&spreadsheet_url=not.is.null' +
    '&owner_id=eq.' + config.ownerId;
  const response = UrlFetchApp.fetch(url, {
    method: 'get', headers: supabaseHeaders_(config), muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Failed to fetch students: ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

/**
 * The sheet is the source of truth, so the stored set is replaced wholesale
 * rather than merged. Clearing a score in the sheet then removes the paper
 * here too, which a merge would silently fail to do.
 */
function replacePapers_(config, studentId, papers) {
  const del = UrlFetchApp.fetch(
    config.url + '/rest/v1/tutoring_past_papers?student_id=eq.' + studentId,
    { method: 'delete', headers: supabaseHeaders_(config), muteHttpExceptions: true }
  );
  if (del.getResponseCode() >= 300) {
    Logger.log('Could not clear old papers for ' + studentId + ': ' + del.getContentText());
    return;
  }
  if (papers.length === 0) return;

  const rows = papers.map(p => ({
    student_id: studentId,
    owner_id: config.ownerId,
    sheet_tab: p.tab,
    paper_set: p.set,
    paper_code: p.code,
    score_raw: p.raw,
    max_score: p.max,
    percentage: p.pct,
    date_taken: p.date
  }));

  const res = UrlFetchApp.fetch(config.url + '/rest/v1/tutoring_past_papers', {
    method: 'post',
    contentType: 'application/json',
    headers: supabaseHeaders_(config),
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) {
    Logger.log('Failed to insert papers for ' + studentId + ': ' + res.getContentText());
  }
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
        last_paper_date:  latest ? latest.date : null,
        // The percentage, never the raw mark. A "Mark /80" column holding 20
        // was being shown as "20%" when it is 25%.
        last_paper_score: latest ? latest.pct : null,
        last_paper_name:  latest ? (latest.set + ' ' + latest.code).trim() : null,
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

/**
 * How to read the score column, worked out from its own heading.
 *
 * "Percentage" is already 0-100. "Mark /80" and "mark out of 80" hold raw
 * marks that have to be scaled. Guessing from the values alone is not safe:
 * 46 is a plausible percentage and a plausible mark out of 80.
 */
function scoreScaleFromHeader_(header) {
  const h = String(header || '').trim();
  if (/percent|%/i.test(h)) return { max: null };
  const outOf = h.match(/(?:\/|out\s*of)\s*(\d{1,3})/i);
  if (outOf) return { max: parseInt(outOf[1], 10) };
  // Nothing in the heading to go on. Treated as a percentage, which is what
  // the tracker templates default to; anything over 100 is rejected below.
  return { max: null };
}

function headerIndex_(row, re) {
  for (let i = 0; i < row.length; i++) {
    if (re.test(String(row[i] || '').trim())) return i;
  }
  return -1;
}

/** Every completed paper across every tab. */
function papersFromSheet_(spreadsheetUrl) {
  const ss = SpreadsheetApp.openById(sheetIdFromUrl_(spreadsheetUrl));
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const tz = Session.getScriptTimeZone();
  const out = [];

  ss.getSheets().forEach(sheet => {
    const tab = sheet.getName();
    const range = sheet.getDataRange();
    const values = range.getValues();
    // Sheets quietly turns "Jun 2018" in the paper-set column into a real
    // date, so getValues hands back a Date and the set was being recorded as
    // "Fri Jun 01 2018 00:00:00 GMT+0100 (British Summer Time)". The displayed
    // text is what the tutor typed and what the boundary lookup needs, so
    // labels are read from there and only the score and date come from the
    // underlying values.
    const shown = range.getDisplayValues();

    for (let r = 0; r < values.length; r++) {
      const cDate = headerIndex_(shown[r], PAPER_HEADER_PATTERN);
      if (cDate < 1) continue;

      const cSet   = headerIndex_(shown[r], /^paper\s*set$/i);
      const cPaper = headerIndex_(shown[r], /^paper$/i);
      const cScore = cDate - 1;
      const scale  = scoreScaleFromHeader_(shown[r][cScore]);

      // Paper set is a merged cell spanning its two or three papers, so only
      // the first row of each group carries the text. Everything below it
      // inherits that value until the next one appears.
      let lastSet = '';

      for (let rr = r + 1; rr < values.length; rr++) {
        const setCell = cSet >= 0 ? String(shown[rr][cSet] || '').trim() : '';
        if (setCell) lastSet = setCell;

        const when = resolvePaperDate_(values[rr][cDate], today);
        if (!when || when > today) continue;

        const cell = values[rr][cScore];
        const raw = parseFloat(String(cell == null ? '' : cell).replace('%', ''));
        if (isNaN(raw)) continue;

        const pct = scale.max ? (raw / scale.max) * 100 : raw;
        if (pct < 0 || pct > 100) continue;

        out.push({
          tab: tab,
          set: lastSet,
          code: cPaper >= 0 ? String(shown[rr][cPaper] || '').trim() : '',
          raw: raw,
          max: scale.max,
          pct: Math.round(pct * 10) / 10,
          date: Utilities.formatDate(when, tz, 'yyyy-MM-dd')
        });
      }
    }
  });

  // The same paper listed twice on one tab would break the unique key, so the
  // later reading wins.
  const seen = {};
  out.forEach(p => { seen[p.tab + '|' + p.set + '|' + p.code] = p; });
  return Object.keys(seen).map(k => seen[k]);
}
