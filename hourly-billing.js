// Hourly tuition: pure helpers shared by the app and its tests.
//
// The price of each lesson is set in the database (tutoring_hourly_price), so
// every existing balance, allocation and parent-page sum keeps working on
// rate_charged exactly as before. This file only reads those prices back: it
// lays out invoices and termly summaries, and never decides what is owed.
(function (root) {
  'use strict';
  let plans = [], invoices = [];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => '£' + Number(n || 0).toFixed(2);
  const round2 = n => Math.round(Number(n) * 100) / 100;

  function price(rate, minutes) { return round2(Number(rate) * Number(minutes) / 60); }

  function minutesLabel(m) {
    m = Number(m);
    if (!m) return '';
    if (m % 60) return `${m} min`;
    const h = m / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  }

  function timeLabel(t) {
    if (!t) return '';
    const [hh, mm] = String(t).split(':').map(Number);
    return `${hh % 12 || 12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${hh < 12 ? 'am' : 'pm'}`;
  }

  function slotLabel(s) {
    return `${DAYS[Number(s.weekday)] || '?'} ${timeLabel(s.start)} · ${minutesLabel(s.minutes)}`.replace(/\s+·/, ' ·');
  }

  function dateLabel(iso) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // The plan covering a date, latest start first. Ended plans still cover their own dates.
  function planFor(studentId, date) {
    const d = date || today();
    return plans
      .filter(p => p.student_id === studentId && p.starts_on <= d && (!p.ends_before || d < p.ends_before))
      .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0] || null;
  }
  // The arrangement a student is on now or about to start: active and not finished.
  function currentPlan(studentId) {
    const d = today();
    return plans
      .filter(p => p.student_id === studentId && p.status === 'active' && (!p.ends_before || d < p.ends_before))
      .sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0] || null;
  }

  function monthRange(ym) {
    const [y, m] = ym.split('-').map(Number);
    const start = `${ym}-01`;
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    return { start, end };
  }

  // Every lesson in the period that an hourly plan priced, in date order. Taught lessons
  // are charged; a complimentary one is listed at £0 so the record shows it happened.
  function invoiceLines(lessons, studentId, start, end) {
    return lessons
      .filter(l => l.student_id === studentId && l.lesson_date >= start && l.lesson_date <= end)
      .filter(l => l.hourly_plan_id || l.charge_overridden)
      .filter(l => l.status === 'completed' || (l.status === 'missed' && l.charge_overridden && Number(l.rate_charged) > 0))
      .sort((a, b) => (a.lesson_date + (a.start_time || '')).localeCompare(b.lesson_date + (b.start_time || '')))
      .map(l => {
        const plan = plans.find(p => p.id === l.hourly_plan_id) || null;
        const free = !!l.is_complimentary;
        return {
          date: l.lesson_date,
          start: l.start_time || null,
          minutes: l.billed_minutes || l.duration_minutes || null,
          rate: plan ? Number(plan.hourly_rate) : null,
          amount: free ? 0 : round2(l.rate_charged || 0),
          note: free ? 'Complimentary' : l.charge_overridden ? 'Agreed price' : (l.status === 'missed' ? 'Missed lesson' : ''),
        };
      });
  }

  // INV-202611-ZAC, then -2, -3 if more than one is raised for the same month.
  function invoiceNumber(studentName, ym, existing) {
    const tag = String(studentName || 'X').replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'X';
    const base = `INV-${ym.replace('-', '')}-${tag}`;
    const taken = new Set((existing || []).map(i => i.number));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }

  // Lessons, attendance and progress notes over a stretch of time, for termly reports.
  function termSummary(lessons, studentId, start, end) {
    const rows = lessons
      .filter(l => l.student_id === studentId && l.lesson_date >= start && l.lesson_date <= end && l.status !== 'cancelled')
      .sort((a, b) => (a.lesson_date + (a.start_time || '')).localeCompare(b.lesson_date + (b.start_time || '')))
      .map(l => ({
        date: l.lesson_date, start: l.start_time || null, status: l.status,
        minutes: l.billed_minutes || l.duration_minutes || null, notes: l.tutor_notes || '',
      }));
    const taught = rows.filter(r => r.status === 'completed');
    return {
      rows,
      taught: taught.length,
      missed: rows.filter(r => r.status === 'missed').length,
      upcoming: rows.filter(r => r.status === 'scheduled').length,
      hours: round2(taught.reduce((s, r) => s + (Number(r.minutes) || 0), 0) / 60),
    };
  }

  const PRINT_CSS = `body{font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#15211f;margin:0;background:#fff}
    main{max-width:760px;margin:0 auto;padding:40px 36px}h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
    .muted{color:#596965}.top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:28px}
    .box{border:1px solid #dfe7e3;border-radius:10px;padding:12px 14px;min-width:220px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#87938f;font-weight:700;margin-bottom:4px}
    table{width:100%;border-collapse:collapse;margin:18px 0}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#87938f;text-align:left;border-bottom:2px solid #15211f;padding:8px 6px}
    td{padding:9px 6px;border-bottom:1px solid #dfe7e3;vertical-align:top}.num{text-align:right;font-variant-numeric:tabular-nums}
    .total td{border-bottom:0;font-weight:800;font-size:16px;border-top:2px solid #15211f}.bar{height:5px;background:#ffa500;border-radius:3px;margin-bottom:26px}
    .notes{white-space:pre-wrap}.actions{margin:24px 0}.actions button{font:inherit;font-weight:700;padding:10px 18px;border-radius:10px;border:0;background:#ffa500;cursor:pointer}
    @media print{.actions{display:none}main{padding:0}}`;

  function invoiceHTML(inv) {
    const rows = (inv.lines || []).map(l => `<tr><td>${esc(dateLabel(l.date))}${l.start ? ' · ' + esc(timeLabel(l.start)) : ''}</td>
      <td>${esc(minutesLabel(l.minutes) || '-')}</td><td class="num">${l.rate != null ? esc(money(l.rate)) + '/hr' : '-'}</td>
      <td>${esc(l.note || '')}</td><td class="num">${esc(money(l.amount))}</td></tr>`).join('');
    const payTo = [inv.tutor_name, inv.tutor_email, inv.tutor_phone].filter(Boolean).map(esc).join('<br>');
    const billTo = [inv.payer_name || (inv.payer === 'council' ? 'Local authority' : 'Parent or guardian'),
      inv.payer_reference ? 'Ref: ' + inv.payer_reference : ''].filter(Boolean).map(esc).join('<br>');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title><style>${PRINT_CSS}</style></head>
      <body><main><div class="bar"></div><div class="top"><div><h1>Invoice</h1><div class="muted">${esc(inv.number)} · issued ${esc(dateLabel(String(inv.issued_at).slice(0, 10)))}</div>
      <div class="muted">Tuition for ${esc(inv.student_name)}, ${esc(dateLabel(inv.period_start))} to ${esc(dateLabel(inv.period_end))}</div></div>
      <div class="box"><div class="label">From</div>${payTo || '&nbsp;'}</div></div>
      <div class="box" style="display:inline-block"><div class="label">Bill to</div>${billTo}</div>
      <table><thead><tr><th>Lesson</th><th>Length</th><th class="num">Rate</th><th></th><th class="num">Charge</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="muted">No lessons in this period.</td></tr>'}
      <tr class="total"><td colspan="4">Total due</td><td class="num">${esc(money(inv.total))}</td></tr></tbody></table>
      ${inv.invoice_notes ? `<div class="label">Payment details</div><div class="notes">${esc(inv.invoice_notes)}</div>` : ''}
      ${inv.status === 'void' ? '<p style="color:#b3261e;font-weight:700">This invoice has been cancelled.</p>' : ''}
      <div class="actions"><button onclick="window.print()">Print or save as PDF</button></div></main></body></html>`;
  }

  function termHTML(t) {
    const s = t.summary;
    const rows = s.rows.map(r => `<tr><td>${esc(dateLabel(r.date))}${r.start ? ' · ' + esc(timeLabel(r.start)) : ''}</td>
      <td>${esc({ completed: 'Taught', missed: 'Missed', scheduled: 'Upcoming' }[r.status] || r.status)}</td>
      <td>${esc(minutesLabel(r.minutes) || '-')}</td><td class="notes">${esc(r.notes)}</td></tr>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Progress summary · ${esc(t.student_name)}</title><style>${PRINT_CSS}</style></head>
      <body><main><div class="bar"></div><h1>Progress summary</h1>
      <div class="muted">${esc(t.student_name)} · ${esc(dateLabel(t.start))} to ${esc(dateLabel(t.end))}${t.tutor_name ? ' · ' + esc(t.tutor_name) : ''}</div>
      <p><b>${s.taught}</b> lesson${s.taught === 1 ? '' : 's'} taught (${s.hours} hours)${s.missed ? `, <b>${s.missed}</b> missed` : ''}.</p>
      <table><thead><tr><th>Lesson</th><th>Attendance</th><th>Length</th><th>Notes</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No lessons in this period.</td></tr>'}</tbody></table>
      <div class="actions"><button onclick="window.print()">Print or save as PDF</button></div></main></body></html>`;
  }

  root.TTHourly = {
    DAYS, today, price, minutesLabel, timeLabel, slotLabel, dateLabel, monthRange,
    invoiceLines, invoiceNumber, termSummary, invoiceHTML, termHTML, planFor, currentPlan,
    set(p, i) { plans = p || []; invoices = i || []; },
    plans(id) { return plans.filter(p => p.student_id === id).sort((a, b) => a.starts_on.localeCompare(b.starts_on)); },
    invoices(id) { return invoices.filter(i => i.student_id === id).sort((a, b) => b.period_start.localeCompare(a.period_start) || String(b.issued_at).localeCompare(String(a.issued_at))); },
  };
  if (typeof module !== 'undefined') module.exports = root.TTHourly;
})(typeof window === 'undefined' ? globalThis : window);
