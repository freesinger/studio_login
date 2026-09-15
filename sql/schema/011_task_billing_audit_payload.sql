ALTER TABLE studio_tasks
  ADD COLUMN billing_audit_payload JSON NULL AFTER actual_cost;
