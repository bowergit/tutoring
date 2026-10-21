// Run with: node test-hourly.cjs
const assert = require('node:assert/strict');
const H = require('./hourly-billing.js');

// Prices: proportional to length.
assert.equal(H.price(100, 90), 150, '90 minutes at £100/hour is £150');
assert.equal(H.price(100, 120), 200);
assert.equal(H.price(100, 45), 75);
assert.equal(H.price(95, 50), 79.17, 'rounded to the penny');

// Labels.
assert.equal(H.minutesLabel(60), '1 hour');
assert.equal(H.minutesLabel(90), '90 min');
assert.equal(H.minutesLabel(120), '2 hours');
assert.equal(H.minutesLabel(45), '45 min');
assert.equal(H.slotLabel({ weekday: 2, start: '16:00', minutes: 90 }), 'Tuesday 4pm · 90 min');
assert.equal(H.slotLabel({ weekday: 4, start: '13:30', minutes: 60 }), 'Thursday 1:30pm · 1 hour');

// Plans: the one covering a date, and history kept when the rate changes.
const p1 = { id: 'p1', student_id: 's', hourly_rate: 100, starts_on: '2026-10-29', ends_before: '2026-12-01', status: 'ended' };
const p2 = { id: 'p2', student_id: 's', hourly_rate: 110, starts_on: '2026-12-01', ends_before: null, status: 'active' };
H.set([p1, p2], [{ student_id: 's', number: 'INV-202611-ZAC', period_start: '2026-11-01', issued_at: '2026-12-01' }]);
assert.equal(H.planFor('s', '2026-11-15').id, 'p1');
assert.equal(H.planFor('s', '2026-12-02').id, 'p2');
assert.equal(H.planFor('s', '2026-10-01'), null, 'before the first plan');
assert.equal(H.planFor('other', '2026-11-15'), null, 'other students untouched');

// Invoices: taught lessons in the month, complimentary at £0, scheduled and other months left out.
const lessons = [
  { student_id: 's', lesson_date: '2026-10-29', start_time: '13:00', status: 'completed', is_complimentary: true, rate_charged: 100, billed_minutes: 60, hourly_plan_id: 'p1' },
  { student_id: 's', lesson_date: '2026-11-03', start_time: '16:00', status: 'completed', rate_charged: 150, billed_minutes: 90, hourly_plan_id: 'p1' },
  { student_id: 's', lesson_date: '2026-11-05', start_time: '16:00', status: 'completed', rate_charged: 100, billed_minutes: 60, hourly_plan_id: 'p1', tutor_notes: 'Fractions, good progress' },
  { student_id: 's', lesson_date: '2026-11-10', start_time: '16:00', status: 'completed', rate_charged: 50, charge_overridden: true, hourly_plan_id: null },
  { student_id: 's', lesson_date: '2026-11-12', start_time: '16:00', status: 'missed', rate_charged: 100, billed_minutes: 60, hourly_plan_id: 'p1' },
  { student_id: 's', lesson_date: '2026-11-26', start_time: '16:00', status: 'scheduled', rate_charged: 150, billed_minutes: 90, hourly_plan_id: 'p1' },
  { student_id: 'x', lesson_date: '2026-11-04', start_time: '16:00', status: 'completed', rate_charged: 90 },
];
const { start, end } = H.monthRange('2026-11');
assert.deepEqual([start, end], ['2026-11-01', '2026-11-30']);
const lines = H.invoiceLines(lessons, 's', start, end);
assert.deepEqual(lines.map(l => [l.date, l.amount]), [['2026-11-03', 150], ['2026-11-05', 100], ['2026-11-10', 50]],
  'taught lessons only; missed (no agreed charge), scheduled and other students left out');
assert.equal(lines[0].rate, 100);
assert.equal(lines[2].note, 'Agreed price');
const oct = H.invoiceLines(lessons, 's', ...Object.values(H.monthRange('2026-10')));
assert.deepEqual(oct.map(l => [l.amount, l.note]), [[0, 'Complimentary']], 'the free intro is listed at £0');

// Invoice numbers never collide.
assert.equal(H.invoiceNumber('Zachy Smith', '2026-12', H.invoices('s')), 'INV-202612-ZAC');
assert.equal(H.invoiceNumber('Zachy Smith', '2026-11', H.invoices('s')), 'INV-202611-ZAC-2');

// Termly summary: attendance, hours and notes.
const t = H.termSummary(lessons, 's', '2026-10-01', '2026-11-30');
assert.equal(t.taught, 4);
assert.equal(t.missed, 1);
assert.equal(t.upcoming, 1);
assert.equal(t.hours, 3.5, '60+90+60 minutes, plus one with no recorded length');
assert.equal(t.rows.find(r => r.date === '2026-11-05').notes, 'Fractions, good progress');

// Printable pages escape whatever they are given.
const inv = H.invoiceHTML({ number: 'INV-1', issued_at: '2026-12-01T10:00:00Z', student_name: '<b>Zachy</b>', period_start: start, period_end: end,
  payer: 'council', payer_name: 'Barnet <Council>', payer_reference: 'EHCP 123', lines, total: 300, tutor_name: 'Daniel', invoice_notes: 'Sort code <x>' });
assert(inv.includes('&lt;b&gt;Zachy&lt;/b&gt;') && !inv.includes('<b>Zachy</b>'), 'student name escaped');
assert(inv.includes('Barnet &lt;Council&gt;') && inv.includes('Ref: EHCP 123'), 'payer and reference shown, escaped');
assert(inv.includes('£300.00') && inv.includes('£150.00') && inv.includes('90 min'), 'totals, charges and lengths shown');
const term = H.termHTML({ student_name: 'Zachy', start: '2026-10-01', end: '2026-11-30', summary: t });
assert(term.includes('Fractions, good progress') && term.includes('3.5 hours'));

console.log('Hourly billing: all assertions passed.');
