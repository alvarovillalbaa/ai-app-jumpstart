CREATE OR REPLACE FUNCTION public.app_budget_attempt_command(command text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE
  owner_t text := input->>'tenant'; owner_s text := input->>'subject'; op uuid := (input->>'operationId')::uuid;
  attempt_id_value text := input->>'attemptId'; cap integer; state text; count_value integer; references_value jsonb;
BEGIN
  IF (length(owner_t) BETWEEN 1 AND 200 AND length(owner_s) BETWEEN 1 AND 200 AND op IS NOT NULL AND command IN ('claimAttempt','attemptCount','listAttempts')) IS NOT TRUE THEN RAISE EXCEPTION 'Invalid attempt command'; END IF;
  IF command='claimAttempt' THEN
    cap := (input->>'maxAttempts')::integer;
    IF (cap BETWEEN 1 AND 1000 AND attempt_id_value ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RAISE EXCEPTION 'Invalid attempt policy'; END IF;
    -- Same owner lock as admission and settlement; no attempt may race past settlement.
    PERFORM 1 FROM public.app_budget_accounts WHERE tenant=owner_t AND subject=owner_s FOR UPDATE;
  END IF;
  SELECT status INTO state FROM public.app_budget_reservations WHERE operation_id=op AND tenant=owner_t AND subject=owner_s;
  IF NOT FOUND THEN RETURN CASE WHEN command='attemptCount' THEN '0'::jsonb WHEN command='listAttempts' THEN '[]'::jsonb ELSE 'false'::jsonb END; END IF;
  IF command='listAttempts' THEN
    SELECT COALESCE(jsonb_agg(attempt_id ORDER BY attempt_id),'[]'::jsonb) INTO references_value
      FROM public.app_budget_attempts WHERE operation_id=op;
    RETURN references_value;
  END IF;
  SELECT COUNT(*) INTO count_value FROM public.app_budget_attempts WHERE operation_id=op;
  IF command='attemptCount' THEN RETURN to_jsonb(count_value); END IF;
  IF state<>'reserved' THEN RETURN 'false'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM public.app_budget_attempts WHERE operation_id=op AND attempt_id=attempt_id_value) THEN RETURN 'true'::jsonb; END IF;
  IF count_value>=cap THEN RETURN 'false'::jsonb; END IF;
  INSERT INTO public.app_budget_attempts(operation_id,attempt_id) VALUES(op,attempt_id_value);
  RETURN 'true'::jsonb;
END $$;
