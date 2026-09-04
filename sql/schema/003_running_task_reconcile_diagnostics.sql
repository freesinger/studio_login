ALTER TABLE studio_tasks
  ADD COLUMN last_reconcile_at DATETIME(3) NULL AFTER finished_at,
  ADD COLUMN last_reconcile_status VARCHAR(32) NULL AFTER last_reconcile_at,
  ADD COLUMN last_reconcile_error VARCHAR(1024) NULL AFTER last_reconcile_status;
