ALTER TABLE public.app_conversation_events
  ADD COLUMN source_index bigint CHECK (source_index >= 0 AND source_index <= 9007199254740991);
CREATE UNIQUE INDEX app_conversation_events_source_index
  ON public.app_conversation_events(operation_id,source_index);

DROP FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text);
CREATE FUNCTION public.app_append_conversation_event(
  p_tenant text,p_subject text,p_operation uuid,p_session text,p_event text,p_payload text,p_source_index bigint DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE existing text; existing_source bigint;
BEGIN
  PERFORM 1 FROM public.app_conversations WHERE tenant=p_tenant AND subject=p_subject
    AND operation_id=p_operation AND session_id=p_session AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  INSERT INTO public.app_conversation_events(operation_id,event_id,payload,source_index)
    VALUES(p_operation,p_event,p_payload,p_source_index) ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'inserted'; END IF;
  SELECT payload,source_index INTO existing,existing_source FROM public.app_conversation_events
    WHERE operation_id=p_operation AND event_id=p_event;
  IF NOT FOUND THEN
    IF p_source_index IS NOT NULL AND EXISTS (SELECT 1 FROM public.app_conversation_events
      WHERE operation_id=p_operation AND source_index=p_source_index) THEN RETURN 'conflict'; END IF;
    RETURN 'unavailable';
  END IF;
  IF existing<>p_payload OR (p_source_index IS NOT NULL AND existing_source IS NOT NULL AND existing_source<>p_source_index) THEN
    RETURN 'conflict';
  END IF;
  IF p_source_index IS NOT NULL AND existing_source IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.app_conversation_events WHERE operation_id=p_operation AND source_index=p_source_index) THEN
      RETURN 'conflict';
    END IF;
    UPDATE public.app_conversation_events SET source_index=p_source_index
      WHERE operation_id=p_operation AND event_id=p_event AND source_index IS NULL;
  END IF;
  RETURN 'duplicate';
END $$;
REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text,bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text,bigint) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text,bigint) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT UPDATE(source_index) ON public.app_conversation_events TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text,bigint) TO service_role;
  END IF;
END $$;
