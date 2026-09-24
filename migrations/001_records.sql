-- Apply once via npm run db:migrate. Compatible with PostgreSQL and Supabase.
CREATE TABLE IF NOT EXISTS public.app_records (
  id uuid PRIMARY KEY,
  tenant text NOT NULL,
  subject text NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  content text NOT NULL CHECK (length(content) <= 32000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS records_owner ON public.app_records(tenant, subject, id);
-- Browser database access is deliberately denied. Only the authenticated
-- application repository is permitted to use the backend database credential.
ALTER TABLE public.app_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_records FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.app_records FROM anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_records TO service_role;
  END IF;
END $$;
