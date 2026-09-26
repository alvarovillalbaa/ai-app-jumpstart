CREATE TABLE public.app_uploads (
  id uuid PRIMARY KEY,
  tenant text NOT NULL CHECK (char_length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  media_type text NOT NULL CHECK (media_type IN ('text/plain','image/png','image/jpeg','application/pdf')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  state text NOT NULL CHECK (state IN ('pending','quarantined','deleting','deleted'))
);
CREATE INDEX app_uploads_owner_state ON public.app_uploads(tenant,subject,state,created_at,id);
ALTER TABLE public.app_uploads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_uploads FROM PUBLIC;

-- The backend is the only caller. Owner advisory locks serialize quota checks
-- across application instances; no upload may become downloadable here.
CREATE FUNCTION public.app_upload_command(command text,input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_tenant text := input->>'tenant';
  v_subject text := input->>'subject';
  v_id uuid;
  v_row public.app_uploads%ROWTYPE;
  v_count bigint;
  v_bytes bigint;
  v_size integer;
  v_max_bytes bigint;
  v_max_files integer;
  v_state text;
BEGIN
  IF v_tenant IS NULL OR char_length(v_tenant) NOT BETWEEN 1 AND 200 OR
     v_subject IS NULL OR char_length(v_subject) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid upload owner';
  END IF;
  IF command='usage' THEN
    SELECT count(*),coalesce(sum(size),0) INTO v_count,v_bytes FROM public.app_uploads
      WHERE tenant=v_tenant AND subject=v_subject AND state<>'deleted';
    RETURN jsonb_build_object('files',v_count,'bytes',v_bytes);
  END IF;
  IF command='reserve' THEN
    v_id := (input->'input'->>'id')::uuid;
    v_size := (input->'input'->>'size')::integer;
    v_max_bytes := (input->'quota'->>'maxBytes')::bigint;
    v_max_files := (input->'quota'->>'maxFiles')::integer;
    IF v_size NOT BETWEEN 1 AND 5242880 OR v_max_bytes < 1 OR v_max_files < 1 THEN
      RAISE EXCEPTION 'Invalid upload size or quota';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      pg_catalog.jsonb_build_array(v_tenant,v_subject)::text,55091));
    SELECT * INTO v_row FROM public.app_uploads WHERE id=v_id;
    IF FOUND THEN
      IF v_row.tenant=v_tenant AND v_row.subject=v_subject AND
         v_row.name=input->'input'->>'name' AND v_row.media_type=input->'input'->>'mediaType' AND
         v_row.size=v_size AND v_row.sha256=input->'input'->>'sha256' THEN
        RETURN to_jsonb('existing'::text);
      END IF;
      RETURN to_jsonb('conflict'::text);
    END IF;
    SELECT count(*),coalesce(sum(size),0) INTO v_count,v_bytes FROM public.app_uploads
      WHERE tenant=v_tenant AND subject=v_subject AND state<>'deleted';
    IF v_count>=v_max_files OR v_bytes+v_size>v_max_bytes THEN RETURN to_jsonb('quota'::text); END IF;
    INSERT INTO public.app_uploads(id,tenant,subject,name,media_type,size,sha256,created_at,state)
      VALUES(v_id,v_tenant,v_subject,input->'input'->>'name',input->'input'->>'mediaType',v_size,
        input->'input'->>'sha256',(input->'input'->>'createdAt')::bigint,'pending')
      ON CONFLICT DO NOTHING;
    IF FOUND THEN RETURN to_jsonb('reserved'::text); END IF;
    RETURN to_jsonb('conflict'::text);
  END IF;
  v_id := (input->>'id')::uuid;
  IF command='get' THEN
    SELECT * INTO v_row FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id;
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
    RETURN jsonb_build_object('id',v_row.id,'name',v_row.name,'mediaType',v_row.media_type,
      'size',v_row.size,'sha256',v_row.sha256,'createdAt',v_row.created_at,'state',v_row.state);
  END IF;
  IF command='markStored' THEN
    UPDATE public.app_uploads SET state='quarantined' WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state='pending';
    IF FOUND THEN RETURN 'true'::jsonb; END IF;
    SELECT state INTO v_state FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id;
    RETURN to_jsonb(coalesce(v_state='quarantined',false));
  END IF;
  IF command='beginDelete' THEN
    UPDATE public.app_uploads SET state='deleting' WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state IN ('pending','quarantined');
    IF FOUND THEN RETURN 'true'::jsonb; END IF;
    SELECT state INTO v_state FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id;
    RETURN to_jsonb(coalesce(v_state='deleting',false));
  END IF;
  IF command='finishDelete' THEN
    UPDATE public.app_uploads SET state='deleted' WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state='deleting';
    IF FOUND THEN RETURN 'true'::jsonb; END IF;
    SELECT state INTO v_state FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id;
    RETURN to_jsonb(coalesce(v_state='deleted',false));
  END IF;
  RAISE EXCEPTION 'Unknown upload command';
END $$;
REVOKE ALL ON FUNCTION public.app_upload_command(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_uploads FROM anon;
    REVOKE ALL ON FUNCTION public.app_upload_command(text,jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_uploads FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_upload_command(text,jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_uploads TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_upload_command(text,jsonb) TO service_role;
  END IF;
END $$;
