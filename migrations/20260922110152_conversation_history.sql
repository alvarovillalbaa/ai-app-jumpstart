-- Existing rows have no recorded creation time. Zero means unknown, not now.
ALTER TABLE public.app_conversations
  ADD COLUMN title text NOT NULL DEFAULT 'New conversation' CHECK (length(title) BETWEEN 1 AND 120),
  ADD COLUMN created_at bigint NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  ADD COLUMN archived integer NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
CREATE INDEX conversations_history ON public.app_conversations(tenant,subject,archived,created_at DESC,id DESC);
-- Existing backend-only grants and RLS remain intact; no browser grants/policies.
