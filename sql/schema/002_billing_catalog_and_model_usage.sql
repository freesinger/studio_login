ALTER TABLE studio_registrations
  ADD COLUMN billing_catalog_json JSON NULL AFTER actual_url,
  ADD COLUMN billing_catalog_synced_at DATETIME(3) NULL AFTER billing_catalog_json,
  ADD COLUMN billing_catalog_error VARCHAR(512) NULL AFTER billing_catalog_synced_at;

ALTER TABLE studio_task_items
  ADD COLUMN model_id VARCHAR(128) NULL AFTER billing_item_id;
