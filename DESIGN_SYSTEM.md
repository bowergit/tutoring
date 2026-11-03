# TutorTally Design System

The rules for how every TutorTally screen looks. Read this before building or
restyling a page. Voice, positioning and logo live in `BRAND.md`.

Visual reference: open `brand/design-system.html` in a browser to see every
token and component in light and dark. Designs are drafted in Paper first, in
the "TutorTally" file, which has these tokens loaded (one page per screen; the
admin page is on "Admin"). Paper can't load General Sans, so mockups use DM
Sans as a stand-in.

## Files

| File | What it holds | Load order |
| --- | --- | --- |
| `tokens.css` | Every colour, type size, space, radius, shadow and easing. The only place values are defined. | 1st, before the page's `<style>` |
| page `<style>` | Layout and anything unique to that page. Uses tokens, never raw hex. | 2nd |
| `ux.css` | Shared components and fixes: focus rings, 44px tap targets, sheets, tool rows, reduced motion. | 3rd, after the page's `<style>` |

```html
<link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="tokens.css?v=X.Y.Z">
<style> /* page layout here */ </style>
<link rel="stylesheet" href="ux.css?v=X.Y.Z">
```

Bump the `?v=` on both links whenever either file changes, or phones keep the old copy.

## Rules

1. **No raw colours in pages.** Write `var(--warn)`, not `#c0362c`. If a token is missing, add it to `tokens.css` with both a light and a dark value.
2. **Brand and status are separate.** Orange means "this is TutorTally" or "tap this". Green, red and gold mean good, bad and waiting. Never use one for the other.
3. **Orange is a fill, not text.** On light backgrounds orange text is `--accent` (`#a15c00`). Blocks use `--accent-fill`, and text on them is `--on-accent` (ink). Never white text on orange.
4. **Every pairing clears 4.5:1.** Check any new combination before using it.
5. **Both themes, always.** Every page follows the phone's light or dark setting through the tokens. Test both.
6. **Phone first.** Most use is a tutor on a phone between lessons. Design at 375px wide, then let it widen. Tap targets at least 44px. Inputs at 16px so iOS doesn't zoom.
7. **Cards are records, not adverts.** Quiet borders, one shadow level (`--sh-2`), no gradients, no decorative illustrations.
8. **Numbers line up.** Money and counts use `font-variant-numeric: tabular-nums`.
9. **Look like a ledger, not a template.** A box is named by its heading, which sits over a double rule (`border-bottom: 3px double var(--line)`), the way a ledger closes a column. No coloured side stripes on cards or alerts, no glowing status dots, no coloured glows, no gradient or shimmering text.
10. **Only money gets a pill.** On a record, the one pill is the money state (Paid up, Owes, Overdue, In credit). Other details (next lesson, year, rate) go on one line of `.meta` text separated by middots.
11. **Show the real thing, not an icon of it.** Marketing pages picture an actual calendar, the dashboard as it really looks, a WhatsApp message or a parent page. No grids of icon tiles, and no small label above a heading.
12. **No tally-mark illustrations.** The tally lives in the logo only. Pictures of the app must look like the app: overview numbers, student cards, one money pill each.
13. **The wordmark stays as it is:** the logo mark, then "Tutor" in ink and "Tally" in `--accent`. Redrawn T's were tried and turned down.

Impeccable (`~/.claude/skills/impeccable`) checks for these tells. Run
`~/.claude/skills/impeccable/scripts/impeccable detect --json <file>` after
changing a page. The stripes on "booked" revenue bars are deliberate: they
separate booked from earned without relying on colour.

## Colour

| Token | Light | Dark | Use for |
| --- | --- | --- | --- |
| `--bg` | `#f7f8f4` | `#101716` | Page ground ("paper") |
| `--bg-tint` | `#ecf4f1` | `#14211f` | Soft mint band behind a section |
| `--card` | `#ffffff` | `#182321` | Cards, sheets, inputs |
| `--card-2` / `--card-3` | `#f5f7f6` / `#edf1ef` | `#1e2a27` / `#26332f` | Nested rows, secondary buttons, hover |
| `--line` / `--line-soft` | `#dfe7e3` / `#edf1ef` | `#30413d` / `#26332f` | Borders and dividers |
| `--ink` | `#15211f` | `#eef8f5` | Main text |
| `--ink-dim` | `#596965` | `#a5b7b1` | Secondary text, labels |
| `--muted` | `#63736d` | `#a2b5ad` | Faintest text (captions, version tag) |
| `--accent` | `#a15c00` | `#ffa500` | Orange text, links, focus outlines |
| `--accent-fill` | `#ffa500` | `#ffa500` | Primary buttons, brand blocks |
| `--on-accent` | `#15211f` | `#15211f` | Text on an orange fill |
| `--accent-light` | `#fff1d9` | `#3a2604` | Orange tint background |
| `--good` / `--good-light` | `#0f7a35` / `#e3f7e9` | `#4ade80` / `#0f2e1a` | Paid up, in credit, connected |
| `--warn` / `--warn-light` | `#c0362c` / `#fdecea` | `#ff8a63` / `#351d15` | Owes, overdue, disconnected |
| `--gold` / `--gold-light` | `#b7791f` / `#fff4d8` | `#e6bd62` / `#302612` | Part paid, waiting |
| `--good-fill` / `--danger-fill` | `#0f7a35` / `#b3261e` | `#157a3c` / `#c0392b` | Solid buttons with white text |

## Type

Font: **General Sans** (`var(--font)`), weights 400, 500, 600 and 700. Headings
are tight (`letter-spacing: -.035em`), and body text is relaxed (`line-height: 1.5`).

| Token | Size | Use for |
| --- | --- | --- |
| `--t-xs` | 12px | Section labels (uppercase, `.075em` tracking), captions |
| `--t-sm` | 14px | Secondary text, list rows |
| `--t-md` | 16px | Body, inputs |
| `--t-lg` | ~20px | Card and sheet titles |
| `--t-xl` | ~26px | Page titles |
| `--t-2xl` | ~35px | The one big number on a screen (balance owed, total this month) |

## Space, radius, depth, motion

- Spacing on a 4px grid: `--s-1` 4, `--s-2` 8, `--s-3` 12, `--s-4` 16, `--s-5` 20, `--s-6` 24, `--s-8` 32, `--s-10` 40.
- Radius: `--r-sm` 10 (pills, small buttons), `--r-md` 14 (buttons, inputs), `--r-lg` 20 (cards), `--r-xl` 28 (sheets, hero blocks).
- Shadow: `--sh-1` resting controls, `--sh-2` cards, `--sh-3` sheets and an opened card. Focus uses `--ring` plus a 2px `--accent` outline.
- Motion: `--ease` for most moves, `--ease-spring` for small confirm pops. Keep it under 0.4s and animate only opacity and transform. `ux.css` turns motion off for people who ask for that.

## Components

These exist in `index.html` and `ux.css`. Reuse the class names on new pages so they behave the same.

- **Card** `.card` › `.card-header` + `.card-body` › `.card-body-inner`. One student or one record. Opens in place.
- **Pill** `.pill.ok` / `.warn` / `.gold` / `.neutral`. Small status label: Paid, Owes £40, Part paid, Free.
- **Button** `.btn`. Variants: `.save` (orange, the main action), `.cancel` / `.edit` / `.more` (quiet, card-2), `.whatsapp` (WhatsApp green, only for opening WhatsApp). One orange button per view.
- **Section label** `.section-label`. Small uppercase heading above a group.
- **Sheet** `.overlay` › `.sheet`, with `.sheet-close`, `h2`, `.field`s and a `.btn-row`. Bottom sheet on phones, centred dialog from 760px.
- **Field** `.field` › `label` + `input`/`select`/`textarea`.
- **Tool row** `.tools-row` with `.tools-icon`, `.tools-row-main`, `.tools-row-sub` and `.tools-chevron`. Settings-style list row; add `.danger` for destructive ones.
- **Attention box** `.attn` (red heading) for things to chase, and `.cand` (orange heading) for calendar events to confirm. Both are plain cards with the double rule under the heading.
- **Meta line** `.status-row .meta`. Quiet record details after the money pill, separated by middots.
- **Empty state** `.empty` with an icon, a `strong` line, and one sentence saying what to do next.
- **Toast** `.toast-in`. Brief confirmation with an Undo where possible.

## Pages and their data

All data comes from Supabase (`tutoring_*` tables, row-level security on
`owner_id`). Parent and pupil pages read through the `student-portal` edge
function, so they never see another family's data.

| Page | Who sees it | Main data |
| --- | --- | --- |
| `index.html` | Tutor dashboard | `tutoring_students`, `tutoring_lessons`, `tutoring_payments`, `tutoring_payment_allocations`, `tutoring_hourly_plans`, `tutoring_weekly_plans`, `tutoring_calendar_candidates`, `tutoring_invoices`, RPC `reallocate_student_payments` |
| `student.html` | Parent page | `student-portal` edge function: lessons, payments, balances, weekly plan and acceptance |
| `lessons.html` | Pupil page | `student-portal` edge function: lessons, notes, past papers, grade boundaries |
| `admin.html` | Owner admin | `admin-portal` edge function. Signups, regulars and the weekly chart are worked out in the page from each account's `joined`, `last_seen` and `lessons_last_30` |
| `app.html` | Marketing / landing | none |
| `privacy.html`, `terms.html`, `weekly-terms.html` | Legal | none |

## Asking Claude to design a page

Paste something like this:

> Redesign `student.html` using `DESIGN_SYSTEM.md` and `tokens.css`. Keep the
> data calls exactly as they are. Only change markup and styles. Use tokens,
> not raw colours, and existing component classes where they fit. It must work
> at 375px and in dark mode. Show me a screenshot of both before you finish.

Good prompts name the page, the person using it, and the one thing they need
to see first. For example: "a parent opening this from WhatsApp wants to know
if they owe anything".

## Social sharing image

`brand/og-image.png` (1200×630) is what shows when a link to tutortally.co.uk or /app is shared on WhatsApp, iMessage, Facebook, LinkedIn or X. Its source is `brand/og-image.html`, which uses the real font and colours. After editing the HTML, re-render the PNG:

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=6000 --screenshot="$(cygpath -w "$PWD/brand/og-image.png")" "file:///$(cygpath -m "$PWD/brand/og-image.html")"
```

Apps cache link previews for days or weeks. To see a new image straight away on Facebook or LinkedIn, paste the link into their sharing debugger; WhatsApp picks it up for newly pasted links.
