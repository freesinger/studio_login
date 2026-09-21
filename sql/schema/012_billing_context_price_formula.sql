ALTER TABLE operator_prices
  ADD COLUMN customer_price_formula TEXT NULL AFTER customer_unit_price,
  ADD COLUMN cost_price_formula TEXT NULL AFTER cost_unit_price;
