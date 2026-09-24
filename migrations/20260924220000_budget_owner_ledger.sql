-- Owner-scoped reservation history uses a stable timestamp/operation cursor.
CREATE INDEX budget_owner_ledger
  ON public.app_budget_reservations(tenant,subject,created_at,operation_id);
