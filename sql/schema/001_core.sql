CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS system_state (
  id TINYINT NOT NULL PRIMARY KEY,
  initialized BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT ck_system_state_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT IGNORE INTO system_state (id, initialized) VALUES (1, FALSE);

CREATE TABLE IF NOT EXISTS accounts (
  account_id VARCHAR(64) NOT NULL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'READY',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS users (
  user_id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  login_name VARCHAR(128) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  password_cipher MEDIUMTEXT NULL,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  config_group_id VARCHAR(64) NULL,
  profile_sync_version INT NULL,
  profile_sync_error_code VARCHAR(128) NULL,
  profile_sync_error_message VARCHAR(512) NULL,
  profile_sync_request_id VARCHAR(255) NULL,
  monthly_limit DECIMAL(20,6) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_users_account_login (account_id, login_name),
  KEY idx_users_account (account_id, status),
  CONSTRAINT fk_users_account FOREIGN KEY (account_id) REFERENCES accounts(account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS studio_registrations (
  connection_id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  name VARCHAR(128) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  app_id VARCHAR(64) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  studio_base_url VARCHAR(1024) NULL,
  callback_base_url VARCHAR(1024) NULL,
  integration_token_cipher MEDIUMTEXT NULL,
  ticket_url VARCHAR(1024) NOT NULL,
  estimate_url VARCHAR(1024) NOT NULL,
  actual_url VARCHAR(1024) NOT NULL,
  last_error VARCHAR(512) NULL,
  registered_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_studio_registrations_account_name (account_id, name),
  KEY idx_studio_registrations_account_status (account_id, status),
  CONSTRAINT fk_studio_registration_account FOREIGN KEY (account_id) REFERENCES accounts(account_id),
  CONSTRAINT fk_studio_registration_user FOREIGN KEY (registered_by) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS config_groups (
  config_group_id VARCHAR(64) NOT NULL PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(128) NOT NULL,
  name VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  current_version INT NOT NULL DEFAULT 0,
  monthly_limit DECIMAL(20,6) NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_config_groups_account_name (account_id, name),
  KEY idx_config_groups_account (account_id, status),
  CONSTRAINT fk_config_groups_account FOREIGN KEY (account_id) REFERENCES accounts(account_id),
  CONSTRAINT fk_config_groups_connection FOREIGN KEY (connection_id) REFERENCES studio_registrations(connection_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE users
  ADD CONSTRAINT fk_users_config_group
  FOREIGN KEY (config_group_id) REFERENCES config_groups(config_group_id);

CREATE TABLE IF NOT EXISTS config_group_versions (
  config_group_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  encrypted_config MEDIUMTEXT NOT NULL,
  masked_config JSON NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (config_group_id, version),
  CONSTRAINT fk_config_versions_group FOREIGN KEY (config_group_id) REFERENCES config_groups(config_group_id) ON DELETE CASCADE,
  CONSTRAINT fk_config_versions_creator FOREIGN KEY (created_by) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS studio_login_tickets (
  ticket_hash CHAR(64) NOT NULL PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(128) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_studio_tickets_expiry (expires_at),
  KEY idx_studio_tickets_user (connection_id, app_id, user_id, consumed_at),
  CONSTRAINT fk_studio_tickets_connection FOREIGN KEY (connection_id) REFERENCES studio_registrations(connection_id),
  CONSTRAINT fk_studio_tickets_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS api_rate_limits (
  action VARCHAR(64) NOT NULL,
  subject_key VARCHAR(255) NOT NULL,
  window_started_at DATETIME(3) NOT NULL,
  request_count INT NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (action, subject_key),
  KEY idx_rate_limits_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS operator_prices (
  price_id VARCHAR(64) NOT NULL PRIMARY KEY,
  app_id VARCHAR(64) NOT NULL DEFAULT '*',
  billing_item_id VARCHAR(128) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  customer_unit_price DECIMAL(20,8) NOT NULL,
  cost_unit_price DECIMAL(20,8) NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_operator_prices_scope_item (app_id, billing_item_id, unit),
  CONSTRAINT fk_operator_prices_user FOREIGN KEY (updated_by) REFERENCES users(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS studio_tasks (
  task_id VARCHAR(64) NOT NULL PRIMARY KEY,
  connection_id VARCHAR(64) NOT NULL,
  app_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(128) NOT NULL,
  config_group_id VARCHAR(64) NOT NULL,
  config_group_version INT NOT NULL,
  billing_period CHAR(7) NOT NULL,
  status VARCHAR(32) NOT NULL,
  estimated_amount DECIMAL(20,6) NOT NULL,
  actual_amount DECIMAL(20,6) NULL,
  estimated_cost DECIMAL(20,6) NOT NULL,
  actual_cost DECIMAL(20,6) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY uk_studio_tasks_connection_request (connection_id, request_id),
  KEY idx_studio_tasks_period (app_id, billing_period, status),
  CONSTRAINT fk_studio_tasks_connection FOREIGN KEY (connection_id) REFERENCES studio_registrations(connection_id),
  CONSTRAINT fk_studio_tasks_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_studio_tasks_group FOREIGN KEY (config_group_id) REFERENCES config_groups(config_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS studio_task_items (
  task_id VARCHAR(64) NOT NULL,
  billing_item_id VARCHAR(128) NOT NULL,
  unit VARCHAR(32) NOT NULL,
  estimated_usage DECIMAL(20,6) NOT NULL,
  actual_usage DECIMAL(20,6) NULL,
  customer_unit_price DECIMAL(20,8) NOT NULL,
  cost_unit_price DECIMAL(20,8) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
  PRIMARY KEY (task_id, billing_item_id),
  CONSTRAINT fk_studio_task_items_task FOREIGN KEY (task_id) REFERENCES studio_tasks(task_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS period_usage (
  app_id VARCHAR(64) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  billing_period CHAR(7) NOT NULL,
  reserved_amount DECIMAL(20,6) NOT NULL DEFAULT 0,
  actual_amount DECIMAL(20,6) NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (app_id, subject_type, subject_id, billing_period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
