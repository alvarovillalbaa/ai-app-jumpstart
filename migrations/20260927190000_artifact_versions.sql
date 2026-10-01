-- Additive upgrade: approved text becomes immutable version 1. Deleted receipts
-- are deliberately excluded; never copy their erased text into history.
ALTER TABLE public.app_artifacts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100);
ALTER TABLE public.app_artifacts ADD COLUMN updated_at bigint NOT NULL DEFAULT 0 CHECK(updated_at >= 0);
UPDATE public.app_artifacts SET updated_at=created_at;
CREATE TABLE public.app_artifact_versions (
  artifact_id uuid NOT NULL REFERENCES public.app_artifacts(id),
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 100),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 131072),
  updated_at bigint NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(artifact_id,revision)
);
INSERT INTO public.app_artifact_versions SELECT id,revision,title,content,updated_at FROM public.app_artifacts WHERE deleted_at IS NULL;
ALTER TABLE public.app_artifact_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_artifact_versions FROM PUBLIC;
CREATE FUNCTION public.app_artifact_version_capture() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF TG_WHEN='BEFORE' THEN
    IF TG_OP='INSERT' THEN NEW.updated_at:=NEW.created_at;
    ELSIF OLD.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'Deleted artifact is immutable';
    ELSIF NEW.deleted_at IS NULL AND (NEW.revision<>OLD.revision+1 OR NEW.input_hash<>OLD.input_hash) THEN
      RAISE EXCEPTION 'Artifact edits require a new revision';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    DELETE FROM public.app_artifact_versions WHERE artifact_id=NEW.id;
  ELSE
    INSERT INTO public.app_artifact_versions VALUES(NEW.id,NEW.revision,NEW.title,NEW.content,NEW.updated_at);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER artifact_version_guard BEFORE INSERT OR UPDATE ON public.app_artifacts FOR EACH ROW EXECUTE FUNCTION public.app_artifact_version_capture();
CREATE TRIGGER artifact_version_capture AFTER INSERT OR UPDATE ON public.app_artifacts FOR EACH ROW EXECUTE FUNCTION public.app_artifact_version_capture();

CREATE OR REPLACE FUNCTION public.app_save_artifact(p_tenant text,p_subject text,p_operation uuid,p_session text,p_call text,
  p_hash text,p_id uuid,p_title text,p_content text,p_created bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.app_artifacts%ROWTYPE; original public.app_artifact_versions%ROWTYPE; outcome text;
BEGIN
  PERFORM 1 FROM public.app_conversations WHERE tenant=p_tenant AND subject=p_subject
    AND operation_id=p_operation AND session_id=p_session AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  INSERT INTO public.app_artifacts(id,operation_id,session_id,call_id,input_hash,title,content,created_at)
    VALUES(p_id,p_operation,p_session,p_call,p_hash,p_title,p_content,p_created) ON CONFLICT DO NOTHING RETURNING * INTO saved;
  IF FOUND THEN outcome:='created';
  ELSE
    SELECT * INTO saved FROM public.app_artifacts WHERE operation_id=p_operation AND call_id=p_call FOR UPDATE;
    IF saved.id IS NULL OR saved.deleted_at IS NOT NULL THEN RETURN jsonb_build_object('status','unavailable'); END IF;
    IF saved.input_hash<>p_hash THEN RETURN jsonb_build_object('status','conflict'); END IF;
    outcome:='existing';
  END IF;
  SELECT * INTO STRICT original FROM public.app_artifact_versions WHERE artifact_id=saved.id AND revision=1;
  RETURN jsonb_build_object('status',outcome,'artifact',jsonb_build_object('id',saved.id,'operation_id',saved.operation_id,
    'session_id',saved.session_id,'call_id',saved.call_id,'title',original.title,'content',original.content,
    'created_at',saved.created_at,'revision',1,'updated_at',original.updated_at));
END $$;

CREATE FUNCTION public.app_update_artifact(p_tenant text,p_subject text,p_id uuid,p_revision integer,p_title text,p_content text,p_updated bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.app_artifacts%ROWTYPE;
BEGIN
  SELECT a.* INTO saved FROM public.app_artifacts a JOIN public.app_conversations c ON c.operation_id=a.operation_id
    WHERE a.id=p_id AND c.tenant=p_tenant AND c.subject=p_subject AND a.deleted_at IS NULL FOR UPDATE OF a;
  IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
  IF saved.revision<>p_revision THEN RETURN jsonb_build_object('status','conflict'); END IF;
  IF saved.revision>=100 THEN RETURN jsonb_build_object('status','limit'); END IF;
  UPDATE public.app_artifacts SET title=p_title,content=p_content,revision=revision+1,updated_at=p_updated WHERE id=p_id RETURNING * INTO saved;
  RETURN jsonb_build_object('status','updated','artifact',jsonb_build_object('id',saved.id,'operation_id',saved.operation_id,
    'session_id',saved.session_id,'call_id',saved.call_id,'title',saved.title,'content',saved.content,
    'created_at',saved.created_at,'revision',saved.revision,'updated_at',saved.updated_at));
END $$;
REVOKE ALL ON FUNCTION public.app_artifact_version_capture() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_update_artifact(text,text,uuid,integer,text,text,bigint) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_artifact_versions FROM anon;
    REVOKE ALL ON FUNCTION public.app_artifact_version_capture(),public.app_update_artifact(text,text,uuid,integer,text,text,bigint) FROM anon;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_artifact_versions FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_artifact_version_capture(),public.app_update_artifact(text,text,uuid,integer,text,text,bigint) FROM authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,DELETE ON public.app_artifact_versions TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_artifact_version_capture(),public.app_update_artifact(text,text,uuid,integer,text,text,bigint) TO service_role;
  END IF;
END $$;
