ALTER TABLE operator_prices
  MODIFY COLUMN customer_unit_price DECIMAL(20,10) NOT NULL,
  MODIFY COLUMN cost_unit_price DECIMAL(20,10) NOT NULL DEFAULT 0;

ALTER TABLE studio_task_items
  MODIFY COLUMN customer_unit_price DECIMAL(20,10) NOT NULL,
  MODIFY COLUMN cost_unit_price DECIMAL(20,10) NOT NULL;
