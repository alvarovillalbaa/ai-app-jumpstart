CREATE INDEX IF NOT EXISTS app_uploads_cleanup
  ON public.app_uploads(state,created_at,id)
  WHERE state IN ('pending','deleting');
