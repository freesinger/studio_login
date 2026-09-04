ALTER TABLE studio_tasks
  ADD COLUMN reconcile_error_info VARCHAR(1024) NULL AFTER last_reconcile_error,
  ADD COLUMN reconcile_attempts INT NOT NULL DEFAULT 0 AFTER reconcile_error_info,
  ADD COLUMN next_reconcile_at DATETIME(3) NULL AFTER reconcile_attempts,
  ADD KEY idx_studio_tasks_reconcile (status, next_reconcile_at, reconcile_attempts);
