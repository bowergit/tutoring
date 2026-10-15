(function () {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(Number(v));
  const day = d => new Date(d+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  const button = (id,label) => `<button type="button" class="action-btn" id="${id}">${esc(label)}</button>`;
  window.renderWeekly = function (w) {
    if(!w) return '';
    const p=w.plan, a=w.acceptance;
    const cooling=a && Date.now()<new Date(a.accepted_at).getTime()+14*86400000;
    const rows=w.entries.map(c=>`<tr><td>${esc(day(c.date))}</td><td>${esc(c.kind)}${c.reason?`<br><small>${esc(c.reason)}</small>`:''}</td><td>${esc(money(c.amount))}</td><td>${c.waived?'Waived':c.paid>=c.amount-0.005?'Covered by payments':!c.due?'Scheduled':c.paid>0?'Part paid':'Due'}</td></tr>`).join('');
    return `<style>
      .weekly-card{padding:22px;margin:18px 0;background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:16px;line-height:1.6}
      .weekly-card h2{margin:0 0 10px;font-size:1.3rem}.weekly-card p{margin:10px 0}.weekly-card label{display:block;margin:14px 0}
      .weekly-card input[type=text]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #999;border-radius:8px;font:inherit}
      .weekly-card input[type=checkbox]{width:20px;height:20px;vertical-align:middle;margin-right:8px}
      .weekly-terms{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-size:.9rem;line-height:1.7}
      .weekly-card table{border-collapse:collapse;width:100%;font-size:.85rem;text-align:left}.weekly-card td,.weekly-card th{padding:10px 8px;border-bottom:1px solid #ddd}
      .weekly-card summary{cursor:pointer;font-weight:650}.weekly-card .actions{margin:14px 0}.weekly-message{color:#a03024}
      @media print{body *{visibility:hidden}#weekly-agreement,#weekly-agreement *{visibility:visible}#weekly-agreement{position:absolute;left:0;top:0;width:95%;border:0;background:white;color:black}#weekly-agreement button,#weekly-agreement form{display:none}.weekly-terms{font-size:11pt} }
    </style>
    <section class="weekly-card" aria-label="Weekly tuition arrangement">
      <h2>£80 every week, including school holidays</h2>
      <p>${esc(p.lesson_slot)}<br>First weekly charge: ${esc(day(p.starts_on))}.</p>
      <p>${p.status==='proposed'?'Your agreement is awaiting activation by Daniel. Weekly charges have not started.':p.ends_before?`No new weekly charges from ${esc(day(p.ends_before))}.`:'Your weekly place is active. The fee continues when your child cannot attend.'}</p>
      ${p.review_required?'<p role="alert">Your cooling off cancellation has been recorded. Daniel will review any proportionate final charge and arrange a refund or credit where due. The balance below is awaiting that review.</p>':''}
      <p>If Daniel cancels and no replacement is agreed, that week is not charged. Tell Daniel if a waiver is missing.</p>
      ${w.entries.length?`<details><summary>Weekly charges and payment coverage</summary><p>Payments cover the oldest charges first. Future charges are scheduled and are not included in the current balance.</p><div style="overflow-x:auto"><table><thead><tr><th>Date</th><th>Charge</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div></details>`:''}
      <details style="margin-top:18px"><summary>Payments received</summary>${w.payments.length?w.payments.map(r=>`<p>${esc(day(r.date_paid))}: ${esc(money(r.amount))}</p>`).join(''):'<p>No payments recorded yet.</p>'}</details>
      <p>You can set up a weekly bank standing order using the details Daniel supplies. Accepting this agreement does not set up an automatic payment.</p>
      ${a && p.status!=='ended' && !p.end_requested_at && !p.ends_before?`<div class="actions">${button('weekly-end',`Give ${p.notice_days} days' notice to end tuition`)}${cooling?button('weekly-cooling','Cancel within the 14 day cooling off period'):''}</div>`:''}
      <p class="weekly-message" id="weekly-action-message" role="status"></p>
    </section>
    <section class="weekly-card" id="weekly-agreement">
      ${a?`<details id="weekly-agreement-wrap" ${location.hash==='#weekly-agreement'?'open':''}><summary>Your tuition agreement · accepted ${esc(new Date(a.accepted_at).toLocaleDateString('en-GB',{timeZone:'Europe/London'}))}</summary>`:'<h2>Your tuition agreement</h2>'}
      <details ${!a || location.hash==='#weekly-agreement'?'open':''} id="weekly-terms-details"><summary>Read the full agreement</summary><pre class="weekly-terms">${esc(p.terms_text)}</pre></details>
      ${a?`<p><b>Accepted by ${esc(a.signer_name)}</b><br>${esc(new Date(a.accepted_at).toLocaleString('en-GB',{timeZone:'Europe/London'}))}, UK time<br>Terms version ${esc(a.terms_version)}${a.start_early?'<br>Early start expressly requested.':''}</p>`:p.status==='proposed'?`
      <form id="weekly-accept-form"><label>Your full name, as the parent or guardian responsible for payment<input type="text" name="signer_name" required minlength="2" maxlength="150" autocomplete="name"></label>
      <label><input type="checkbox" name="agree" required>I have read and accept this agreement, including £80 every week during school holidays and when my child cannot attend.</label>
      <label><input type="checkbox" name="start_early">If tuition starts within 14 days of my acceptance, I expressly request that early start. I understand I may need to pay a proportionate amount for services supplied if I cancel during the cooling off period.</label>
      <button class="action-btn" type="submit">Accept weekly tuition agreement</button></form><p>This records your name, the time and the exact agreement accepted. Keep your parent link private, as anyone with it can access your account.</p>`:'<p>This proposal is no longer available to accept.</p>'}
      <p id="weekly-accept-message" class="weekly-message" role="status"></p><div class="actions">${button('weekly-print','Print or save agreement')}${button('weekly-download','Download agreement text')}</div>
      ${w.history?.length?`<details><summary>Previous agreements</summary>${w.history.map(h=>`<pre class="weekly-terms">${esc(h.terms_text)}</pre>${h.acceptance?`<p>Accepted by ${esc(h.acceptance.signer_name)} on ${esc(new Date(h.acceptance.accepted_at).toLocaleString('en-GB'))}</p>`:'<p>Not accepted.</p>'}`).join('')}</details>`:''}
      ${a?'</details>':''}
    </section>`;
  };
  window.wireWeekly = function(w, endpoint) {
    if(!w) return;
    const p=w.plan;
    let busy=false;
    async function action(body,target) {
      if(busy) return; busy=true;
      const message=document.getElementById(target);
      document.querySelectorAll('#weekly-agreement button,#weekly-end,#weekly-cooling').forEach(b=>b.disabled=true);
      message.textContent='Saving…';
      try {
        const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,plan_id:p.id})});
        const result=await res.json(); if(!res.ok || !result.ok) throw new Error(result.problem || 'Could not save. Please try again.');
        message.textContent=body.action==='accept'?'Agreement accepted. Refreshing your record…':'Notice recorded. Refreshing your record…';
        location.reload();
      } catch(e) {message.textContent=e.message; document.querySelectorAll('#weekly-agreement button,#weekly-end,#weekly-cooling').forEach(b=>b.disabled=false); busy=false;}
    }
    document.getElementById('weekly-accept-form')?.addEventListener('submit',e=>{
      e.preventDefault(); const f=new FormData(e.currentTarget);
      action({action:'accept',terms_version:p.terms_version,signer_name:f.get('signer_name'),agree:f.has('agree'),start_early:f.has('start_early')},'weekly-accept-message');
    });
    document.getElementById('weekly-end')?.addEventListener('click',()=>{
      if(confirm(`Give ${p.notice_days} calendar days' notice to end weekly tuition? Charges before the end date remain payable. Daniel will see the notice in TutorTally.`)) action({action:'end'},'weekly-action-message');
    });
    document.getElementById('weekly-cooling')?.addEventListener('click',()=>{
      if(confirm('Cancel your agreement under the 14 day cooling off right? Daniel will review any proportionate charge for services already supplied and arrange any refund due.')) action({action:'cooling_off'},'weekly-action-message');
    });
    document.getElementById('weekly-print')?.addEventListener('click',()=>{document.getElementById('weekly-terms-details').open=true;const wrap=document.getElementById('weekly-agreement-wrap');if(wrap)wrap.open=true;window.print()});
    document.getElementById('weekly-download')?.addEventListener('click',()=>{
      const a=w.acceptance;const text=p.terms_text+(a?`\n\nAccepted by: ${a.signer_name}\nAccepted at: ${a.accepted_at}\nEarly start requested: ${a.start_early?'Yes':'No'}`:'\n\nNot yet accepted.');
      const url=URL.createObjectURL(new Blob([text],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='Bower-Maths-weekly-agreement.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
  };
})();
