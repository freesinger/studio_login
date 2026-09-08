CREATE TABLE IF NOT EXISTS user_config_group_bindings (
  user_id VARCHAR(64) NOT NULL,
  config_group_id VARCHAR(64) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_limit DECIMAL(20,6) NULL,
  profile_sync_version INT NULL,
  profile_sync_error_code VARCHAR(128) NULL,
  profile_sync_error_message VARCHAR(512) NULL,
  profile_sync_request_id VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, config_group_id),
  KEY idx_ucgb_group (config_group_id),
  CONSTRAINT fk_ucgb_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
  CONSTRAINT fk_ucgb_group FOREIGN KEY (config_group_id) REFERENCES config_groups(config_group_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO user_config_group_bindings
  (user_id, config_group_id, is_default, monthly_limit, profile_sync_version,
   profile_sync_error_code, profile_sync_error_message, profile_sync_request_id)
SELECT
  user_id,
  config_group_id,
  TRUE,
  monthly_limit,
  profile_sync_version,
  profile_sync_error_code,
  profile_sync_error_message,
  profile_sync_request_id
FROM users
WHERE role = 'SUBACCOUNT'
  AND status <> 'DELETED'
  AND config_group_id IS NOT NULL;
