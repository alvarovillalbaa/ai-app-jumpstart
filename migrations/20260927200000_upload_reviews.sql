-- Consent receipts are separate from quarantine/scanner coordination. Existing
-- files remain unreviewed. No bytes or machine-supplied summaries are persisted.
CREATE TABLE public.app_upload_reviews (
  upload_id uuid PRIMARY KEY REFERENCES public.app_uploads(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  approved_sha256 text CHECK(approved_sha256 ~ '^[a-f0-9]{64}$'),
  approved_at bigint CHECK(approved_at BETWEEN 0 AND 9007199254740991),
  checked_at bigint CHECK(checked_at BETWEEN 0 AND 9007199254740991),
  CHECK((approved_sha256 IS NULL AND approved_at IS NULL AND checked_at IS NULL) OR
    (approved_sha256 IS NOT NULL AND approved_at IS NOT NULL AND checked_at IS NOT NULL))
);
ALTER TABLE public.app_upload_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_upload_reviews FROM PUBLIC;
CREATE FUNCTION public.app_upload_review_invalidate() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.state IN ('rejected','deleting','deleted') AND NEW.state<>OLD.state THEN
    UPDATE public.app_upload_reviews SET revision=LEAST(revision+1::bigint,2147483647),approved_sha256=NULL,approved_at=NULL,checked_at=NULL WHERE upload_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_review_invalidate AFTER UPDATE OF state ON public.app_uploads FOR EACH ROW EXECUTE FUNCTION public.app_upload_review_invalidate();
CREATE FUNCTION public.app_upload_review_command(command text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE u public.app_uploads%ROWTYPE;r public.app_upload_reviews%ROWTYPE;d jsonb:=input->'decision';
  v_revision integer;v_approved boolean;v_at bigint;v_checked bigint;result jsonb;
BEGIN
  IF input->>'tenant' IS NULL OR length(input->>'tenant') NOT BETWEEN 1 AND 200 OR input->>'subject' IS NULL OR length(input->>'subject') NOT BETWEEN 1 AND 200
    THEN RAISE EXCEPTION 'Invalid owner'; END IF;
  IF command='getReview' THEN
    SELECT * INTO u FROM public.app_uploads WHERE tenant=input->>'tenant' AND subject=input->>'subject' AND id=(input->>'id')::uuid AND state<>'deleted';
    IF NOT FOUND THEN RETURN 'null'::jsonb; END IF;
  ELSIF command='recordReview' THEN
    v_revision:=(d->>'revision')::integer;v_approved:=(d->>'approved')::boolean;v_at:=(d->>'at')::bigint;v_checked:=(d->>'checkedAt')::bigint;
    IF v_revision IS NULL OR v_revision NOT BETWEEN 0 AND 2147483646 OR jsonb_typeof(d->'approved') IS DISTINCT FROM 'boolean'
      OR d->>'sha256' IS NULL OR d->>'sha256' !~ '^[a-f0-9]{64}$' OR v_at IS NULL OR v_at NOT BETWEEN 0 AND 9007199254740991
      OR (v_approved AND (v_checked IS NULL OR v_checked NOT BETWEEN 0 AND 9007199254740991)) THEN RAISE EXCEPTION 'Invalid review'; END IF;
    SELECT * INTO u FROM public.app_uploads WHERE tenant=input->>'tenant' AND subject=input->>'subject' AND id=(input->>'id')::uuid AND state<>'deleted' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('status','unavailable'); END IF;
    SELECT * INTO r FROM public.app_upload_reviews WHERE upload_id=u.id;
    IF u.sha256<>d->>'sha256' OR COALESCE(r.revision,0)<>v_revision THEN RETURN jsonb_build_object('status','conflict'); END IF;
    IF v_approved AND (u.state<>'clean' OR NOT EXISTS(SELECT FROM public.app_upload_scans WHERE upload_id=u.id AND sha256=u.sha256 AND status='clean' AND checked_at=v_checked)) THEN RETURN jsonb_build_object('status','busy'); END IF;
    INSERT INTO public.app_upload_reviews VALUES(u.id,v_revision+1,CASE WHEN v_approved THEN u.sha256 ELSE NULL END,
      CASE WHEN v_approved THEN v_at ELSE NULL END,CASE WHEN v_approved THEN v_checked ELSE NULL END)
      ON CONFLICT(upload_id) DO UPDATE SET revision=excluded.revision,approved_sha256=excluded.approved_sha256,approved_at=excluded.approved_at,checked_at=excluded.checked_at;
  ELSE RAISE EXCEPTION 'Unknown review command'; END IF;
  SELECT * INTO r FROM public.app_upload_reviews WHERE upload_id=u.id;
  v_approved:=u.state='clean' AND r.approved_sha256=u.sha256 AND r.approved_at IS NOT NULL AND r.checked_at IS NOT NULL;
  result:=jsonb_build_object('id',u.id,'sha256',u.sha256,'revision',COALESCE(r.revision,0),'policyVersion',1,
    'status',CASE WHEN v_approved THEN 'approved' WHEN r.upload_id IS NULL THEN 'unreviewed' ELSE 'revoked' END,
    'approvedAt',CASE WHEN v_approved THEN r.approved_at ELSE NULL END,'checkedAt',CASE WHEN v_approved THEN r.checked_at ELSE NULL END);
  IF command='getReview' THEN RETURN result; END IF;
  RETURN jsonb_build_object('status','updated','review',result);
END $$;
REVOKE ALL ON FUNCTION public.app_upload_review_invalidate(),public.app_upload_review_command(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_upload_reviews FROM anon;
    REVOKE ALL ON FUNCTION public.app_upload_review_invalidate(),public.app_upload_review_command(text,jsonb) FROM anon;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_upload_reviews FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_upload_review_invalidate(),public.app_upload_review_command(text,jsonb) FROM authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_upload_reviews TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_upload_review_invalidate(),public.app_upload_review_command(text,jsonb) TO service_role;
  END IF;
END $$;
