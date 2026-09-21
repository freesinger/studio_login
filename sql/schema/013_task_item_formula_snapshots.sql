ALTER TABLE studio_task_items
  ADD COLUMN customer_price_formula TEXT NULL AFTER customer_unit_price,
  ADD COLUMN cost_price_formula TEXT NULL AFTER cost_unit_price,
  ADD COLUMN estimated_customer_amount DECIMAL(20,6) NULL AFTER cost_price_formula,
  ADD COLUMN actual_customer_amount DECIMAL(20,6) NULL AFTER estimated_customer_amount,
  ADD COLUMN estimated_cost_amount DECIMAL(20,6) NULL AFTER actual_customer_amount,
  ADD COLUMN actual_cost_amount DECIMAL(20,6) NULL AFTER estimated_cost_amount;
