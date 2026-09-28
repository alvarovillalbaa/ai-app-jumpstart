-- The Eve ingress needs a backend-only read of the permanent row fence before
-- it accepts another turn or human approval. Keep the fence table private.
CREATE FUNCTION public.app_account_fence_status(p_tenant text,p_subject text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS(SELECT 1 FROM app_private.account_fences
    WHERE tenant=p_tenant AND subject=p_subject)
$$;
REVOKE ALL ON FUNCTION public.app_account_fence_status(text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.app_account_fence_status(text,text) FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.app_account_fence_status(text,text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.app_account_fence_status(text,text) TO service_role;
  END IF;
END $$;
