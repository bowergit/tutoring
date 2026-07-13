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

The WhatsApp buttons currently point to `https://wa.me/` because no direct WhatsApp number was supplied. Replace both links with Daniel's full `wa.me` URL before launch.
