// Sits in front of the parent and pupil pages only. Link-preview crawlers (WhatsApp, iMessage,
// Slack) read the raw HTML and never run the page's script, so the static <title>
// is all they ever see. This looks up the first name behind the link's token and
// writes "[Name]'s Lessons" into the title and og:title before the page is sent.
//
// Anything going wrong (slow lookup, unknown token, any error) falls back to the
// untouched page, so this can only ever improve a link, never break it.
const PREVIEW = 'https://uilytgubukiinyrqrltj.supabase.co/functions/v1/student-preview';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    try {
      const token = new URL(request.url).searchParams.get('t') || '';
      const type = res.headers.get('content-type') || '';
      if (request.method !== 'GET' || res.status !== 200 || !type.includes('text/html') || !UUID.test(token)) return res;

      const lookup = await fetch(`${PREVIEW}?t=${token}`, { signal: AbortSignal.timeout(2000) });
      if (!lookup.ok) return res;
      const { first } = await lookup.json();
      if (!first) return res;

      const title = `${first}'s Lessons`;
      // The pupil's own page never mentions money, so its preview does not either.
      const pupil = /^\/lessons/.test(new URL(request.url).pathname);
      const desc = pupil ? 'Your upcoming lessons.' : 'Upcoming lessons, payments and progress. Private to your family.';
      const out = new HTMLRewriter()
        .on('title', { element(el) { el.setInnerContent(title); } })
        .on('meta[property="og:title"], meta[name="twitter:title"], meta[property="og:description"], meta[property="og:image"], meta[property="og:site_name"]', { element(el) { el.remove(); } })
        .on('head', {
          element(el) {
            el.append(
              `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${new URL('/icon-512.png', request.url)}"><meta property="og:site_name" content="TutorTally"><meta name="twitter:title" content="${esc(title)}">`,
              { html: true },
            );
          },
        })
        .transform(res);
      const headers = new Headers(out.headers);
      headers.set('Cache-Control', 'no-cache');
      headers.set('X-Preview-Title', '1');
      return new Response(out.body, { status: out.status, headers });
    } catch {
      return res;
    }
  },
};
