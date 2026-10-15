(function (root) {
  'use strict';
  let plans = [], charges = [];
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  function covers(l) {
    return !l.is_weekly_charge && plans.some(p => p.student_id === l.student_id && p.status !== 'proposed' && p.acceptance && l.lesson_date >= p.starts_on && (!p.ends_before || l.lesson_date < new Date(new Date(p.starts_on+'T12:00:00Z').getTime()+Math.ceil((new Date(p.ends_before+'T12:00:00Z').getTime()-new Date(p.starts_on+'T12:00:00Z').getTime())/604800000)*604800000).toISOString().slice(0,10)));
  }
  function financialLessons(lessons, studentId) {
    const ids = studentId ? new Set([studentId]) : new Set([...lessons.map(l => l.student_id), ...plans.map(p => p.student_id)]);
    return lessons.filter(l => !covers(l)).concat(charges.filter(c => ids.has(c.student_id)).map(c => ({
      id: 'weekly:' + c.plan_id + ':' + c.charge_date, student_id: c.student_id,
      lesson_date: c.charge_date, status: c.charge_date <= today() ? 'completed' : 'scheduled',
      rate_charged: Number(c.amount), is_complimentary: c.waived, pre_settled: false, is_weekly_charge: true, reason: c.reason,
    })));
  }
  function ledger(lessons, payments, studentId, rate) {
    let remaining = Math.round(payments.filter(p => p.student_id === studentId && !p.deleted_at).reduce((s,p) => s + Number(p.amount), 0) * 100);
    return financialLessons(lessons.filter(l => l.student_id === studentId), studentId)
      .filter(l => l.status !== 'cancelled' && !l.pre_settled)
      .sort((a,b) => (a.lesson_date + (a.start_time || '')).localeCompare(b.lesson_date + (b.start_time || '')))
      .map(l => {
        const amount = l.is_complimentary ? 0 : Math.round(rate(l) * 100);
        const paid = Math.min(Math.max(remaining, 0), amount); remaining -= paid;
        return { ...l, amount: amount / 100, paid: paid / 100, due: l.lesson_date <= today(), left: (amount - paid) / 100 };
      });
  }
  root.TTWeekly = { today, covers, financialLessons, ledger,
    set(p,c) { plans=p; charges=c; },
    plans(id) { return plans.filter(p => p.student_id === id); },
    charges(id) { return charges.filter(c => c.student_id === id); },
  };
  if (typeof module !== 'undefined') module.exports=root.TTWeekly;
})(typeof window === 'undefined' ? globalThis : window);
