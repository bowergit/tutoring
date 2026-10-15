GRANT SELECT ON public.tutoring_portal_views TO authenticated;
CREATE POLICY "tutoring_portal_views_owner_select"
ON public.tutoring_portal_views
FOR SELECT
TO authenticated
USING ((select auth.uid()) = owner_id);