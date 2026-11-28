-- ddl-brand: serve the brand app from Supabase instead of Notion.
-- Apply once in the Supabase SQL editor (project ddl) BEFORE deploying this app.
-- Safe to re-run. This file does not insert or delete rows.
--
-- Other apps' tables (official site, Hermes, household books, company calendar)
-- are intentionally left alone.
--
-- The notion schema stays off the Data API exposed-schema list. The Vercel
-- function uses public views (security_invoker) with the service role.
-- RLS stays enabled with no policy for anon/authenticated, so those roles see
-- nothing. brand_realtime is a NOLOGIN role used only by a short-lived JWT
-- the server signs. Its SELECT policies are scoped by JWT claims.

GRANT USAGE ON SCHEMA notion TO service_role;

DO $$
DECLARE
  t text;
  vname text;
  tables text[] := ARRAY[
    'content_calendar',
    'weekly_plan',
    'sales',
    'products',
    'content_plans',
    'costs',
    'action_plan',
    'app_settings',
    'references',
    'threads_performance',
    'daily_sales',
    'oem_inquiries_yj',
    'visit_stats_yj'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('ALTER TABLE notion.%I ALTER COLUMN notion_page_id SET DEFAULT gen_random_uuid()', t);
    EXECUTE format('ALTER TABLE notion.%I ALTER COLUMN created_time SET DEFAULT now()', t);
    EXECUTE format('ALTER TABLE notion.%I ALTER COLUMN last_edited_time SET DEFAULT now()', t);
    EXECUTE format('ALTER TABLE notion.%I ADD COLUMN IF NOT EXISTS deleted_at timestamptz', t);
    EXECUTE format('COMMENT ON COLUMN notion.%I.deleted_at IS %L', t,
      'Set by the brand API instead of DELETE. NULL means the row is still visible.');
    EXECUTE format('ALTER TABLE notion.%I REPLICA IDENTITY FULL', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON notion.%I (last_edited_time) WHERE deleted_at IS NULL',
      t || '_edited_idx', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notion.%I TO service_role', t);

    vname := CASE
      WHEN t = 'references' THEN 'brand_references'
      ELSE t
    END;
    EXECUTE format(
      'CREATE OR REPLACE VIEW public.%I WITH (security_invoker = true) AS SELECT * FROM notion.%I',
      vname, t);
    EXECUTE format('COMMENT ON VIEW public.%I IS %L', vname,
      'ddl-brand service_role view. security_invoker so RLS still applies. Do not grant to anon.');
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', vname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', vname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS content_calendar_active_brand_idx
  ON notion.content_calendar ("브랜드")
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS weekly_plan_active_brand_idx
  ON notion.weekly_plan (brand)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS app_settings_item_idx
  ON notion.app_settings ("항목")
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS daily_sales_brand_day_idx
  ON notion.daily_sales ("브랜드", "날짜_start")
  WHERE deleted_at IS NULL;

-- Read-only realtime role. The server mints a 5-minute HS256 JWT whose role
-- claim is brand_realtime. anon and authenticated are not granted these tables.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brand_realtime') THEN
    CREATE ROLE brand_realtime NOLOGIN NOINHERIT;
  END IF;
END $$;

GRANT brand_realtime TO authenticator;
GRANT USAGE ON SCHEMA notion TO brand_realtime;

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'content_calendar', 'weekly_plan', 'sales', 'products', 'content_plans',
    'costs', 'action_plan', 'app_settings', 'references', 'threads_performance',
    'daily_sales', 'oem_inquiries_yj', 'visit_stats_yj'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    EXECUTE format('GRANT SELECT ON TABLE notion.%I TO brand_realtime', t);
    EXECUTE format('ALTER TABLE notion.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS brand_realtime_select ON notion.%I', t);
  END LOOP;
END $$;

-- brand_scope=all is the admin token. brand_name is one brand's select value.
-- app_settings holds every brand (including share keys) so only admin may read it.
-- Factory inquiries and visit stats have no brand column.
CREATE POLICY brand_realtime_select ON notion.content_calendar
  FOR SELECT TO brand_realtime
  USING (
    COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all'
    OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', '')
  );
CREATE POLICY brand_realtime_select ON notion.weekly_plan
  FOR SELECT TO brand_realtime
  USING (
    COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all'
    OR brand = COALESCE(auth.jwt() ->> 'brand_name', '')
    OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', '')
  );
CREATE POLICY brand_realtime_select ON notion.sales
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.products
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.content_plans
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.costs
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.action_plan
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.references
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.threads_performance
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.daily_sales
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all' OR "브랜드" = COALESCE(auth.jwt() ->> 'brand_name', ''));
CREATE POLICY brand_realtime_select ON notion.app_settings
  FOR SELECT TO brand_realtime
  USING (COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all');
CREATE POLICY brand_realtime_select ON notion.oem_inquiries_yj
  FOR SELECT TO brand_realtime
  USING (
    COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all'
    OR COALESCE(auth.jwt() ->> 'allow_factory', '') = 'true'
  );
CREATE POLICY brand_realtime_select ON notion.visit_stats_yj
  FOR SELECT TO brand_realtime
  USING (
    COALESCE(auth.jwt() ->> 'brand_scope', '') = 'all'
    OR COALESCE(auth.jwt() ->> 'allow_factory', '') = 'true'
  );

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'content_calendar', 'weekly_plan', 'sales', 'products', 'content_plans',
    'costs', 'action_plan', 'app_settings', 'references', 'threads_performance',
    'daily_sales', 'oem_inquiries_yj', 'visit_stats_yj'
  ];
BEGIN
  FOREACH t IN ARRAY tables
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'notion' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE notion.%I', t);
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
