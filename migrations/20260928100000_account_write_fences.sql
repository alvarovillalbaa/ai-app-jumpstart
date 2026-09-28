-- Operator-only, permanent application-row write fences. The app cannot insert,
-- update or remove a fence through PostgREST; read/write checks run in triggers.
CREATE SCHEMA IF NOT EXISTS app_private;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
CREATE TABLE app_private.account_fences (
  tenant text NOT NULL CHECK (length(tenant) BETWEEN 1 AND 200),
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant,subject)
);
REVOKE ALL ON app_private.account_fences FROM PUBLIC;

-- The same transaction lock in the operator INSERT and every application row
-- trigger establishes an ordering: either a write commits before the fence or
-- the write observes the committed fence and fails. Require READ COMMITTED so
-- a transaction that began before the fence cannot use an older snapshot.
CREATE FUNCTION app_private.account_fence_lock(p_tenant text,p_subject text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Account writes require read committed isolation' USING ERRCODE = '55000';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    pg_catalog.jsonb_build_array(p_tenant,p_subject)::text,55092));
END $$;

CREATE FUNCTION app_private.account_fence_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_private.account_fence_lock(NEW.tenant,NEW.subject);
  RETURN NEW;
END $$;
CREATE TRIGGER app_account_fence_insert BEFORE INSERT ON app_private.account_fences
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_insert();

CREATE FUNCTION app_private.account_fence_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Account write fences are permanent' USING ERRCODE = '55000';
END $$;
CREATE TRIGGER app_account_fence_immutable BEFORE UPDATE OR DELETE ON app_private.account_fences
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_immutable();

CREATE FUNCTION app_private.account_fence_assert_open(p_tenant text,p_subject text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_tenant IS NULL OR p_subject IS NULL THEN
    RAISE EXCEPTION 'Account row has no attributable owner' USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.account_fence_lock(p_tenant,p_subject);
  IF EXISTS (SELECT 1 FROM app_private.account_fences WHERE tenant=p_tenant AND subject=p_subject) THEN
    RAISE EXCEPTION 'Account application writes are fenced' USING ERRCODE = '55000';
  END IF;
END $$;

CREATE FUNCTION app_private.account_fence_child_owner(p_kind text,p_key text,
  OUT owner_tenant text,OUT owner_subject text) RETURNS record
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_key IS NULL THEN RAISE EXCEPTION 'Account child has no owner key' USING ERRCODE = '55000'; END IF;
  IF p_kind='conversation' THEN
    SELECT tenant,subject INTO owner_tenant,owner_subject FROM public.app_conversations WHERE operation_id=p_key::uuid;
  ELSIF p_kind='reservation' THEN
    SELECT tenant,subject INTO owner_tenant,owner_subject FROM public.app_budget_reservations WHERE operation_id=p_key::uuid;
  ELSIF p_kind='upload' THEN
    SELECT tenant,subject INTO owner_tenant,owner_subject FROM public.app_uploads WHERE id=p_key::uuid;
  ELSIF p_kind='artifact' THEN
    SELECT c.tenant,c.subject INTO owner_tenant,owner_subject FROM public.app_artifacts a
      JOIN public.app_conversations c ON c.operation_id=a.operation_id WHERE a.id=p_key::uuid;
  ELSE
    RAISE EXCEPTION 'Unsupported account child owner path' USING ERRCODE = '55000';
  END IF;
  IF owner_tenant IS NULL OR owner_subject IS NULL THEN
    RAISE EXCEPTION 'Account child has no attributable owner' USING ERRCODE = '55000';
  END IF;
END $$;

CREATE FUNCTION app_private.account_fence_guard_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  owner_t text;
  owner_s text;
  old_key text;
  new_key text;
BEGIN
  IF TG_NARGS=0 THEN
    IF TG_OP='UPDATE' AND (OLD.tenant IS DISTINCT FROM NEW.tenant OR OLD.subject IS DISTINCT FROM NEW.subject) THEN
      RAISE EXCEPTION 'Account row owner cannot change' USING ERRCODE = '55000';
    END IF;
    PERFORM app_private.account_fence_assert_open(NEW.tenant,NEW.subject);
  ELSE
    new_key := to_jsonb(NEW)->>TG_ARGV[1];
    IF TG_OP='UPDATE' THEN
      old_key := to_jsonb(OLD)->>TG_ARGV[1];
      IF old_key IS DISTINCT FROM new_key THEN
        RAISE EXCEPTION 'Account child owner key cannot change' USING ERRCODE = '55000';
      END IF;
    END IF;
    SELECT owner_tenant,owner_subject INTO owner_t,owner_s
      FROM app_private.account_fence_child_owner(TG_ARGV[0],new_key);
    PERFORM app_private.account_fence_assert_open(owner_t,owner_s);
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'app_records','app_record_creates','app_conversations','app_budget_accounts',
    'app_budget_reservations','app_budget_corrections','app_uploads',
    'app_user_preferences','app_request_limits'
  ] LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write()',table_name);
  END LOOP;
END $$;

CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_conversation_events
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('conversation','operation_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_conversation_runs
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('conversation','operation_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_artifacts
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('conversation','operation_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_artifact_versions
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('artifact','artifact_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_budget_attempts
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('reservation','operation_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_upload_scans
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('upload','upload_id');
CREATE TRIGGER app_account_fence_write BEFORE INSERT OR UPDATE ON public.app_upload_reviews
  FOR EACH ROW EXECUTE FUNCTION app_private.account_fence_guard_write('upload','upload_id');

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app_private FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA app_private FROM anon;
    REVOKE ALL ON app_private.account_fences FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA app_private FROM authenticated;
    REVOKE ALL ON app_private.account_fences FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON SCHEMA app_private FROM service_role;
    REVOKE ALL ON app_private.account_fences FROM service_role;
  END IF;
END $$;
