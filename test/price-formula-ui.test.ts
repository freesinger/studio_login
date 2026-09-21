import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const appSource = readFileSync(join(root, 'public/app.js'), 'utf8');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const styles = readFileSync(join(root, 'public/styles.css'), 'utf8');

describe('price formula UI contract', () => {
  it('provides independent customer and cost formula tabs and trial results', () => {
    expect(html).toContain('name="customerPricingMode"');
    expect(html).toContain('name="customerPriceFormula"');
    expect(html).toContain('id="price-customer-formula-tab"');
    expect(html).toContain('name="costPricingMode"');
    expect(html).toContain('name="costPriceFormula"');
    expect(html).toContain('id="price-cost-formula-tab"');
    expect(html).toContain('id="price-customer-formula-result"');
    expect(html).toContain('id="price-cost-formula-result"');
  });

  it('uses the dual-formula API contract for validation and saving', () => {
    expect(appSource).toContain('customerFormula: form.elements.customerPricingMode.value');
    expect(appSource).toContain('costFormula: form.elements.costPricingMode.value');
    expect(appSource).toContain('customerPricingMode: form.elements.customerPricingMode.value');
    expect(appSource).toContain('customerPriceFormula: form.elements.customerPricingMode.value');
    expect(appSource).toContain('costPricingMode: form.elements.costPricingMode.value');
    expect(appSource).toContain('costPriceFormula: form.elements.costPricingMode.value');
    expect(appSource).toContain('result.customerAmount');
    expect(appSource).toContain('result.costAmount');
  });

  it('keeps the sample focused on token fields without a. or extensions', () => {
    const examples = appSource.slice(
      appSource.indexOf('const chatPriceFormulaExample'),
      appSource.indexOf('const defaultCustomImageRatios'),
    );
    expect(examples).toContain('prompt_tokens_details.cached_tokens');
    expect(examples).toContain('input_tokens_details.cached_tokens');
    expect(examples).toContain('audio_tokens: null');
    expect(examples).not.toContain('a.prompt_tokens');
    expect(examples).not.toContain('extensions');
  });

  it('uses Responses token examples for scoped custom model prices without checking name prefixes', () => {
    expect(appSource).toContain('item?.source === \'CUSTOM_MODEL\'');
    expect(appSource).not.toContain('startsWith(\'openai_responses_\')');
  });

  it('hides formula text in the table until its badge receives hover or focus', () => {
    expect(appSource).toContain('class="badge neutral">${t(\'pricing.formulaBadge\')}</span>');
    expect(appSource).toContain('class="formula-price-tooltip-content" role="tooltip"');
    expect(appSource).toContain('formulaPriceCell(item.customerPriceFormula');
    expect(appSource).toContain('formulaPriceCell(item.costPriceFormula');
    expect(styles).toMatch(/\.formula-price-tooltip-content\s*\{[^}]*opacity:\s*0;[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(
      /\.formula-price-tooltip:hover \.formula-price-tooltip-content,\s*\.formula-price-tooltip:focus-visible \.formula-price-tooltip-content\s*\{[^}]*opacity:\s*1;[^}]*visibility:\s*visible;/s,
    );
  });

  it('does not render a formula support-range notice for ordinary price configuration', () => {
    expect(html).not.toContain('data-i18n="pricing.formulaUnsupportedHelp"');
  });
});
