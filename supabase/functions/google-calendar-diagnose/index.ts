// Retired. This existed only to confirm the Google OAuth secrets had been
// entered correctly during first setup, and reported nothing but presence
// booleans — never a value. That job is long done, so it now answers 410
// rather than staying live as an endpoint nobody maintains.
//
// Safe to delete outright from Supabase → Edge Functions when convenient;
// nothing calls it.
Deno.serve(() =>
  new Response(
    JSON.stringify({ ok: false, problem: 'gone', detail: 'Setup diagnostic, no longer in use.' }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  )
)
