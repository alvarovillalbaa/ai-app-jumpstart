-- Backend-only ownership and replay protection. Never expose an ownership write
-- through a browser database client. Revocation preserves the unique binding.
CREATE TABLE public.app_conversations (
  id uuid PRIMARY KEY,
  tenant text NOT NULL CHECK (length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  operation_id uuid NOT NULL UNIQUE,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  session_id text UNIQUE CHECK (length(session_id) BETWEEN 1 AND 512),
  status text NOT NULL CHECK (status IN ('starting', 'active', 'revoked')),
  CHECK (status <> 'active' OR session_id IS NOT NULL)
);
CREATE INDEX conversations_owner ON public.app_conversations(tenant, subject, operation_id);
CREATE TABLE public.app_internal_nonces (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  expires_at bigint NOT NULL CHECK (expires_at > 0)
);
CREATE INDEX nonces_expiry ON public.app_internal_nonces(expires_at);
ALTER TABLE public.app_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_internal_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_conversations, public.app_internal_nonces FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.app_conversations, public.app_internal_nonces FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.app_conversations, public.app_internal_nonces FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON public.app_conversations TO service_role;
    GRANT SELECT, INSERT, DELETE ON public.app_internal_nonces TO service_role;
  END IF;
END $$;
