CREATE TABLE public.app_conversation_runs (
  operation_id uuid NOT NULL REFERENCES public.app_conversations(operation_id) ON DELETE CASCADE,
  turn_id text NOT NULL,first_ordinal bigint NOT NULL CHECK(first_ordinal>0),payload text NOT NULL,
  PRIMARY KEY(operation_id,turn_id));
CREATE INDEX app_conversation_runs_page ON public.app_conversation_runs(operation_id,first_ordinal);
ALTER TABLE public.app_conversation_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_conversation_runs FROM PUBLIC;

CREATE FUNCTION public.app_run_cache(p_facts jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE summary jsonb; latest jsonb; result text;
BEGIN
  IF (SELECT count(*) FROM jsonb_each(p_facts))>4096 THEN RAISE EXCEPTION 'Run materialization exceeds its fact limit'; END IF;
  SELECT jsonb_build_object('state',f->'state','at',f->'at','sourceIndex',f->'sourceIndex','code',f->'code') INTO latest
    FROM jsonb_each(p_facts) AS x(k,f) WHERE f->>'kind'='run' AND f->>'sourceIndex' IS NOT NULL
    ORDER BY (f->>'sourceIndex')::bigint DESC LIMIT 1;
  SELECT jsonb_build_object('firstIndex',min((f->>'ordinal')::bigint),
    'startedAt',min(f->>'at') FILTER(WHERE f->>'state'='running'),
    'models',coalesce(jsonb_agg(DISTINCT f->>'model' ORDER BY f->>'model') FILTER(WHERE f->>'model' IS NOT NULL),'[]'::jsonb),
    'unindexedFacts',count(*) FILTER(WHERE f->>'sourceIndex' IS NULL),'lastFactSourceIndex',max((f->>'sourceIndex')::bigint),
    'boundaryCount',count(*) FILTER(WHERE f->>'kind'='run'),
    'unindexedBoundaries',count(*) FILTER(WHERE f->>'kind'='run' AND f->>'sourceIndex' IS NULL),
    'latest',latest) INTO summary FROM jsonb_each(p_facts) AS x(k,f);
  result:=jsonb_build_object('schemaVersion',1,'facts',p_facts,'summary',summary)::text;
  IF octet_length(result)>524288 THEN RAISE EXCEPTION 'Run materialization exceeds its size limit'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.app_materialize_run(p_existing text,p_entry text,p_ordinal bigint,p_source bigint)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT public.app_run_cache(coalesce(p_existing::jsonb->'facts','{}'::jsonb)||jsonb_build_object(
    e->>'eventId',jsonb_build_object('kind',e->'payload'->'kind','at',e->'at','ordinal',p_ordinal,'sourceIndex',p_source,
      'state',e->'payload'->'state','code',e->'payload'->'code','model',e->'payload'->'modelId')))
  FROM (SELECT p_entry::jsonb AS e) AS entry;
$$;

CREATE FUNCTION public.app_capture_conversation_run() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF NEW.payload::jsonb->'payload'->>'kind' NOT IN ('run','model') THEN RETURN NEW; END IF;
  INSERT INTO public.app_conversation_runs(operation_id,turn_id,first_ordinal,payload)
    VALUES(NEW.operation_id,NEW.payload::jsonb->>'turnId',NEW.ordinal,
      public.app_materialize_run(NULL,NEW.payload,NEW.ordinal,NEW.source_index))
    ON CONFLICT(operation_id,turn_id) DO UPDATE SET first_ordinal=least(app_conversation_runs.first_ordinal,excluded.first_ordinal),
      payload=public.app_materialize_run(app_conversation_runs.payload,NEW.payload,NEW.ordinal,NEW.source_index);
  RETURN NEW;
END $$;
CREATE TRIGGER app_capture_conversation_run AFTER INSERT OR UPDATE OF source_index ON public.app_conversation_events
  FOR EACH ROW EXECUTE FUNCTION public.app_capture_conversation_run();

INSERT INTO public.app_conversation_runs(operation_id,turn_id,first_ordinal,payload)
  SELECT operation_id,payload::jsonb->>'turnId',min(ordinal),public.app_run_cache(jsonb_object_agg(event_id,
    jsonb_build_object('kind',payload::jsonb->'payload'->'kind','at',payload::jsonb->'at','ordinal',ordinal,'sourceIndex',source_index,
      'state',payload::jsonb->'payload'->'state','code',payload::jsonb->'payload'->'code','model',payload::jsonb->'payload'->'modelId')))
  FROM public.app_conversation_events WHERE payload::jsonb->'payload'->>'kind' IN ('run','model')
  GROUP BY operation_id,payload::jsonb->>'turnId';

REVOKE ALL ON FUNCTION public.app_run_cache(jsonb),public.app_materialize_run(text,text,bigint,bigint),public.app_capture_conversation_run() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.app_conversation_runs FROM anon; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.app_conversation_runs FROM authenticated; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_conversation_runs TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_run_cache(jsonb),public.app_materialize_run(text,text,bigint,bigint),public.app_capture_conversation_run() TO service_role;
  END IF;
END $$;
