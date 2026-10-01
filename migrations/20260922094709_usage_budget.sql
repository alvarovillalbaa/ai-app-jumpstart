CREATE TABLE public.app_budget_accounts (
  tenant text NOT NULL CHECK(length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  PRIMARY KEY(tenant,subject)
);
CREATE TABLE public.app_budget_reservations (
  operation_id uuid PRIMARY KEY, tenant text NOT NULL, subject text NOT NULL,
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  policy_id text NOT NULL CHECK(length(policy_id) BETWEEN 1 AND 100),
  estimate_micros bigint NOT NULL CHECK(estimate_micros BETWEEN 1 AND 1000000000000),
  day bigint NOT NULL CHECK(day>=0), created_at bigint NOT NULL CHECK(created_at>0),
  status text NOT NULL CHECK(status IN ('reserved','settled')),
  actual_micros bigint CHECK(actual_micros BETWEEN 0 AND 1000000000000),
  FOREIGN KEY(tenant,subject) REFERENCES public.app_budget_accounts(tenant,subject)
);
CREATE INDEX budget_owner_day ON public.app_budget_reservations(tenant,subject,day);
CREATE INDEX budget_owner_time ON public.app_budget_reservations(tenant,subject,created_at);
CREATE INDEX budget_owner_status ON public.app_budget_reservations(tenant,subject,status);
ALTER TABLE public.app_budget_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_budget_accounts, public.app_budget_reservations FROM PUBLIC;

-- One transaction for admission/settlement, available to both pg and PostgREST.
-- Invoker security: execution never elevates a browser database credential.
CREATE FUNCTION public.app_budget_command(command text, input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  owner_t text := input->>'tenant'; owner_s text := input->>'subject';
  op uuid; at_ms bigint; day_id bigint; estimate bigint; actual bigint;
  daily_limit bigint; active_limit integer; rate_limit integer;
  existing public.app_budget_reservations%ROWTYPE;
  reserved bigint; charged bigint; active_count bigint; recent_count bigint; unknown_count bigint;
BEGIN
  IF (length(owner_t) BETWEEN 1 AND 200 AND length(owner_s) BETWEEN 1 AND 200 AND command IN ('reserve','settle','snapshot')) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid budget command'; END IF;
  IF command <> 'snapshot' THEN op := (input->>'operationId')::uuid; IF op IS NULL THEN RAISE EXCEPTION 'Missing operation'; END IF; END IF;
  IF command IN ('reserve','settle') THEN
    INSERT INTO public.app_budget_accounts(tenant,subject) VALUES(owner_t,owner_s) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM public.app_budget_accounts WHERE tenant=owner_t AND subject=owner_s FOR UPDATE;
    SELECT * INTO existing FROM public.app_budget_reservations WHERE operation_id=op;
  END IF;
  IF command='settle' THEN
    IF NOT FOUND OR existing.tenant<>owner_t OR existing.subject<>owner_s THEN RETURN 'false'::jsonb; END IF;
    IF NOT input ? 'actualMicros' THEN RAISE EXCEPTION 'Missing usage state'; END IF;
    actual := (input->>'actualMicros')::bigint;
    IF actual IS NOT NULL AND actual NOT BETWEEN 0 AND 1000000000000 THEN RAISE EXCEPTION 'Invalid usage'; END IF;
    IF existing.status='settled' THEN RETURN to_jsonb(existing.actual_micros IS NOT DISTINCT FROM actual); END IF;
    UPDATE public.app_budget_reservations SET status='settled',actual_micros=actual WHERE operation_id=op;
    RETURN 'true'::jsonb;
  END IF;
  at_ms := (input->>'now')::bigint;
  IF (at_ms BETWEEN 1 AND 8640000000000000) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid budget clock'; END IF;
  day_id := at_ms / 86400000;
  IF command='reserve' THEN
    estimate := (input->>'estimateMicros')::bigint;
    daily_limit := (input->'policy'->>'dailyMicros')::bigint;
    active_limit := (input->'policy'->>'maxActive')::integer;
    rate_limit := (input->'policy'->>'maxPerMinute')::integer;
    IF (estimate BETWEEN 1 AND 1000000000000 AND daily_limit BETWEEN 1 AND 1000000000000 AND active_limit BETWEEN 1 AND 1000 AND rate_limit BETWEEN 1 AND 1000 AND length(input->'policy'->>'id') BETWEEN 1 AND 100 AND input->>'requestHash' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'Invalid budget policy'; END IF;
    IF existing.operation_id IS NOT NULL THEN
      IF existing.tenant<>owner_t OR existing.subject<>owner_s OR existing.request_hash<>input->>'requestHash' OR existing.estimate_micros<>estimate OR existing.policy_id<>input->'policy'->>'id' THEN RETURN '{"status":"denied","reason":"conflict"}'::jsonb; END IF;
      RETURN jsonb_build_object('status',existing.status,'created',false);
    END IF;
  END IF;
  SELECT
    COALESCE(SUM(CASE WHEN day=day_id AND status='reserved' THEN estimate_micros ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN day=day_id AND status='settled' THEN COALESCE(actual_micros,estimate_micros) ELSE 0 END),0),
    COUNT(*) FILTER(WHERE status='reserved'), COUNT(*) FILTER(WHERE created_at>at_ms-60000),
    COUNT(*) FILTER(WHERE day=day_id AND status='settled' AND actual_micros IS NULL)
    INTO reserved,charged,active_count,recent_count,unknown_count
    FROM public.app_budget_reservations WHERE tenant=owner_t AND subject=owner_s AND (day=day_id OR status='reserved' OR created_at>at_ms-60000);
  IF command='snapshot' THEN RETURN jsonb_build_object('day',day_id,'reservedMicros',reserved,'chargedMicros',charged,'active',active_count,'recent',recent_count,'unknownCosts',unknown_count); END IF;
  IF charged+reserved+estimate>daily_limit THEN RETURN '{"status":"denied","reason":"daily_limit"}'::jsonb; END IF;
  IF active_count>=active_limit THEN RETURN '{"status":"denied","reason":"active_limit"}'::jsonb; END IF;
  IF recent_count>=rate_limit THEN RETURN '{"status":"denied","reason":"rate_limit"}'::jsonb; END IF;
  INSERT INTO public.app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status)
    VALUES(op,owner_t,owner_s,input->>'requestHash',input->'policy'->>'id',estimate,day_id,at_ms,'reserved');
  RETURN '{"status":"reserved","created":true}'::jsonb;
EXCEPTION WHEN unique_violation THEN RETURN '{"status":"denied","reason":"conflict"}'::jsonb;
END $$;
REVOKE ALL ON FUNCTION public.app_budget_command(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_budget_accounts,public.app_budget_reservations FROM anon;
    REVOKE ALL ON FUNCTION public.app_budget_command(text,jsonb) FROM anon;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_budget_accounts,public.app_budget_reservations FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_budget_command(text,jsonb) FROM authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_budget_accounts,public.app_budget_reservations TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_budget_command(text,jsonb) TO service_role;
  END IF;
END $$;
