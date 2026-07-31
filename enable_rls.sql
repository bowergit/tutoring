-- =====================================================================
-- APPLIED 31 July 2026. Kept as the record of what was done.
--
-- Locks the tutoring tables to the owner's own accounts.
--
-- Why scope to specific emails rather than "any authenticated user":
-- Supabase allows self-signup through the public API by default. A policy
-- of "authenticated can read" would therefore let anyone who signs up read
-- every student, address and phone number. Pinning it to the owner's
-- addresses means an uninvited account sees nothing at all, whether or not
-- signup ever gets disabled in the dashboard.
--
-- BOTH addresses are listed. The app was signed in as
-- danielbowermagic@gmail.com while daniel.b.bower@gmail.com also exists;
-- pinning to just one would have locked the owner out of his own records.
--
-- The step that actually closed the hole was dropping the pre-existing
-- "Allow all access" policies (see the bottom of this file). RLS was
-- already switched on before any of this, but that one permissive policy
-- meant it granted everyone everything — policies are OR'd, so the most
-- permissive one always wins. Verified afterwards: anonymous reads return
-- [] on every table and an anonymous insert returns HTTP 401.
--
-- The Edge Functions (monzo-*) and both Apps Scripts authenticate with the
-- service_role key, which bypasses RLS entirely, so none of them are
-- affected. Both were re-tested after applying this and still work.
-- =====================================================================

CREATE OR REPLACE FUNCTION is_app_owner()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(auth.jwt() ->> 'email', '') IN (
    'daniel.b.bower@gmail.com',
    'danielbowermagic@gmail.com'
  );
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tutoring_students',
    'tutoring_lessons',
    'tutoring_payments',
    'tutoring_bundles',
    'tutoring_rate_history',
    'tutoring_payment_allocations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS owner_all ON %I', t);
    EXECUTE format(
      'CREATE POLICY owner_all ON %I FOR ALL USING (is_app_owner()) WITH CHECK (is_app_owner())',
      t
    );
  END LOOP;
END $$;

-- The part that actually mattered. Without this, everything above is
-- decoration: "Allow all access" existed on students, lessons, payments,
-- bundles, rate_history and monzo_transactions, and being permissive it
-- overrode owner_all entirely.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.relname AS tbl, p.polname AS pol
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname LIKE 'tutoring_%'
      AND p.polname <> 'owner_all'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I', r.pol, r.tbl);
    RAISE NOTICE 'Dropped policy % on %', r.pol, r.tbl;
  END LOOP;
END $$;

-- Confirm: every table below should report rowsecurity = true and one policy.
SELECT c.relname AS table_name,
       c.relrowsecurity AS rls_on,
       count(p.polname) AS policies
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy p ON p.polrelid = c.oid
WHERE n.nspname = 'public' AND c.relname LIKE 'tutoring_%'
GROUP BY c.relname, c.relrowsecurity
ORDER BY c.relname;
