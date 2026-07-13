# Bower Maths Website

Static, mobile-first website for Daniel Bower GCSE Maths Tutoring.

## Files

- `index.html` - homepage
- `404.html` - fallback page
- `styles.css` - full responsive design system
- `robots.txt` and `sitemap.xml` - SEO support files
- `assets/` - optimised WebP assets derived from the supplied PDF

## Local preview

This site has no build step. Open `index.html` directly, or run a small static server:

```powershell
python -m http.server 8788
```

Then visit `http://localhost:8788`.

## Cloudflare Pages

Use these settings:

- Build command: leave blank
- Build output directory: `/`
- Root directory: `/`

## Notes

Booking uses `https://cal.com/bower/maths` and the homepage includes the inline Cal embed at the bottom.

The homepage uses 15 ordered image assets from the source deck in `assets/media/`.
