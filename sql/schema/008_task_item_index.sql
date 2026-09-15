SET @ddl = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'studio_task_items'
      AND index_name = 'idx_studio_task_items_billing_item') = 0,
  'ALTER TABLE studio_task_items ADD KEY idx_studio_task_items_billing_item (task_id, billing_item_id)',
  'DO 0'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'studio_task_items'
      AND index_name = 'PRIMARY' AND column_name = 'item_index') = 0
  AND (SELECT COUNT(*) FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'studio_task_items'
      AND column_name = 'item_index') = 0,
  'ALTER TABLE studio_task_items DROP PRIMARY KEY, ADD COLUMN item_index INT NULL AFTER task_id',
  'DO 0'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE studio_task_items i
JOIN (
  SELECT
    task_id,
    billing_item_id,
    ROW_NUMBER() OVER (
      PARTITION BY task_id
      ORDER BY billing_item_id
    ) - 1 AS item_index
  FROM studio_task_items
) ranked
  ON ranked.task_id = i.task_id
 AND ranked.billing_item_id = i.billing_item_id
SET i.item_index = ranked.item_index
WHERE i.item_index IS NULL;

SET @ddl = (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'studio_task_items'
      AND index_name = 'PRIMARY' AND column_name = 'item_index') = 0,
  'ALTER TABLE studio_task_items MODIFY COLUMN item_index INT NOT NULL, ADD PRIMARY KEY (task_id, item_index)',
  'DO 0'));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
