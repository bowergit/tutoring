-- =====================================================================
-- Locks the tutoring tables to a single signed-in account.
--
-- DO NOT RUN THIS UNTIL YOU HAVE SUCCESSFULLY SIGNED IN TO THE APP.
-- Running it first would leave you locked out of your own records with
-- no way back in through the UI.
--
-- Why scope to one email rather than "any authenticated user": Supabase
-- allows self-signup through the public API by default. A policy of
-- "authenticated can read" would therefore let anyone who signs up read
-- every student, address and phone number. Pinning it to the owner's
-- address means an uninvited account sees nothing at all, whether or not
-- signup ever gets disabled in the dashboard.
--
-- The Edge Functions (monzo-*) and both Apps Scripts authenticate with the
-- service_role key, which bypasses RLS entirely, so none of them are
-- affected by anything below.
-- =====================================================================

CREATE OR REPLACE FUNCTION is_app_owner()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(auth.jwt() ->> 'email', '') = 'daniel.b.bower@gmail.com';
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
