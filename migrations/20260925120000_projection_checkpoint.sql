ALTER TABLE public.app_conversations
  ADD COLUMN projection_checkpoint bigint NOT NULL DEFAULT 0
  CHECK (projection_checkpoint >= 0 AND projection_checkpoint <= 9007199254740991);
