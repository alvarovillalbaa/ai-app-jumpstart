-- Keep listing in a separate migration so deployed catalog migrations remain immutable.
CREATE FUNCTION public.app_upload_list(input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  v_tenant text := input->>'tenant';
  v_subject text := input->>'subject';
  v_result jsonb;
BEGIN
  IF v_tenant IS NULL OR char_length(v_tenant) NOT BETWEEN 1 AND 200 OR
     v_subject IS NULL OR char_length(v_subject) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Invalid upload owner';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'name',name,'mediaType',media_type,'size',size,
    'sha256',sha256,'createdAt',created_at,'state',state)
    ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO v_result
  FROM (SELECT * FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject
    AND state<>'deleted' ORDER BY created_at DESC,id DESC LIMIT 1001) rows;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.app_upload_list(jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.app_upload_list(jsonb) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.app_upload_list(jsonb) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.app_upload_list(jsonb) TO service_role;
  END IF;
END $$;
