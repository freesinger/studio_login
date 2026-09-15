ALTER TABLE period_usage
  DROP PRIMARY KEY,
  MODIFY COLUMN subject_id VARCHAR(128) NOT NULL,
  ADD PRIMARY KEY (app_id, subject_type, subject_id, billing_period);

INSERT INTO period_usage
  (app_id, subject_type, subject_id, billing_period, reserved_amount, actual_amount)
SELECT
  t.app_id,
  'USER_CONFIG_GROUP',
  CONCAT(t.user_id, ':', t.config_group_id),
  t.billing_period,
  0,
  COALESCE(SUM(COALESCE(t.actual_amount, 0)), 0)
FROM studio_tasks t
WHERE t.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
GROUP BY t.app_id, t.user_id, t.config_group_id, t.billing_period
ON DUPLICATE KEY UPDATE
  actual_amount = VALUES(actual_amount);
