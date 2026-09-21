import { describe, expect, it } from 'vitest';

import {
  customBillingCatalogForScope,
  supportsBillingContextPriceFormula,
  type DerivedBillingCatalogItem,
} from '../src/custom-billing-items.js';

const customLanguageItem: DerivedBillingCatalogItem = {
  billingItemId: 'openai_responses_gpt-5.6-sol',
  unit: 'request',
  operatorIds: ['openai_responses'],
  connectionNames: [],
  custom: true,
  source: 'CUSTOM_MODEL',
  modelName: 'gpt-5.6-sol',
  configGroupIds: ['group-1'],
  configGroupNames: ['Group 1'],
};

const customRequestItem: DerivedBillingCatalogItem = {
  ...customLanguageItem,
  billingItemId: 'custom-model-request',
  operatorIds: ['custom-model'],
  modelName: 'custom-model',
};

const secondGroupCustomItem: DerivedBillingCatalogItem = {
  ...customLanguageItem,
  billingItemId: 'second-group-request',
  configGroupIds: ['group-2'],
  configGroupNames: ['Group 2'],
};

describe('customBillingCatalogForScope', () => {
  it('keeps all custom billing items for platform default pricing', () => {
    expect(customBillingCatalogForScope(
      [customLanguageItem, secondGroupCustomItem],
      'PLATFORM',
      '*',
    )).toEqual([customLanguageItem, secondGroupCustomItem]);
  });

  it('keeps only the selected config group custom billing items', () => {
    expect(customBillingCatalogForScope(
      [customLanguageItem, secondGroupCustomItem],
      'CONFIG_GROUP',
      'group-1',
    )).toEqual([customLanguageItem]);
  });
});

describe('supportsBillingContextPriceFormula', () => {
  it('allows request items that exist in the Studio catalog under las_llm', () => {
    expect(supportsBillingContextPriceFormula(
      'las_llm_seed-2.1-pro',
      'request',
      [{ billingItemId: 'las_llm_seed-2.1-pro', unit: 'request' }],
      [],
    )).toBe(true);
  });

  it('does not trust an las_llm-looking id that is absent from the Studio catalog', () => {
    expect(supportsBillingContextPriceFormula(
      'las_llm_not-in-studio',
      'request',
      [{ billingItemId: 'las_llm_seed-2.1-pro', unit: 'request' }],
      [],
    )).toBe(false);
  });

  it('allows request items derived from custom language models', () => {
    expect(supportsBillingContextPriceFormula(
      customLanguageItem.billingItemId,
      customLanguageItem.unit,
      [],
      [customLanguageItem],
    )).toBe(true);
  });

  it('allows request custom billing items without relying on the billing item name', () => {
    expect(supportsBillingContextPriceFormula(
      customRequestItem.billingItemId,
      customRequestItem.unit,
      [],
      [customRequestItem],
    )).toBe(true);
  });

  it('does not allow an OpenAI Responses-looking request item unless it belongs to the current custom catalog', () => {
    expect(supportsBillingContextPriceFormula(
      'openai_responses_gpt-5.6-terra',
      'request',
      [],
      [customLanguageItem],
    )).toBe(false);
  });

  it.each([
    {
      name: 'a non-request las_llm item',
      billingItemId: 'las_llm_seed-2.1-pro',
      unit: 'token',
      studioCatalog: [{ billingItemId: 'las_llm_seed-2.1-pro', unit: 'token' }],
    },
    {
      name: 'an image item',
      billingItemId: 'openai_image_generations_gpt-image-2',
      unit: 'image',
      studioCatalog: [{ billingItemId: 'openai_image_generations_gpt-image-2', unit: 'image' }],
    },
    {
      name: 'a video item',
      billingItemId: 'las_video_storyboard_gen',
      unit: 'ou',
      studioCatalog: [{ billingItemId: 'las_video_storyboard_gen', unit: 'ou' }],
    },
    {
      name: 'an ordinary Studio request item',
      billingItemId: 'ordinary_request_item',
      unit: 'request',
      studioCatalog: [{ billingItemId: 'ordinary_request_item', unit: 'request' }],
    },
    {
      name: 'an unknown custom-model-looking request item',
      billingItemId: 'openai_image_edits_unknown',
      unit: 'image',
      studioCatalog: [],
    },
  ])('rejects $name', ({ billingItemId, unit, studioCatalog }) => {
    expect(supportsBillingContextPriceFormula(
      billingItemId,
      unit,
      studioCatalog,
      [customLanguageItem],
    )).toBe(false);
  });
});
