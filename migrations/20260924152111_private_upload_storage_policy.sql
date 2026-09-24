-- Supabase Storage is optional for the portable PostgreSQL deployment. In a
-- Supabase project storage.objects exists before this canonical migration.
-- An AS RESTRICTIVE policy wins even if the project has permissive policies
-- for other buckets. Only the backend secret (BYPASSRLS) may touch quarantine.
DO $migration$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY';
    EXECUTE $policy$CREATE POLICY app_private_uploads_quarantine
      ON storage.objects AS RESTRICTIVE FOR ALL TO PUBLIC
      USING (bucket_id <> 'app-private-uploads')
      WITH CHECK (bucket_id <> 'app-private-uploads')$policy$;
  END IF;
END $migration$;
