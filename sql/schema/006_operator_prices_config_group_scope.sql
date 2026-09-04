ALTER TABLE operator_prices
  DROP INDEX uk_operator_prices_scope_item,
  ADD COLUMN scope_type VARCHAR(32) NULL AFTER price_id,
  ADD COLUMN scope_id VARCHAR(64) NULL AFTER scope_type;

UPDATE operator_prices
   SET scope_type = 'PLATFORM', scope_id = '*'
 WHERE app_id = '*';

INSERT INTO operator_prices
  (price_id, scope_type, scope_id, app_id, billing_item_id, unit,
   customer_unit_price, cost_unit_price, enabled, updated_by, created_at, updated_at)
SELECT
  CONCAT('price_mig_', LEFT(SHA2(CONCAT(selected.price_id, ':', selected.config_group_id), 256), 54)),
  'CONFIG_GROUP',
  selected.config_group_id,
  selected.app_id,
  selected.billing_item_id,
  selected.unit,
  selected.customer_unit_price,
  selected.cost_unit_price,
  selected.enabled,
  selected.updated_by,
  selected.created_at,
  selected.updated_at
FROM (
  SELECT candidates.*,
         ROW_NUMBER() OVER (
           PARTITION BY candidates.config_group_id, candidates.billing_item_id, candidates.unit
           ORDER BY candidates.scope_priority, candidates.updated_at DESC
         ) AS scope_rank
    FROM (
      SELECT p.*, scopes.config_group_id,
             CASE WHEN p.app_id = scopes.app_id THEN 0 ELSE 1 END AS scope_priority
        FROM operator_prices p
        JOIN (
          SELECT DISTINCT g.config_group_id, g.account_id, r.app_id
            FROM config_groups g
            JOIN studio_registrations r ON r.connection_id = g.connection_id
           WHERE g.status <> 'DELETED'
        ) scopes ON scopes.account_id = p.app_id OR scopes.app_id = p.app_id
       WHERE p.app_id <> '*' AND p.scope_id IS NULL
    ) candidates
) selected
WHERE selected.scope_rank = 1;

DELETE FROM operator_prices WHERE scope_id IS NULL;

ALTER TABLE operator_prices
  MODIFY COLUMN scope_type VARCHAR(32) NOT NULL,
  MODIFY COLUMN scope_id VARCHAR(64) NOT NULL,
  DROP COLUMN app_id,
  ADD UNIQUE KEY uk_operator_prices_scope_item
    (scope_type, scope_id, billing_item_id, unit),
  ADD CONSTRAINT ck_operator_prices_scope
    CHECK (
      (scope_type = 'PLATFORM' AND scope_id = '*')
      OR (scope_type = 'CONFIG_GROUP' AND scope_id <> '*')
    );
