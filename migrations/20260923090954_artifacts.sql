CREATE TABLE public.app_artifacts (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES public.app_conversations(operation_id),
  session_id text NOT NULL,
  call_id text NOT NULL CHECK (char_length(call_id) BETWEEN 1 AND 512),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 131072),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  UNIQUE(operation_id,call_id)
);
CREATE INDEX app_artifacts_operation_time ON public.app_artifacts(operation_id,created_at DESC,id DESC);
ALTER TABLE public.app_artifacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_artifacts FROM PUBLIC;

-- Backend-only and invoker-security. Lock the active binding so revoke and
-- artifact commit cannot race across the approval boundary.
CREATE FUNCTION public.app_save_artifact(p_tenant text,p_subject text,p_operation uuid,p_session text,p_call text,
  p_hash text,p_id uuid,p_title text,p_content text,p_created bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE saved public.app_artifacts%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.app_conversations WHERE tenant=p_tenant AND subject=p_subject
    AND operation_id=p_operation AND session_id=p_session AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  INSERT INTO public.app_artifacts(id,operation_id,session_id,call_id,input_hash,title,content,created_at)
    VALUES(p_id,p_operation,p_session,p_call,p_hash,p_title,p_content,p_created)
    ON CONFLICT DO NOTHING RETURNING * INTO saved;
  IF FOUND THEN
    RETURN jsonb_build_object('status','created','artifact',jsonb_build_object('id',saved.id,'operation_id',saved.operation_id,
      'session_id',saved.session_id,'call_id',saved.call_id,'title',saved.title,'content',saved.content,'created_at',saved.created_at));
  END IF;
  SELECT * INTO saved FROM public.app_artifacts WHERE operation_id=p_operation AND call_id=p_call;
  IF saved.id IS NULL THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  IF saved.input_hash<>p_hash THEN RETURN jsonb_build_object('status','conflict'); END IF;
  RETURN jsonb_build_object('status','existing','artifact',jsonb_build_object('id',saved.id,'operation_id',saved.operation_id,
    'session_id',saved.session_id,'call_id',saved.call_id,'title',saved.title,'content',saved.content,'created_at',saved.created_at));
END $$;
REVOKE ALL ON FUNCTION public.app_save_artifact(text,text,uuid,text,text,text,uuid,text,text,bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_artifacts FROM anon;
    REVOKE ALL ON FUNCTION public.app_save_artifact(text,text,uuid,text,text,text,uuid,text,text,bigint) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_artifacts FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_save_artifact(text,text,uuid,text,text,text,uuid,text,text,bigint) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT ON public.app_artifacts TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_save_artifact(text,text,uuid,text,text,text,uuid,text,text,bigint) TO service_role;
  END IF;
END $$;
