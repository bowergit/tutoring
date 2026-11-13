// Things that open should glide open, not flick. Shared by the parent page,
// the pupil page and /app so they all move the same way as the tutor app's
// student cards: to the content's real height, .32s, the app's ease curve.
//
//   TTGlide.toggle(el)        show or hide an element that uses the hidden attribute
//   TTGlide.toggle(el, true)  force open (false to force shut)
//   <details>                 every <details> on the page glides by itself
//
// With reduced motion asked for, or no animation API, everything simply opens
// and shuts as it always did. Nothing here can stop a page working.
(function (root) {
  'use strict';
  const MS = 320;
  const EASE = 'cubic-bezier(.4,0,.2,1)';
  const calm = () => {
    try { return root.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };
  const canAnimate = el => !calm() && typeof el.animate === 'function';

  function animateHeight(el, from, to, done) {
    el.getAnimations().forEach(a => a.cancel());
    const a = el.animate([
      { height: from + 'px', overflow: 'hidden', boxSizing: 'border-box' },
      { height: to + 'px', overflow: 'hidden', boxSizing: 'border-box' },
    ], { duration: MS, easing: EASE });
    // A backgrounded tab can hold an animation's finish back indefinitely, and
    // a panel that never finishes closing would stay open. So the end state
    // is applied on a timer too, whichever comes first, and only once.
    let ended = false;
    const end = () => { if (ended) return; ended = true; if (done) done(); };
    a.onfinish = end;
    setTimeout(end, MS + 60);
    return a;
  }

  // The open state is remembered on the element, so a second tap while it is
  // still moving reverses it instead of being read off a half-done animation.
  function isOpen(el) {
    return el.dataset.glide ? el.dataset.glide === 'open' : !el.hidden;
  }

  function toggle(el, show) {
    if (!el) return false;
    if (show === undefined) show = !isOpen(el);
    el.dataset.glide = show ? 'open' : 'shut';
    if (!canAnimate(el)) { el.hidden = !show; return show; }
    if (show) {
      el.hidden = false;
      const to = el.offsetHeight;
      animateHeight(el, 0, to);
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MS, easing: 'ease' });
    } else {
      const from = el.offsetHeight;
      animateHeight(el, from, 0, () => { if (el.dataset.glide === 'shut') el.hidden = true; });
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MS * 0.7, easing: 'ease', fill: 'forwards' })
        .onfinish = function () { this.cancel(); };
    }
    return show;
  }

  // Every <details>: the summary stays put and the rest glides in or out.
  document.addEventListener('click', e => {
    const summary = e.target.closest && e.target.closest('summary');
    const d = summary && summary.parentElement;
    if (!d || d.tagName !== 'DETAILS' || summary !== d.querySelector('summary')) return;
    if (!canAnimate(d)) return;
    e.preventDefault();
    const opening = d.dataset.glide ? d.dataset.glide !== 'open' : !d.open;
    d.dataset.glide = opening ? 'open' : 'shut';
    const from = d.offsetHeight;
    if (opening) {
      d.open = true;
      animateHeight(d, from, d.offsetHeight);
    } else {
      const cs = getComputedStyle(d);
      const to = summary.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
        + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      animateHeight(d, from, to, () => { if (d.dataset.glide === 'shut') d.open = false; });
    }
  });

  root.TTGlide = { toggle };
})(window);
