-- Keep the original call receipt after erasing user text, so Eve replay cannot
-- create the same approved artifact again.
ALTER TABLE public.app_artifacts ADD COLUMN deleted_at bigint;

CREATE OR REPLACE FUNCTION public.app_save_artifact(p_tenant text,p_subject text,p_operation uuid,p_session text,p_call text,
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
  IF saved.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  IF saved.input_hash<>p_hash THEN RETURN jsonb_build_object('status','conflict'); END IF;
  RETURN jsonb_build_object('status','existing','artifact',jsonb_build_object('id',saved.id,'operation_id',saved.operation_id,
    'session_id',saved.session_id,'call_id',saved.call_id,'title',saved.title,'content',saved.content,'created_at',saved.created_at));
END $$;

CREATE FUNCTION public.app_delete_artifact(p_tenant text,p_subject text,p_id uuid,p_deleted bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE erased uuid;
BEGIN
  UPDATE public.app_artifacts AS a SET title='Deleted artifact',content=' ',input_hash=repeat('0',64),deleted_at=p_deleted
    FROM public.app_conversations AS c WHERE a.id=p_id AND a.deleted_at IS NULL
      AND c.operation_id=a.operation_id AND c.tenant=p_tenant AND c.subject=p_subject
    RETURNING a.id INTO erased;
  RETURN erased IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.app_delete_artifact(text,text,uuid,bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.app_delete_artifact(text,text,uuid,bigint) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.app_delete_artifact(text,text,uuid,bigint) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT UPDATE ON public.app_artifacts TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_delete_artifact(text,text,uuid,bigint) TO service_role;
  END IF;
END $$;
