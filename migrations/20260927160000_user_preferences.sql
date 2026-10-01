CREATE TABLE public.app_user_preferences (
  tenant text NOT NULL,subject text NOT NULL,theme text NOT NULL CHECK(theme IN ('system','light','dark')),
  sound_enabled boolean NOT NULL,sound_volume double precision NOT NULL CHECK(sound_volume BETWEEN 0 AND 1),
  revision bigint NOT NULL CHECK(revision>0 AND revision<=9007199254740991),updated_at text NOT NULL,
  PRIMARY KEY(tenant,subject));
ALTER TABLE public.app_user_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_user_preferences FROM PUBLIC;

CREATE FUNCTION public.app_preferences_command(command text,input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE saved public.app_user_preferences; patch jsonb:=input->'patch';
BEGIN
  IF command='get' THEN
    SELECT * INTO saved FROM public.app_user_preferences WHERE tenant=input->>'tenant' AND subject=input->>'subject';
    IF NOT FOUND THEN RETURN jsonb_build_object('schemaVersion',1,'theme','system','soundEnabled',false,'soundVolume',0.5,'revision',0,'updatedAt',NULL); END IF;
  ELSIF command='update' THEN
    IF (patch->>'revision')::bigint=0 THEN
      INSERT INTO public.app_user_preferences(tenant,subject,theme,sound_enabled,sound_volume,revision,updated_at)
        VALUES(input->>'tenant',input->>'subject',coalesce(patch->>'theme','system'),coalesce((patch->>'soundEnabled')::boolean,false),
          coalesce((patch->>'soundVolume')::double precision,0.5),1,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ON CONFLICT(tenant,subject) DO NOTHING RETURNING * INTO saved;
    ELSE
      UPDATE public.app_user_preferences SET theme=coalesce(patch->>'theme',theme),sound_enabled=coalesce((patch->>'soundEnabled')::boolean,sound_enabled),
        sound_volume=coalesce((patch->>'soundVolume')::double precision,sound_volume),revision=revision+1,
        updated_at=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        WHERE tenant=input->>'tenant' AND subject=input->>'subject' AND revision=(patch->>'revision')::bigint RETURNING * INTO saved;
    END IF;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE RAISE EXCEPTION 'Unsupported preference command'; END IF;
  RETURN jsonb_build_object('schemaVersion',1,'theme',saved.theme,'soundEnabled',saved.sound_enabled,'soundVolume',saved.sound_volume,'revision',saved.revision,'updatedAt',saved.updated_at);
END $$;
REVOKE ALL ON FUNCTION public.app_preferences_command(text,jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON public.app_user_preferences FROM anon; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON public.app_user_preferences FROM authenticated; END IF;
  IF EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE ON public.app_user_preferences TO service_role;
    GRANT EXECUTE ON FUNCTION public.app_preferences_command(text,jsonb) TO service_role;
  END IF;
END $$;
