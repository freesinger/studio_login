ALTER TABLE config_groups
  ADD COLUMN project_level_sharing BOOLEAN NOT NULL DEFAULT FALSE AFTER is_default;
