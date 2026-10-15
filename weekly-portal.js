(function () {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const short = v => '£'+Number(v).toFixed(2).replace(/\.00$/,'');
  const money = v => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(Number(v));
  const day = d => new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});

  // One card, styled with the same tokens as the rest of the parent page.
  window.renderWeekly = function (w) {
    if(!w) return '';
    const p=w.plan, a=w.acceptance;
    const price=esc(short(p.weekly_fee));
    const state=p.status==='ended'?'ended':p.status==='proposed'?'waiting to start':'active';
    const rows=w.entries.map(c=>`<tr><td>${esc(day(c.date))}</td><td>${esc(money(c.amount))}</td><td>${c.waived?'Waived':c.paid>=c.amount-0.005?'Paid':!c.due?'Scheduled':c.paid>0?'Part paid':'Due'}</td></tr>`).join('');
    const details=`
      <p class="wk-line">${esc(p.lesson_slot)}<br>First payment: ${esc(day(p.starts_on))}</p>
      ${p.status==='ended'&&p.ends_before?`<p class="wk-line">Weekly tuition has ended. No charges from ${esc(day(p.ends_before))}.</p>`:''}
      ${w.entries.length?`<details class="wk-more"><summary>Charges</summary><div class="wk-body" style="overflow-x:auto"><table class="wk-table"><thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></details>`:''}
      <details class="wk-more"><summary>Payments received</summary><div class="wk-body">${w.payments.length?w.payments.map(r=>`<p class="wk-line">${esc(day(r.date_paid))}: ${esc(money(r.amount))}</p>`).join(''):'<p class="wk-line">No payments yet.</p>'}</div></details>
      <details class="wk-more"><summary>The agreement</summary><div class="wk-body"><pre class="wk-terms">${esc(p.terms_text)}</pre>${a?`<p class="wk-line">Agreed by ${esc(a.signer_name)} on ${esc(new Date(a.accepted_at).toLocaleDateString('en-GB',{timeZone:'Europe/London'}))}.</p>`:''}</div></details>`;
    const style=`<style>
      .wk-card{padding:0;margin:18px 0}
      .wk-card summary{list-style:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
      .wk-card summary::-webkit-details-marker{display:none}
      .wk-card .wk-main>summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;font-size:1rem;font-weight:700;transition:background .18s var(--ease,ease)}
      .wk-card .wk-main>summary:active{background:var(--card-2)}
      .wk-card .wk-main>summary small{font-weight:600;color:var(--ink-dim);font-size:.8rem;margin-left:6px}
      .wk-card summary .wk-chev{font-size:1rem;color:var(--muted);transition:transform .25s cubic-bezier(.4,0,.2,1)}
      .wk-card details[open]>summary .wk-chev{transform:rotate(90deg)}
      .wk-inner{padding:0 18px 16px}
      .wk-head{padding:16px 18px 0}.wk-head h2{margin:0;font-size:1.2rem;font-weight:750;letter-spacing:-.02em}
      .wk-line{margin:8px 0;font-size:.88rem;line-height:1.55;color:var(--ink-dim)}
      .wk-more{border-top:1px solid var(--line);margin-top:12px}
      .wk-more>summary{display:flex;align-items:center;justify-content:space-between;padding:12px 0;font-size:.86rem;font-weight:650;color:var(--ink)}
      .wk-more>summary::after{content:'›';font-size:1rem;color:var(--muted);transition:transform .25s cubic-bezier(.4,0,.2,1)}
      .wk-more[open]>summary::after{transform:rotate(90deg)}
      .wk-card details[open]>.wk-body,.wk-card details[open]>.wk-inner{animation:wkIn .24s ease both}
      @keyframes wkIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
      .wk-terms{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.86rem;line-height:1.65;margin:4px 0 8px;color:var(--ink)}
      .wk-table{border-collapse:collapse;width:100%;font-size:.82rem;text-align:left}.wk-table th{font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:6px 4px;border-bottom:1px solid var(--line)}.wk-table td{padding:9px 4px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
      .wk-form{margin-top:14px}.wk-form label{display:block;font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;font-weight:600;color:var(--muted);margin-bottom:5px}
      .wk-form input[type=text]{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:var(--r-md);font:inherit;font-size:.95rem;background:var(--card-2);color:var(--ink);transition:border-color .18s,box-shadow .18s,background .18s}
      .wk-form input[type=text]:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,165,0,.28);background:var(--card)}
      .wk-check{display:flex;align-items:center;gap:10px;margin:14px 0;font-size:.88rem;line-height:1.45;color:var(--ink);text-transform:none;letter-spacing:0;font-weight:500}
      .wk-check input{width:20px;height:20px;flex:none;accent-color:var(--accent)}
      .wk-msg{color:var(--warn);font-size:.84rem;margin:10px 0 0}
      @media (prefers-reduced-motion:reduce){.wk-card *{animation:none!important;transition:none!important}}
    </style>`;
    if(a) return `${style}<section class="card wk-card" aria-label="Weekly tuition">
      <details class="wk-main" id="weekly-card-wrap"><summary><span>${price} a week<small>${state}</small></span><span class="wk-chev" aria-hidden="true">›</span></summary>
      <div class="wk-inner">${details}</div></details></section>`;
    if(p.status==='proposed') return `${style}<section class="card wk-card" id="weekly-agreement" aria-label="Weekly tuition">
      <div class="wk-head"><h2>${price} a week</h2></div>
      <div class="wk-inner"><p class="wk-line">${esc(p.lesson_slot)}<br>First payment: ${esc(day(p.starts_on))}</p>
      <pre class="wk-terms">${esc(p.terms_text)}</pre>
      <form class="wk-form" id="weekly-accept-form"><label for="wk-name">Your full name</label><input id="wk-name" type="text" name="signer_name" required minlength="2" maxlength="150" autocomplete="name">
      <label class="wk-check"><input type="checkbox" name="agree" required><span>I agree to this, ${price} a week.</span></label>
      <button class="action-btn settle-btn" type="submit" style="width:100%">Agree</button></form>
      <p class="wk-msg" id="weekly-accept-message" role="status"></p></div></section>`;
    return '';
  };

  window.wireWeekly = function(w, endpoint) {
    if(!w) return;
    const p=w.plan;
    let busy=false;
    document.getElementById('weekly-accept-form')?.addEventListener('submit',async e=>{
      e.preventDefault(); if(busy) return; busy=true;
      const f=new FormData(e.currentTarget), message=document.getElementById('weekly-accept-message');
      const btn=e.currentTarget.querySelector('button'); btn.disabled=true; message.textContent='Saving…';
      try {
        const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'accept',plan_id:p.id,terms_version:p.terms_version,signer_name:f.get('signer_name'),agree:f.has('agree')})});
        const result=await res.json(); if(!res.ok || !result.ok) throw new Error(result.problem || 'Could not save. Please try again.');
        location.reload();
      } catch(err) { message.textContent=err.message; btn.disabled=false; busy=false; }
    });
  };
})();
