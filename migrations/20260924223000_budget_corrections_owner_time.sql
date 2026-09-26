-- Account-visible correction history pages without scanning other owners.
CREATE INDEX budget_corrections_owner_time
  ON public.app_budget_corrections(tenant,subject,at,correction_id);
