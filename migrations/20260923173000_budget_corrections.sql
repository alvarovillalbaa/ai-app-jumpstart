CREATE TABLE public.app_budget_corrections (
  correction_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES public.app_budget_reservations(operation_id),
  tenant text NOT NULL CHECK(length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
  previous_actual_micros bigint CHECK(previous_actual_micros BETWEEN 0 AND 1000000000000),
  corrected_actual_micros bigint NOT NULL CHECK(corrected_actual_micros BETWEEN 0 AND 1000000000000),
  actor text NOT NULL CHECK(length(actor) BETWEEN 1 AND 100),
  reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 1000),
  evidence_ref text NOT NULL CHECK(length(evidence_ref) BETWEEN 1 AND 500),
  at bigint NOT NULL CHECK(at>0)
);
CREATE INDEX budget_corrections_operation ON public.app_budget_corrections(operation_id,at,correction_id);
ALTER TABLE public.app_budget_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_budget_corrections FROM PUBLIC;

CREATE FUNCTION public.app_budget_corrections_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Budget correction audit entries are immutable';
END $$;
CREATE TRIGGER app_budget_corrections_immutable BEFORE UPDATE OR DELETE ON public.app_budget_corrections
FOR EACH ROW EXECUTE FUNCTION public.app_budget_corrections_immutable();
REVOKE ALL ON FUNCTION public.app_budget_corrections_immutable() FROM PUBLIC;

-- The same account lock as admission/settlement serializes a correction with
-- runtime writes. This command only corrects already-settled reservations;
-- outstanding work must be stopped and investigated separately.
CREATE FUNCTION public.app_budget_correct_settlement(input jsonb) RETURNS text
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  owner_t text := input->>'tenant'; owner_s text := input->>'subject';
  op uuid := (input->>'operationId')::uuid; correction uuid := (input->>'correctionId')::uuid;
  expected bigint := (input->>'expectedActualMicros')::bigint;
  corrected bigint := (input->>'correctedActualMicros')::bigint;
  correction_at bigint := floor(extract(epoch from clock_timestamp())*1000)::bigint;
  existing public.app_budget_corrections%ROWTYPE;
  reservation public.app_budget_reservations%ROWTYPE;
BEGIN
  IF (length(owner_t) BETWEEN 1 AND 200 AND length(owner_s) BETWEEN 1 AND 200
      AND op IS NOT NULL AND correction IS NOT NULL
      AND input ? 'expectedActualMicros' AND input ? 'correctedActualMicros'
      AND (expected IS NULL OR expected BETWEEN 0 AND 1000000000000)
      AND corrected BETWEEN 0 AND 1000000000000
      AND length(input->>'actor') BETWEEN 1 AND 100
      AND length(input->>'reason') BETWEEN 10 AND 1000
      AND length(input->>'evidenceRef') BETWEEN 1 AND 500) IS NOT TRUE THEN
    RAISE EXCEPTION 'Invalid budget correction';
  END IF;
  PERFORM 1 FROM public.app_budget_accounts WHERE tenant=owner_t AND subject=owner_s FOR UPDATE;
  SELECT * INTO existing FROM public.app_budget_corrections WHERE correction_id=correction;
  IF FOUND THEN
    IF existing.operation_id=op AND existing.tenant=owner_t AND existing.subject=owner_s
      AND existing.previous_actual_micros IS NOT DISTINCT FROM expected
      AND existing.corrected_actual_micros=corrected
      AND existing.actor=input->>'actor' AND existing.reason=input->>'reason'
      AND existing.evidence_ref=input->>'evidenceRef' THEN
      RETURN 'already_applied';
    END IF;
    RETURN 'conflict';
  END IF;
  SELECT * INTO reservation FROM public.app_budget_reservations WHERE operation_id=op AND tenant=owner_t AND subject=owner_s;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF reservation.status<>'settled' OR reservation.actual_micros IS DISTINCT FROM expected
      OR reservation.actual_micros IS NOT DISTINCT FROM corrected THEN RETURN 'conflict'; END IF;
  UPDATE public.app_budget_reservations SET actual_micros=corrected WHERE operation_id=op;
  INSERT INTO public.app_budget_corrections(correction_id,operation_id,tenant,subject,previous_actual_micros,
    corrected_actual_micros,actor,reason,evidence_ref,at)
  VALUES(correction,op,owner_t,owner_s,expected,corrected,input->>'actor',input->>'reason',input->>'evidenceRef',correction_at);
  RETURN 'applied';
EXCEPTION WHEN unique_violation THEN RETURN 'conflict';
END $$;
REVOKE ALL ON FUNCTION public.app_budget_correct_settlement(jsonb) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.app_budget_corrections FROM anon;
    REVOKE ALL ON FUNCTION public.app_budget_correct_settlement(jsonb) FROM anon;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.app_budget_corrections FROM authenticated;
    REVOKE ALL ON FUNCTION public.app_budget_correct_settlement(jsonb) FROM authenticated;
  END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT ON public.app_budget_corrections TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_budget_correct_settlement(jsonb) TO service_role;
  END IF;
END $$;
