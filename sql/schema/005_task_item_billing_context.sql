ALTER TABLE studio_task_items
  ADD COLUMN estimated_billing_context JSON NULL AFTER cost_unit_price,
  ADD COLUMN actual_billing_context JSON NULL AFTER estimated_billing_context;
