CREATE TABLE public.app_conversation_events (
  ordinal bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES public.app_conversations(operation_id),
  event_id text NOT NULL CHECK (event_id ~ '^evt_[0-9A-HJKMNP-TV-Z]{26}$'),
  payload text NOT NULL CHECK (octet_length(payload) <= 49152),
  UNIQUE(operation_id,event_id)
);
ALTER TABLE public.app_conversation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_conversation_events FROM PUBLIC;

-- Backend-only, invoker-security RPC. Lock the binding while admitting a write.
CREATE FUNCTION public.app_append_conversation_event(p_tenant text,p_subject text,p_operation uuid,p_session text,p_event text,p_payload text)
RETURNS text LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE existing text;
BEGIN
  PERFORM 1 FROM public.app_conversations WHERE tenant=p_tenant AND subject=p_subject
    AND operation_id=p_operation AND session_id=p_session AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unavailable'; END IF;
  INSERT INTO public.app_conversation_events(operation_id,event_id,payload) VALUES(p_operation,p_event,p_payload)
    ON CONFLICT DO NOTHING;
  IF FOUND THEN RETURN 'inserted'; END IF;
  SELECT payload INTO existing FROM public.app_conversation_events WHERE operation_id=p_operation AND event_id=p_event;
  IF existing=p_payload THEN RETURN 'duplicate'; END IF;
  RETURN 'conflict';
END $$;
REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_conversation_events FROM anon;
    REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_conversation_events FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT ON public.app_conversation_events TO service_role;
    GRANT USAGE,SELECT ON SEQUENCE public.app_conversation_events_ordinal_seq TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_append_conversation_event(text,text,uuid,text,text,text) TO service_role;
  END IF;
END $$;
