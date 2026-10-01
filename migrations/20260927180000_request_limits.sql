CREATE TABLE public.app_request_limits(
  tenant text NOT NULL CHECK(length(tenant) BETWEEN 1 AND 200),subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  bucket bigint NOT NULL CHECK(bucket>=0 AND bucket%60000=0),counter integer NOT NULL CHECK(counter BETWEEN 1 AND 10000),
  PRIMARY KEY(tenant,subject));
ALTER TABLE public.app_request_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_request_limits FROM PUBLIC;

CREATE FUNCTION public.app_request_limit(input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.app_request_limits; moment bigint:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  current_bucket bigint; cap integer; admitted boolean;
BEGIN
  IF jsonb_typeof(input) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid request limit input'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(input))<>3 OR jsonb_typeof(input->'tenant') IS DISTINCT FROM 'string'
    OR jsonb_typeof(input->'subject') IS DISTINCT FROM 'string' OR jsonb_typeof(input->'limit') IS DISTINCT FROM 'number'
    OR length(input->>'tenant') NOT BETWEEN 1 AND 200 OR length(input->>'subject') NOT BETWEEN 1 AND 200
    OR input->>'limit' !~ '^[1-9][0-9]{0,4}$' THEN RAISE EXCEPTION 'Invalid request limit input'; END IF;
  cap:=(input->>'limit')::integer;
  IF cap>10000 THEN RAISE EXCEPTION 'Invalid request limit input'; END IF;
  current_bucket:=(moment/60000)*60000;
  INSERT INTO public.app_request_limits(tenant,subject,bucket,counter) VALUES(input->>'tenant',input->>'subject',current_bucket,1)
    ON CONFLICT(tenant,subject) DO UPDATE SET bucket=greatest(app_request_limits.bucket,excluded.bucket),
      counter=CASE WHEN excluded.bucket>app_request_limits.bucket THEN 1 ELSE app_request_limits.counter+1 END
    WHERE excluded.bucket>app_request_limits.bucket OR app_request_limits.counter<cap RETURNING * INTO saved;
  admitted:=FOUND;
  IF NOT admitted THEN SELECT * INTO saved FROM public.app_request_limits WHERE tenant=input->>'tenant' AND subject=input->>'subject'; END IF;
  RETURN jsonb_build_object('allowed',admitted,'remaining',CASE WHEN admitted THEN greatest(0,cap-saved.counter) ELSE 0 END,
    'resetAt',to_char(to_timestamp((saved.bucket+60000)::double precision/1000) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'retryAfterSeconds',CASE WHEN admitted THEN 0 ELSE greatest(1,least(60,ceil((saved.bucket+60000-moment)::numeric/1000)::integer)) END);
END $$;
REVOKE ALL ON FUNCTION public.app_request_limit(jsonb) FROM PUBLIC;
CREATE FUNCTION public.app_request_limits_ready() RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  PERFORM tenant FROM public.app_request_limits LIMIT 1;
  RETURN has_function_privilege(current_user,'public.app_request_limit(jsonb)','EXECUTE');
END $$;
REVOKE ALL ON FUNCTION public.app_request_limits_ready() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.app_request_limits FROM anon;REVOKE ALL ON FUNCTION public.app_request_limit(jsonb),public.app_request_limits_ready() FROM anon; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.app_request_limits FROM authenticated;REVOKE ALL ON FUNCTION public.app_request_limit(jsonb),public.app_request_limits_ready() FROM authenticated; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_request_limits TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_request_limit(jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_request_limits_ready() TO service_role;
  END IF;
END $$;
