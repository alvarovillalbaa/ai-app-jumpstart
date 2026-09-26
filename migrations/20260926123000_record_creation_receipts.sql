-- Retain small creation receipts after record deletion to fence delayed retries.
CREATE TABLE public.app_record_creates (
  tenant text NOT NULL CHECK(length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  creation_key uuid NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  record_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant,subject,creation_key)
);
ALTER TABLE public.app_record_creates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_record_creates FROM PUBLIC;

CREATE FUNCTION public.app_create_record_once(_tenant text,_subject text,_key uuid,_hash text,_id uuid,_title text,_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE receipt public.app_record_creates%ROWTYPE; inserted boolean; stamp text;
BEGIN
  IF length(_tenant) NOT BETWEEN 1 AND 200 OR length(_subject) NOT BETWEEN 1 AND 200
    OR _hash IS NULL OR _hash !~ '^[a-f0-9]{64}$' OR _key IS NULL OR _id IS NULL
    OR _title IS NULL OR length(_title) NOT BETWEEN 1 AND 200 OR _content IS NULL OR length(_content)>32000
  THEN RAISE EXCEPTION 'Invalid record creation'; END IF;
  INSERT INTO public.app_record_creates(tenant,subject,creation_key,request_hash,record_id)
    VALUES(_tenant,_subject,_key,_hash,_id) ON CONFLICT DO NOTHING RETURNING * INTO receipt;
  inserted := FOUND;
  IF NOT inserted THEN
    SELECT * INTO STRICT receipt FROM public.app_record_creates
      WHERE tenant=_tenant AND subject=_subject AND creation_key=_key;
    IF receipt.request_hash <> _hash THEN RETURN jsonb_build_object('status','conflict'); END IF;
    IF NOT EXISTS(SELECT 1 FROM public.app_records WHERE tenant=_tenant AND subject=_subject AND id=receipt.record_id)
      THEN RETURN jsonb_build_object('status','deleted'); END IF;
  ELSE
    INSERT INTO public.app_records(id,tenant,subject,title,content,created_at,updated_at)
      VALUES(_id,_tenant,_subject,_title,_content,receipt.created_at,receipt.created_at);
  END IF;
  stamp := to_char(receipt.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  RETURN jsonb_build_object('status',CASE WHEN inserted THEN 'created' ELSE 'existing' END,
    'record',jsonb_build_object('id',receipt.record_id,'title',_title,'content',_content,'revision',1,'createdAt',stamp,'updatedAt',stamp));
END $$;
REVOKE ALL ON FUNCTION public.app_create_record_once(text,text,uuid,text,uuid,text,text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_record_creates FROM anon,authenticated;
    REVOKE ALL ON FUNCTION public.app_create_record_once(text,text,uuid,text,uuid,text,text) FROM anon,authenticated;
    GRANT SELECT,INSERT ON public.app_record_creates TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_create_record_once(text,text,uuid,text,uuid,text,text) TO service_role;
  END IF;
END $$;
