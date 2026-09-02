import type { RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { decryptJson } from './security.js';
import type { ResourceConfig } from './types.js';

export interface DerivedBillingCatalogItem {
  billingItemId: string;
  unit: string;
  operatorIds: string[];
  connectionNames: string[];
  custom: boolean;
  source: 'CUSTOM_MODEL';
  modelName: string;
  configGroupIds: string[];
  configGroupNames: string[];
}

interface ConfigGroupVersionRow extends RowDataPacket {
  config_group_id: string;
  name: string;
  encrypted_config: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function safeModelName(value: string): string {
  return value.trim();
}

function pushItem(
  items: Map<string, DerivedBillingCatalogItem>,
  input: {
    billingItemId: string;
    unit: string;
    operatorId: string;
    modelName: string;
    configGroupId: string;
    configGroupName: string;
  },
): void {
  const billingItemId = input.billingItemId.trim();
  const unit = input.unit.trim();
  if (!billingItemId || !unit || billingItemId.length > 128 || unit.length > 32) return;
  const key = `${billingItemId}\0${unit}`;
  const current = items.get(key) ?? {
    billingItemId,
    unit,
    operatorIds: [],
    connectionNames: [],
    custom: true,
    source: 'CUSTOM_MODEL' as const,
    modelName: input.modelName,
    configGroupIds: [],
    configGroupNames: [],
  };
  current.operatorIds = [...new Set([...current.operatorIds, input.operatorId])].sort();
  current.configGroupIds = [...new Set([...current.configGroupIds, input.configGroupId])].sort();
  current.configGroupNames = [...new Set([...current.configGroupNames, input.configGroupName])].sort();
  items.set(key, current);
}

function collectFromConfig(
  items: Map<string, DerivedBillingCatalogItem>,
  config: ResourceConfig,
  configGroupId: string,
  configGroupName: string,
): void {
  for (const value of arrayValue(config.customLlmModelConfigs)) {
    if (!isRecord(value)) continue;
    const model = safeModelName(readString(value, 'model', 'modelName', 'name', 'id'));
    if (!model) continue;
    pushItem(items, {
      billingItemId: `openai_responses_${model}`,
      unit: 'request',
      operatorId: 'openai_responses',
      modelName: model,
      configGroupId,
      configGroupName,
    });
  }

  for (const value of arrayValue(config.customImageModelConfigs)) {
    if (!isRecord(value)) continue;
    const model = safeModelName(readString(value, 'model', 'modelName', 'name', 'id'));
    if (!model) continue;
    pushItem(items, {
      billingItemId: `openai_image_generations_${model}`,
      unit: 'image',
      operatorId: 'openai_image_generations',
      modelName: model,
      configGroupId,
      configGroupName,
    });
    pushItem(items, {
      billingItemId: `openai_image_edits_${model}`,
      unit: 'image',
      operatorId: 'openai_image_edits',
      modelName: model,
      configGroupId,
      configGroupName,
    });
  }

  for (const value of arrayValue(config.customModels)) {
    if (!isRecord(value)) continue;
    const model = safeModelName(readString(value, 'model', 'modelName', 'name', 'id'));
    if (!model) continue;
    const modelType = readString(value, 'modelType', 'type').toUpperCase();
    if (modelType === 'LANGUAGE' || modelType === 'LLM' || modelType === 'TEXT') {
      pushItem(items, {
        billingItemId: `openai_responses_${model}`,
        unit: 'request',
        operatorId: 'openai_responses',
        modelName: model,
        configGroupId,
        configGroupName,
      });
    }
    if (modelType === 'IMAGE' || !modelType) {
      pushItem(items, {
        billingItemId: `openai_image_generations_${model}`,
        unit: 'image',
        operatorId: 'openai_image_generations',
        modelName: model,
        configGroupId,
        configGroupName,
      });
      pushItem(items, {
        billingItemId: `openai_image_edits_${model}`,
        unit: 'image',
        operatorId: 'openai_image_edits',
        modelName: model,
        configGroupId,
        configGroupName,
      });
    }
  }
}

export async function derivedCustomBillingCatalog(
  database: Database,
  config: AppConfig,
  accountId: string,
): Promise<DerivedBillingCatalogItem[]> {
  const rows = await database.query<ConfigGroupVersionRow>(
    `SELECT g.config_group_id, g.name, v.encrypted_config
       FROM config_groups g
       JOIN config_group_versions v ON v.config_group_id = g.config_group_id
        AND v.version = CASE WHEN g.current_version > 0 THEN g.current_version ELSE (
          SELECT MAX(v2.version) FROM config_group_versions v2 WHERE v2.config_group_id = g.config_group_id
        ) END
      WHERE g.account_id = ? AND g.status <> 'DELETED'`,
    [accountId],
  );
  const items = new Map<string, DerivedBillingCatalogItem>();
  for (const row of rows) {
    const resourceConfig = decryptJson<ResourceConfig>(row.encrypted_config, config.encryptionKey);
    collectFromConfig(items, resourceConfig, row.config_group_id, row.name);
  }
  return [...items.values()].sort((left, right) =>
    left.billingItemId.localeCompare(right.billingItemId) || left.unit.localeCompare(right.unit));
}
