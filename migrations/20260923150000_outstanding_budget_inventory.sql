-- Bounded oldest-first operator inventory; no new browser grants or RLS policies.
CREATE INDEX budget_outstanding_time
  ON public.app_budget_reservations(status,created_at,operation_id);
