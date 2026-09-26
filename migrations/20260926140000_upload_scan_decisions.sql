-- Scan decisions are separate from object-write/delete coordination. Legacy
-- quarantine rows remain valid; a rejected decision cannot be replaced by clean.
ALTER TABLE public.app_uploads DROP CONSTRAINT app_uploads_state_check;
ALTER TABLE public.app_uploads ADD CONSTRAINT app_uploads_state_check CHECK(state IN ('pending','quarantined','clean','rejected','deleting','deleted'));
CREATE TABLE public.app_upload_scans (
  upload_id uuid PRIMARY KEY REFERENCES public.app_uploads(id) ON DELETE CASCADE,
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('clean','rejected')),
  reason text,
  checked_at bigint NOT NULL CHECK(checked_at BETWEEN 0 AND 9007199254740991),
  policy_version integer NOT NULL CHECK(policy_version=1),
  CHECK((status='clean' AND reason IS NULL) OR (status='rejected' AND reason IS NOT NULL AND reason IN ('malware','integrity')))
);
ALTER TABLE public.app_upload_scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_upload_scans FROM PUBLIC;

CREATE FUNCTION public.app_upload_scan_command(command text,input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE v_tenant text := input->>'tenant'; v_subject text := input->>'subject'; v_id uuid;
  v_row public.app_uploads%ROWTYPE; v_old public.app_upload_scans%ROWTYPE;
  v_decision jsonb := input->'decision'; v_status text; v_reason text; v_checked bigint; result jsonb;
BEGIN
  IF v_tenant IS NULL OR length(v_tenant) NOT BETWEEN 1 AND 200 OR v_subject IS NULL OR length(v_subject) NOT BETWEEN 1 AND 200
    THEN RAISE EXCEPTION 'Invalid owner'; END IF;
  IF command <> 'list' THEN v_id := (input->>'id')::uuid; END IF;
  IF command='record' THEN
    v_status := v_decision->>'status';v_reason := v_decision->>'reason';v_checked := (v_decision->>'checkedAt')::bigint;
    IF v_id IS NULL OR v_status IS NULL OR v_status NOT IN ('clean','rejected') OR v_checked IS NULL OR v_checked NOT BETWEEN 0 AND 9007199254740991
      OR v_decision->>'sha256' IS NULL OR v_decision->>'sha256' !~ '^[a-f0-9]{64}$' OR v_decision->>'policyVersion' IS DISTINCT FROM '1'
      OR (v_status='clean' AND v_reason IS NOT NULL) OR (v_status='rejected' AND (v_reason IS NULL OR v_reason NOT IN ('malware','integrity')))
      THEN RAISE EXCEPTION 'Invalid scan decision'; END IF;
    -- This row lock serializes verdicts with other verdicts and deletion.
    SELECT * INTO v_row FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id FOR UPDATE;
    IF NOT FOUND OR v_row.state NOT IN ('quarantined','clean') OR v_row.sha256<>v_decision->>'sha256' THEN RETURN 'false'::jsonb; END IF;
    SELECT * INTO v_old FROM public.app_upload_scans WHERE upload_id=v_id;
    IF FOUND AND (v_old.status='rejected' OR (v_status='clean' AND v_old.checked_at>v_checked)) THEN RETURN 'false'::jsonb; END IF;
    INSERT INTO public.app_upload_scans(upload_id,sha256,status,reason,checked_at,policy_version)
      VALUES(v_id,v_row.sha256,v_status,v_reason,v_checked,1)
      ON CONFLICT(upload_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,checked_at=excluded.checked_at;
    UPDATE public.app_uploads SET state=v_status WHERE id=v_id;
    RETURN 'true'::jsonb;
  END IF;
  IF command='markStored' THEN
    UPDATE public.app_uploads SET state='quarantined' WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state='pending';
    IF FOUND THEN RETURN 'true'::jsonb; END IF;
    RETURN to_jsonb(EXISTS(SELECT FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state IN ('quarantined','clean','rejected')));
  END IF;
  IF command='beginDelete' THEN
    UPDATE public.app_uploads SET state='deleting' WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state IN ('pending','quarantined','clean','rejected');
    IF FOUND THEN RETURN 'true'::jsonb; END IF;
    RETURN to_jsonb(EXISTS(SELECT FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject AND id=v_id AND state='deleting'));
  END IF;
  IF command NOT IN ('get','list') THEN RAISE EXCEPTION 'Unknown scan command'; END IF;
  SELECT coalesce(jsonb_agg(
    jsonb_build_object('id',u.id,'name',u.name,'mediaType',u.media_type,'size',u.size,'sha256',u.sha256,'createdAt',u.created_at,
      'state',CASE WHEN u.state='quarantined' AND s.upload_id IS NOT NULL THEN s.status ELSE u.state END)
    || CASE WHEN s.upload_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('scan',jsonb_strip_nulls(
      jsonb_build_object('status',s.status,'sha256',s.sha256,'checkedAt',s.checked_at,'policyVersion',s.policy_version,'reason',s.reason))) END
    ORDER BY u.created_at DESC,u.id DESC),'[]'::jsonb) INTO result
  FROM (SELECT * FROM public.app_uploads WHERE tenant=v_tenant AND subject=v_subject
    AND (command='list' AND state<>'deleted' OR command='get' AND id=v_id)
    ORDER BY created_at DESC,id DESC LIMIT 1001) u LEFT JOIN public.app_upload_scans s ON s.upload_id=u.id;
  IF command='get' THEN RETURN coalesce(result->0,'null'::jsonb); END IF;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.app_upload_scan_command(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_upload_scans FROM anon,authenticated;
    REVOKE ALL ON FUNCTION public.app_upload_scan_command(text,jsonb) FROM anon,authenticated;
    GRANT SELECT,INSERT,UPDATE ON public.app_upload_scans TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_upload_scan_command(text,jsonb) TO service_role;
  END IF;
END $$;
