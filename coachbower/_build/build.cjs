// Builds the Coach Bower site. From the site folder: node _build/build.cjs .
const fs = require('fs'), path = require('path');
const OUT = process.argv[2];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CDN = 'https://images.squarespace-cdn.com/content/v1/68fa82f82b10be7cb6dc64e7/';
const posts = [...require('./b1.json').items, ...require('./b2.json').items];

const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSeU5Xqlp-58a1vbCDlHdVgx2WCCNC6cJxrCnIvTSO7KX7pULQ/viewform?usp=header';
const GUIDE = 'https://mailchi.mp/ef797684fddb/k6buj1r2nk';
const IG = 'https://www.instagram.com/coachbower_/';
const EMAIL = 'hello@coachbower.com';
const ext = 'target="_blank" rel="noopener"';

// ---------- images ----------
const downloads = [];
function img(url, name, width) {
  downloads.push({ url: url + (width ? (url.includes('?') ? '&' : '?') + 'format=' + width + 'w' : ''), name });
  return 'img/' + name;
}
const LOGO = img(CDN + '6838fbd9-74ac-41ff-ba50-e9b6d3f37fc9/LOGOS+%282%29.png', 'logo.png', 750);
const HERO = img(CDN + 'e2aeec45-a4f2-4252-9e85-6ad2c71480dd/ChatGPT+Image+Dec+1%2C+2025%2C+02_01_34+PM.png', 'hero.jpg', 2500);
const HEADSHOT = img(CDN + '1edb1d5c-6ccb-4b69-91a5-9a0bfd96abab/coach+bower+headshot.jpg', 'headshot.jpg', 1500);
const COACHING = img(CDN + '3591a1a2-b71d-4ad0-b1e5-8e2045ff640b/IMG_2679.png', 'coaching.jpg', 1500);
const INSTA = ['1781210367164-EJ343FQI36DEP803BC46', '1781194839987-K70VSI7YN7CWBASV4A1Q', '1781109806573-75WCBZOJ1BQ7L4PXXG0D',
  '1781023503315-HES6P68KGWMW98Y1ZV8Y', '1780953717954-WCK2ROSGGDCG6REOT7J5', '1780938565800-21FYQVR745ITHD6D9Z6F']
  .map((id, i) => img(CDN + id + '/image-asset.jpeg', `insta-${i + 1}.jpg`, 750));

const FOCUS = { headshot: '50% 10%', coaching: '50% 62%', howard: '50% 25%', 'josee-anne': '50% 40%', richard: '50% 22%', pam: '50% 18%', fady: '50% 24%', gino: '50% 12%' };
const fp = p => { const k = p.split('/').pop().replace(/.jpg$/, ''); return FOCUS[k] ? ` style="object-position:${FOCUS[k]}"` : ''; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- icons (one stroke family, 24 grid, 1.75 stroke) ----------
const ic = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const I = {
  arrow: ic('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  chev: ic('<path d="M6 9l6 6 6-6"/>'),
  check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  mail: ic('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>'),
  insta: ic('<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r=".6" fill="currentColor"/>'),
  pin: ic('<path d="M12 21s-7-6.2-7-11.5a7 7 0 0114 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  play: ic('<circle cx="12" cy="12" r="9"/><path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="currentColor"/>'),
  doc: ic('<path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'),
  menu: ic('<path d="M4 7h16M4 12h16M4 17h16"/>'),
};
const STAR = '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill="#fbbc04" d="M10 1.5l2.6 5.5 6 .8-4.4 4.1 1.1 5.9L10 14.9l-5.3 2.9 1.1-5.9L1.4 7.8l6-.8z"/></svg>';
const GOOGLE = '<svg class="g" viewBox="0 0 48 48" aria-label="Google"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.6A14.5 14.5 0 0110.5 19.4l-7.9-6.1A24 24 0 000 24c0 3.9.9 7.5 2.7 10.7l7.8-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.2-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';

// ---------- content ----------
const AV = ['ALV-UjVOj1HWeMQcXbIy-e_PI9gwfHg8mhAPsIQhqVRzPrtR7zfXvVc', 'ACg8ocIYyjha_Q9Jv9gGHH3jFDDMhD5pbOVbJjm1rqKQ0FhG9YYq',
  'ALV-UjV1D3FXZyTBFmHbloOHwwchQXrdZSian7z5CUVugDJTVYArdlQ', 'ACg8ocKKH56JE06IiygrW6zNZdYv9YMb5pynvjMaNBc-aoOMZO4j',
  'ACg8ocKBOm33deIeTsNoj74HxoG3WOGp1u7nz-E_knaSkB3DsWGrfA', 'ACg8ocK9GmymYnVttReHZ8qwbTcxnh4nRT8_gl2CeXeO-YPvzJCNeA'];
const avUrl = id => (id.startsWith('ALV') ? 'https://lh3.googleusercontent.com/a-/' : 'https://lh3.googleusercontent.com/a/') + id + '=w120-h120-p-rp-mo-br100';
const REVIEWS = [
  ['Meghane Phillips', 'I have been training with Michael for a couple months now and I have already seen so much improvement! I am a competitive dancer, so I was looking to improve my fitness to be a better performer. However, I have been dealing with shin splints and knee pain. Michael has been amazing at helping me adapt movements and train the right muscles to strengthen my legs. I haven’t had pain training in the past couple of weeks and have finally been able to return to normal movements, like jumping. I know I owe a lot of that to the exercises I did in training, so thank you!'],
  ['Anna Jva', 'I’ve been training with Michael for nearly a year now. He’s helped me significantly with my chronic pain issues, gotten me stronger, feeling better than ever! But the thing I appreciate the most is the care he puts into making sure that, despite my limitations and fluctuating abilities (suspected hEDS), I am able to train pain-free, there is always an alternative available if I cannot do an exercise due to pain, information on how to manage it, tracking and reminders of how far I’d gotten, and just a very good, kind human that I feel absolutely comfortable training with.'],
  ['Lorne Novolker', 'I have been training with Michael for a few years now and my entire family has joined once a week. The workouts are tailored to each of our fitness levels, are at the right intensity levels for everyone, and have encouraged everyone to prioritise our Thursday nights to training with Coach Bower.'],
  ['Sam Chankowsky', 'Coach Bower is the absolute BEST!!! I’ve been training with him for over a year now and am always SO excited for my training sessions. He tailors the workout to your level of comfort and abilities, but still pushes you to work harder and get stronger! He also knows SO much about fitness, injuries, rehabilitation, anatomy, nutrition, etc. I’m always learning and never feel afraid to ask questions. Workouts are always so fun and chill, and have become one of the best parts of my week no doubt.'],
  ['Mbotenayo', 'Our sessions have strengthened my muscles and improved my stability and hip strength, reducing pain. Michael’s attention and corrections during exercises are invaluable. We’ve worked together for months, and the results are clear. Highly recommend!'],
  ['Ryan Riback', 'I’ve been working with Coach Bower for a while now, and he’s truly a game-changer. His personalized workouts are always spot-on, and his wealth of knowledge across all things wellness is truly unmatched. He really cares about you as a person, not just as a client, and knows exactly when to push you to reach your full potential. Training in Krav Maga with him was also a blast, and I’ve learned so much. Scheduling sessions is pain free, and I can confidently say Coach Bower is a trainer for life. Highly recommend!'],
];
// avatars listed in the order they appeared on his site: Meghane, Lorne, Anna, Sam, Mbotenayo, Ryan
const AV_FOR = { 'Meghane Phillips': 0, 'Lorne Novolker': 1, 'Anna Jva': 2, 'Sam Chankowsky': 3, 'Mbotenayo': 4, 'Ryan Riback': 5 };
const avatarPath = {};
for (const [n, i] of Object.entries(AV_FOR)) avatarPath[n] = img(avUrl(AV[i]), `review-${i + 1}.jpg`);

function reviewCard([name, text], r) {
  const long = text.length > 260;
  return `<figure class="review">
  <header><img src="${r}${avatarPath[name]}" alt="" width="40" height="40" loading="lazy"><div><figcaption>${esc(name)}</figcaption><div class="stars" role="img" aria-label="5 out of 5 stars">${STAR.repeat(5)}</div></div>${GOOGLE}</header>
  <blockquote${long ? ' class="clamp"' : ''}>${esc(text)}</blockquote>${long ? '<button class="more" type="button" aria-expanded="false">Read more</button>' : ''}
</figure>`;
}

const FAQS = [
  ['Do I need to be pain-free to start?', ['No. And that’s exactly why this approach exists.', 'Many clients begin while dealing with pain or limitations. We use a structured, progressive system to rebuild strength, resilience and confidence starting from where you are right now.']],
  ['What makes your approach different from a physio or a typical trainer?', ['Physios tend to be great at getting you out of pain. And trainers tend to be great at building overall fitness.', 'Now this isn’t the rule across the board, but often times, one lacks experience with the other. For example, physios may lack the late-stage performance side of things, and trainers may lack the skillset to competently work with clients in pain.', 'I bridge the gap between the two, integrating rehab principles with performance training.']],
  ['Do you work with people who aren’t in pain?', ['Yes. Many of my clients approached me either with other goals in mind, or they WERE in pain and no longer are but continue to work with me.', 'They all have one thing in common though: they’re in it for the long run. They view training as an investment in their health, not a quick fix. So if you align with that, we’d probably make a great team!']],
  ['What equipment do I need for online coaching?', ['Whatever you have access to.', 'Your program is designed around your setup. For some of my clients, that’s their local gym. And for many, it’s a home space with just the basics. If you’re missing anything essential, I’ll guide you on simple, affordable ways to fill the gaps.']],
  ['What’s the difference between online coaching and the premade programs?', ['Premade programs are structured templates made to suit most people. I’ve spent hours designing them to be not only straightforward to complete, but brutally effective as well. They’re ideal if you want a proven system to follow on your own.', 'Online coaching is a premium coaching service built specifically with you in mind. Your goals, injury history, preferences etc.', 'Put simply: programs give you the map; coaching helps you navigate it.']],
];

const STORIES = [
  ['Howard', 'From back surgery to pull-ups', CDN + '56538480-c964-4f12-b035-abe6e07e6c8c/Howard+M.jpeg', 'howard.jpg', 'he',
    ['Howard started training with me after he’d undergone back surgery and had stopped strength training entirely as a result. This, plus a previous bad experience with a trainer, left him feeling unfit and fearful of any movements that actually involved his back.'],
    ['Found safe, pain-free entry points to movement. Things that didn’t recreate pain.', 'Stuck with those same movements for several months, and got really good at them.', 'As he got stronger, new pain-free movements started to reveal themselves.'],
    ['A few weeks ago, Howard demonstrated one of the most prime examples of back strength: the pull-up. He’s also stronger in all lifts, has lost 15lbs (by accident!) and for the first time in a long time is lifting weights without fear.'],
    ['Watch Howard’s progress', 'https://www.instagram.com/reel/DRS28nyDVFH/']],
  ['Josee-Anne', 'Running without pain, and loving it again', CDN + '63554f0c-3bd7-474d-a0cb-e7f3b667f0f1/13BF969E-856C-4145-9476-436B951E9752_L0_001-2025-12-23%2C+10_21_50+AM.jpg', 'josee-anne.jpg', 'she',
    ['Josee-Anne was running 30–45km a week and strength training 3x a week. She prepped her meals and took really good care of her body. On paper, she was doing everything right. But she was still dealing with lower back tightness and deep hip pain after long distances.'],
    ['Modified her total training load.', 'Addressed her strength deficits.', 'Integrated rehab into her already busy program.', 'Tweaked nutrition so she was fuelling like an athlete.'],
    ['Josee-Anne now runs consistently without pain, which she recently told me has restored her LOVE for training. Strength work actually feels supportive of her goals, not stealing from them. She’s also entering this off-season with eyes on her next half- and full-marathon PRs!'],
    null],
  ['Richard', 'Feels like an athlete again', CDN + '7d9cedeb-d9c8-4516-ac9a-906d7ae2f496/6B648000-AFCA-45FD-98C9-1F2209129D93_L0_001-2025-12-25%2C+10_04_59+AM.jpg', 'richard.jpg', 'he',
    ['Richard started working with me online with a history of ankle sprains, Achilles tendinopathy, repeat hamstring pulls, groin strains, tight hips and chronic low back pain. As an athlete, he found himself sidelined from the sports he loved.'],
    ['Improved hip function through mobility and strength work.', 'Followed a program I designed specifically for him, and stuck with it month after month.', 'Built strong feet, ankles and Achilles that would translate perfectly to running.'],
    ['Richard can now run completely pain-free. His hips are the best they’ve ever felt, and he feels like an athlete again.'],
    ['Hear it from Richard', 'https://www.instagram.com/p/DU01PxwgHRV/']],
  ['Pam', 'Pain down 90%, back to surgical work', CDN + 'f94fde68-1c93-46cc-9793-d3f3e5dc56e2/pam.jpg', 'pam.jpg', 'she',
    ['Pam’s a surgical nurse, which I think is pretty cool. She often performs 12-hour procedures that require her to hold seriously heavy equipment for extended periods. It started taking a huge toll on her body: low back, neck and shoulder pain that got so bad it started to affect her vision. She realised she had to take control of the situation, or risk being unable to work.'],
    ['Focussed on finding tolerable movements that didn’t recreate symptoms.', 'Learned ways of self-managing pain when she was on her own.', 'Didn’t miss a session for months on end (this is key).'],
    ['Pam recently told me her pain has improved 90%. She feels confident performing her surgical work without physical limitations, and she’s also dropped 2 dress sizes. Awesome result.'],
    ['Hear it from Pam', 'https://www.instagram.com/reel/DJ6-AqEozjg/']],
  ['Fady', 'Ten years of ankle pain, stronger into surgery', CDN + '5c9a67db-6b47-4960-a4d3-63aa4b3d2284/IMG_5613.png', 'fady.jpg', 'he',
    ['Fady had been dealing with daily chronic ankle pain for over 10 years. When he’d try to play soccer or go for a jog, he’d pay for it for days afterwards. He told me he was questioning not only his quality of life, but his entire future as an active adult. He booked a reconstructive surgery to get back to what he loves without the constant backdrop of pain.', 'Our goal was simple: prepare him for surgery by making his lower body as strong as possible.'],
    ['Refined basic foot mechanics.', 'Increased strength and stability of the surrounding tissues.', 'Improved tendon function through plyometric training.'],
    ['Fady can load his ankle with a big improvement in pain levels, and he’s going into surgery from a much higher starting point than he would have otherwise. He told me that seeing what his ankle is capable of has made him confident about his recovery after the operation.'],
    ['Watch our approach', 'https://www.instagram.com/reel/DR496qNAF4V/']],
  ['Gino', '18 holes, totally pain-free', CDN + 'ba53e771-6fc1-4ad7-9bd2-9697f68cd55c/gino.jpg', 'gino.jpg', 'he',
    ['Gino works in construction and was dealing with chronic shoulder pain for years after a work-related injury.'],
    ['Addressed mobility of his shoulder and mid-back, to reduce movement restrictions.', 'Got really strong in a couple of pain-free movements.', 'Learned that pain is a signal, not a sentence!'],
    ['Gino just played 18 holes at the golf club, totally pain-free. He’s also slamming med balls and lifting dumbbells every week. It’s not magic: it’s science, some good coaching, and a whole lotta hard work on his part.'],
    ['Watch Gino’s big win', 'https://www.instagram.com/reel/DLDcdwNRIUN/']],
].map(s => ({ name: s[0], outcome: s[1], photo: img(s[2], s[3], 1200), slug: s[3].replace('.jpg', ''), pron: s[4], start: s[5], did: s[6], now: s[7], link: s[8] }));

// ---------- blog ----------
function cleanBody(html) {
  let h = html;
  h = h.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  h = h.replace(/<figure[\s\S]*?<\/figure>/g, '').replace(/<img[^>]*>/g, '');
  h = h.replace(/<\/?(div|span|u)[^>]*>/g, '');
  h = h.replace(/<(p|h[1-6]|strong|em|ul|ol|li|blockquote)\b[^>]*>/g, '<$1>');
  h = h.replace(/<a\b[^>]*?href="([^"]*)"[^>]*>/g, (m, href) => {
    href = href.replace(/&amp;/g, '&');
    const internal = href.match(/^(?:https?:\/\/(?:www\.)?coachbower\.com)?\/blog\/([^/?#]+)/);
    if (internal) return `<a href="../${slugify(internal[1])}/">`;
    if (/^(https?:\/\/(?:www\.)?coachbower\.com)?\/?$/.test(href)) return '<a href="../../">';
    if (/^(https?:\/\/(?:www\.)?coachbower\.com)?\/client-stories/.test(href)) return '<a href="../../client-stories/">';
    return `<a href="${esc(href)}" ${ext}>`;
  });
  h = h.replace(/<p>\s*(<br>)?\s*<\/p>/g, '').replace(/(<br>\s*)+<\/p>/g, '</p>');
  // headings inside posts become h2 (page h1 is the title)
  h = h.replace(/<(\/?)h[1-4]>/g, '<$1h2>');
  // a paragraph of only dashes is a divider
  h = h.replace(/<p>[—–\-]{3,}\s*<\/p>/g, '<hr>');
  return h.replace(/\n\s*\n/g, '\n').trim();
}
const slugify = s => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/nbsp$/, '').replace(/-$/, '');
const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const sentence = t => { t = t.replace(/&nbsp;/g, ' ').trim(); return t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t; };
const blog = posts.map(p => {
  const text = (p.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return { p, slug: slugify(p.urlId), title: sentence(p.title), date: fmtDate(p.publishOn), iso: new Date(p.publishOn).toISOString().slice(0, 10),
    excerpt: (p.excerpt || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim(), body: text, mins: Math.max(2, Math.round(text.split(' ').length / 230)) };
});

// ---------- layout ----------
function page({ title, desc, depth, active, body, bodyClass = '' }) {
  const r = '../'.repeat(depth);
  const cur = k => (k === active ? ' aria-current="page"' : '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#141414">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${r}${HERO}">
<link rel="icon" href="${r}${LOGO}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${r}style.css">
</head>
<body class="${bodyClass}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="${r || './'}" aria-label="Coach Michael Bower, home"><img src="${r}${LOGO}" alt="" width="132" height="53"></a>
    <button class="menu-btn" type="button" aria-expanded="false" aria-controls="nav">${I.menu}<span>Menu</span></button>
    <nav id="nav" class="nav" aria-label="Main">
      <a href="${r || './'}"${cur('home')}>Home</a>
      <a href="${r}client-stories/"${cur('stories')}>Client stories</a>
      <div class="drop">
        <button type="button" class="drop-btn" aria-expanded="false"${active === 'blog' ? ' data-current' : ''}>Helpful resources ${I.chev}</button>
        <div class="drop-menu">
          <a href="${r}blog/"${cur('blog')}><strong>Blog</strong><span>A new article on training and health every week</span></a>
          <a href="${GUIDE}" ${ext}><strong>12 Essential Isometrics for Runners</strong><span>Free guide, sent straight to your inbox</span></a>
        </div>
      </div>
      <a class="btn btn-sm" href="${FORM}" ${ext}>Get in touch</a>
    </nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap foot">
    <div class="foot-news">
      <h2>Get the weekly article</h2>
      <p>Once a week I sit down with a coffee (and my dog) and write about training and health. Sign up and it lands straight in your inbox, along with my free guide to 12 essential isometrics for runners.</p>
      <a class="btn" href="${GUIDE}" ${ext}>Subscribe ${I.arrow}</a>
    </div>
    <div class="foot-cols">
      <div>
        <h3>Explore</h3>
        <a href="${r || './'}">Home</a>
        <a href="${r}client-stories/">Client stories</a>
        <a href="${r}blog/">Blog</a>
        <a href="${GUIDE}" ${ext}>Free isometrics guide</a>
      </div>
      <div>
        <h3>Contact</h3>
        <a href="mailto:${EMAIL}">${I.mail}${EMAIL}</a>
        <a href="${IG}" ${ext}>${I.insta}@coachbower_</a>
        <p>${I.pin}In-person sessions in Montreal.<br>Online coaching anywhere.</p>
      </div>
    </div>
  </div>
  <div class="wrap fine"><img src="${r}${LOGO}" alt="Coach Michael Bower" width="110" height="44"><span>© ${new Date().getFullYear()} Coach Michael Bower</span></div>
</footer>
<script>
(function(){
  var b=document.querySelector('.menu-btn'),n=document.getElementById('nav');
  b.addEventListener('click',function(){var o=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!o));n.classList.toggle('open',!o);});
  document.querySelectorAll('.drop-btn').forEach(function(d){
    d.addEventListener('click',function(e){e.stopPropagation();var o=d.getAttribute('aria-expanded')==='true';d.setAttribute('aria-expanded',String(!o));});
  });
  document.addEventListener('click',function(e){document.querySelectorAll('.drop-btn[aria-expanded=true]').forEach(function(d){if(!d.parentNode.contains(e.target))d.setAttribute('aria-expanded','false');});});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')document.querySelectorAll('.drop-btn[aria-expanded=true]').forEach(function(d){d.setAttribute('aria-expanded','false');d.focus();});});
  document.querySelectorAll('.review .more').forEach(function(m){m.addEventListener('click',function(){var q=m.previousElementSibling,o=q.classList.toggle('open');m.setAttribute('aria-expanded',String(o));m.textContent=o?'Show less':'Read more';});});
  var g=document.querySelector('.gap');
  if(g&&'IntersectionObserver' in window&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
    g.classList.add('armed');
    new IntersectionObserver(function(es,o){es.forEach(function(x){if(x.isIntersecting){g.classList.add('lit');o.disconnect();}});},{threshold:.45}).observe(g);
  }
})();
</script>
</body>
</html>
`;
}

const cta = (r, h, p) => `
<section class="cta">
  <div class="wrap cta-inner">
    <div>
      <h2>${h}</h2>
      <p>${p}</p>
    </div>
    <div class="cta-actions">
      <a class="btn btn-light btn-lg" href="${FORM}" ${ext}>Get in touch ${I.arrow}</a>
      <a class="cta-mail" href="mailto:${EMAIL}">or email ${EMAIL}</a>
    </div>
  </div>
</section>`;

// ---------- home ----------
const ACTIVITIES = ['Running half-marathons', 'Hitting 18 holes on a weekend', 'Playing in a local hockey league', 'Walking the dog', 'Carrying the groceries', 'Living without restriction'];
const home = page({
  title: 'Coach Michael Bower | Rehab & strength coaching in Montreal',
  desc: 'Rehab and strength coaching in Montreal and online. Bridging the gap between injury rehabilitation and personal training, without the fluff.',
  depth: 0, active: 'home', bodyClass: 'home',
  body: `
<section class="hero">
  <img class="hero-img" src="${HERO}" alt="" fetchpriority="high">
  <div class="wrap hero-inner">
    <h1>Rehab &amp; strength coaching <em>without the fluff</em></h1>
    <p class="hero-lead">I help adults who’ve been sidelined by pain get back to the things that make life meaningful. In person in Montreal, or online wherever you are.</p>
    <div class="hero-actions">
      <a class="btn btn-lg" href="${FORM}" ${ext}>Get in touch ${I.arrow}</a>
      <a class="btn btn-ghost btn-lg" href="client-stories/">See client stories</a>
    </div>
    <ul class="hero-proof">
      <li><span class="stars-inline" role="img" aria-label="5 stars">${STAR.repeat(5)}</span> Five-star Google reviews</li>
      <li>Sport Science &amp; Physiology background</li>
      <li>Nearly 10 years coaching</li>
    </ul>
  </div>
</section>

<section class="sec gap-sec">
  <div class="wrap">
    <div class="sec-head">
      <h2>The gap between physio and the gym</h2>
      <p>Physio is great at getting you out of pain. Trainers are great at building fitness. Too often you get one without the other, and end up stuck in between.</p>
    </div>
    <div class="gap" role="img" aria-label="Physio gets you out of pain, personal training builds fitness, and Coach Bower bridges the gap between them.">
      <div class="gap-end"><h3>Physio</h3><p>Gets you out of pain, but can stop short of rebuilding strength and confidence.</p></div>
      <div class="gap-mid"><div class="gap-track"><span></span></div><h3>Rehab + strength</h3><p>Rehab principles built into real performance training, so you get out of pain <em>and</em> keep getting stronger.</p></div>
      <div class="gap-end"><h3>Personal training</h3><p>Builds fitness, but often without the skillset to work with someone in pain.</p></div>
    </div>
  </div>
</section>

<section class="sec about">
  <div class="wrap about-grid">
    <figure class="about-photo"><img src="${HEADSHOT}" alt="Coach Michael Bower" loading="lazy"${fp(HEADSHOT)}></figure>
    <div class="about-copy">
      <h2>Hey! I’m Michael</h2>
      <p class="big">I’m a trainer who specialises in coaching adults who’ve found themselves sidelined from the activities they love because of pain.</p>
      <p>You might be skeptical about working with a trainer. Or maybe those recurring physio appointments help in the short term, but don’t seem to be moving the needle. Totally understandable.</p>
      <p>With an academic background in Sport Science &amp; Physiology and nearly 10 years of coaching, I combine performance training with injury rehab to get you back to what you love, without the backdrop of pain.</p>
      <h3 class="athletes-h">Athletes of life, if you will</h3>
      <ul class="athletes">${ACTIVITIES.map(a => `<li>${a}</li>`).join('')}</ul>
      <p class="sign">Talk soon,<br><strong>Michael</strong></p>
    </div>
  </div>
</section>

<section class="sec dark">
  <div class="wrap">
    <div class="sec-head">
      <h2>How I can help</h2>
      <p>Not sure which fits? Just say so when you get in touch and we’ll figure it out together.</p>
    </div>
    <div class="offers">
      <article class="offer offer-main">
        <img src="${COACHING}" alt="Michael coaching a client in the gym" loading="lazy"${fp(COACHING)}>
        <div class="offer-body">
          <h3>In-person coaching <span>Montreal</span></h3>
          <p>Hands-on coaching in the gym with me. For you if:</p>
          <ul class="ticks">
            <li>${I.check}You want a more hands-on coaching style</li>
            <li>${I.check}You’re pretty new to strength training</li>
            <li>${I.check}You value the accountability of having someone in the gym with you</li>
            <li>${I.check}You can commit to a regular, consistent schedule</li>
          </ul>
          <a class="btn" href="${FORM}" ${ext}>Ask about in-person ${I.arrow}</a>
        </div>
      </article>
      <article class="offer">
        <div class="offer-body">
          <h3>Online coaching <span>Anywhere</span></h3>
          <p>A program built around you, your setup and your injury history. For you if:</p>
          <ul class="ticks">
            <li>${I.check}You’d rather train at your own gym or at home</li>
            <li>${I.check}You want guidance and support to execute on your own</li>
            <li>${I.check}You’re a keen learner, communicate well and can follow a program</li>
            <li>${I.check}Your schedule is less flexible, or you’re not near Montreal</li>
          </ul>
          <a class="btn btn-ghost" href="${FORM}" ${ext}>Ask about online ${I.arrow}</a>
        </div>
      </article>
    </div>
  </div>
</section>

<section class="sec">
  <div class="wrap">
    <div class="sec-head row">
      <h2>Real people, back to it</h2>
      <a class="more-link" href="client-stories/">All client stories ${I.arrow}</a>
    </div>
    <div class="story-strip">
      ${STORIES.slice(0, 4).map(s => `<a class="story-tile" href="client-stories/#${s.slug}">
        <img src="${s.photo}" alt="${esc(s.name)}" loading="lazy"${fp(s.photo)}>
        <div><strong>${esc(s.name)}</strong><span>${esc(s.outcome)}</span></div>
      </a>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="sec tint">
  <div class="wrap">
    <div class="sec-head">
      <h2>What clients say</h2>
    </div>
    <div class="reviews">
      ${REVIEWS.slice(0, 3).map(rv => reviewCard(rv, '')).join('\n      ')}
    </div>
  </div>
</section>

<section class="sec">
  <div class="wrap faq-grid">
    <div class="sec-head">
      <h2>FAQs</h2>
      <p>Anything else? <a href="mailto:${EMAIL}">Email me</a>, I’m happy to help.</p>
    </div>
    <div class="faqs">
      ${FAQS.map(([q, a]) => `<details><summary>${esc(q)}${I.chev}</summary><div>${a.map(p => `<p>${esc(p)}</p>`).join('')}</div></details>`).join('\n      ')}
    </div>
  </div>
</section>

<section class="sec insta-sec">
  <div class="wrap">
    <div class="sec-head row">
      <h2>On Instagram</h2>
      <a class="more-link" href="${IG}" ${ext}>${I.insta}@coachbower_</a>
    </div>
    <div class="insta">
      ${INSTA.map(p => `<a href="${IG}" ${ext} aria-label="Instagram post on @coachbower_"><img src="${p}" alt="" loading="lazy"${fp(p)}></a>`).join('\n      ')}
    </div>
  </div>
</section>
${cta('', 'Could we be a good fit?', 'Fill out a few details and I’ll reach out soon to set up a chat.')}
`});

// ---------- client stories ----------
const stories = page({
  title: 'Client stories | Coach Michael Bower',
  desc: 'Real client transformations: back pain, shoulder pain, ankle pain and running injuries, and what we did about them.',
  depth: 1, active: 'stories',
  body: `
<section class="page-hero">
  <div class="wrap">
    <h1>Client stories</h1>
    <p class="lead">Some of the transformations that remind me why I love what I do.</p>
    <nav class="jump" aria-label="Stories">${STORIES.map(s => `<a href="#${s.slug}">${esc(s.name)}</a>`).join('')}</nav>
  </div>
</section>
${STORIES.map((s, i) => `
<article class="sec story${i % 2 ? ' tint' : ''}" id="${s.slug}">
  <div class="wrap story-grid${i % 2 ? ' flip' : ''}">
    <figure class="story-photo"><img src="../${s.photo}" alt="${esc(s.name)}" loading="lazy"${fp(s.photo)}></figure>
    <div class="story-copy">
      <h2>${esc(s.name)}</h2>
      <p class="story-outcome">${esc(s.outcome)}</p>
      <div class="story-steps">
        <section><h3>Where ${s.pron} started</h3>${s.start.map(p => `<p>${esc(p)}</p>`).join('')}</section>
        <section><h3>What we did</h3><ul class="ticks">${s.did.map(d => `<li>${I.check}${esc(d)}</li>`).join('')}</ul></section>
        <section class="now"><h3>Where ${s.pron} is now</h3>${s.now.map(p => `<p>${esc(p)}</p>`).join('')}</section>
      </div>
      ${s.link ? `<a class="video-link" href="${s.link[1]}" ${ext}>${I.play}${esc(s.link[0])} on Instagram</a>` : ''}
    </div>
  </div>
</article>`).join('')}

<section class="sec dark">
  <div class="wrap">
    <div class="sec-head"><h2>Google reviews</h2></div>
    <div class="reviews">
      ${REVIEWS.map(rv => reviewCard(rv, '../')).join('\n      ')}
    </div>
  </div>
</section>
${cta('../', 'Want to be the next story?', 'Fill out a few details and I’ll be in touch shortly. I can’t wait to hear from you!')}
`});

// ---------- blog index ----------
const norm = t => t.toLowerCase().replace(/&[a-z#0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
for (const b of blog) b.dupe = !!b.excerpt && norm(b.body).startsWith(norm(b.excerpt).slice(0, 60));
const [lead, ...rest] = blog;
const blogIndex = page({
  title: 'Blog | Coach Michael Bower',
  desc: 'Weekly articles on strength training, rehab, pain, running and health from Coach Michael Bower.',
  depth: 1, active: 'blog',
  body: `
<section class="page-hero">
  <div class="wrap">
    <h1>The blog</h1>
    <p class="lead">One article a week on training, pain and health. Written with a coffee, and usually a dog on my feet.</p>
  </div>
</section>
<section class="sec blog-sec">
  <div class="wrap blog-layout">
    <div>
      <a class="post-lead" href="${lead.slug}/">
        <p class="meta"><time datetime="${lead.iso}">${lead.date}</time> · ${lead.mins} min read</p>
        <h2>${esc(lead.title)}</h2>
        <p>${esc(lead.excerpt)}</p>
        <span class="read">Read the article ${I.arrow}</span>
      </a>
      <ol class="post-list">
        ${rest.map(b => `<li><a href="${b.slug}/">
          <p class="meta"><time datetime="${b.iso}">${b.date}</time> · ${b.mins} min read</p>
          <h2>${esc(b.title)}</h2>
          <p>${esc(b.excerpt)}</p>
        </a></li>`).join('\n        ')}
      </ol>
    </div>
    <aside class="blog-aside">
      <div class="aside-card">
        ${I.doc}
        <h2>Free guide: 12 essential isometrics for runners</h2>
        <p>Runners need to be damn strong. Here’s where to start. Get the guide and the weekly article in your inbox.</p>
        <a class="btn" href="${GUIDE}" ${ext}>Get the free guide</a>
      </div>
      <div class="aside-card plain">
        <h2>Dealing with pain right now?</h2>
        <p>Articles help. A plan built around you helps more.</p>
        <a class="more-link" href="${FORM}" ${ext}>Get in touch ${I.arrow}</a>
      </div>
    </aside>
  </div>
</section>
`});

const postPages = blog.map((b, i) => {
  const older = blog[i + 1], newer = blog[i - 1];
  return [b.slug, page({
    title: `${b.title} | Coach Michael Bower`,
    desc: b.excerpt || b.title,
    depth: 2, active: 'blog', bodyClass: 'reading',
    body: `
<article class="post">
  <header class="post-head wrap">
    <a class="back" href="../">${I.arrow} All articles</a>
    <h1>${esc(b.title)}</h1>
    ${b.excerpt && !b.dupe ? `<p class="lead">${esc(b.excerpt)}</p>` : ''}
    <p class="byline"><img src="../../${HEADSHOT}" alt="" width="44" height="44"><span><strong>Michael Bower</strong><time datetime="${b.iso}">${b.date}</time> · ${b.mins} min read</span></p>
  </header>
  <div class="post-body wrap">
${cleanBody(b.p.body)}
  </div>
  <aside class="post-cta wrap">
    <h2>Want help with this?</h2>
    <p>If you’re dealing with pain or stuck in your training, get in touch and we’ll set up a chat.</p>
    <a class="btn" href="${FORM}" ${ext}>Get in touch ${I.arrow}</a>
  </aside>
  <nav class="post-nav wrap" aria-label="More articles">
    ${older ? `<a href="../${older.slug}/"><span>Previous article</span>${esc(older.title)}</a>` : '<span></span>'}
    ${newer ? `<a class="next" href="../${newer.slug}/"><span>Next article</span>${esc(newer.title)}</a>` : '<span></span>'}
  </nav>
</article>
`})];
});

// ---------- write ----------
fs.rmSync(path.join(OUT, 'blog'), { recursive: true, force: true });
const w = (rel, s) => { const f = path.join(OUT, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
w('index.html', home);
w('client-stories/index.html', stories);
w('blog/index.html', blogIndex);
for (const [slug, html] of postPages) w(`blog/${slug}/index.html`, html);
fs.copyFileSync(path.join(__dirname, 'style.css'), path.join(OUT, 'style.css'));

(async () => {
  const dir = path.join(OUT, 'img');
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(downloads.map(d => d.name));
  for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.rmSync(path.join(dir, f));
  let ok = 0; const bad = [];
  const q = [...downloads];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (q.length) {
      const d = q.shift(), f = path.join(dir, d.name);
      if (fs.existsSync(f)) { ok++; continue; }
      try {
        const res = await fetch(d.url, { headers: { 'User-Agent': UA } });
        if (!res.ok) throw new Error(res.status);
        fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); ok++;
      } catch (e) { bad.push(d.name + ' ' + e.message); }
    }
  }));
  console.log(`pages: ${3 + postPages.length}, images: ${ok}/${downloads.length}`);
  if (bad.length) console.log('FAILED:\n' + bad.join('\n'));
})();
