import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const appSource = readFileSync(join(root, 'public/app.js'), 'utf8');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');
const styles = readFileSync(join(root, 'public/styles.css'), 'utf8');
const locales = Object.fromEntries(['zh-CN', 'en', 'ja'].map(locale => [
  locale,
  JSON.parse(readFileSync(join(root, `public/locales/${locale}.json`), 'utf8')) as Record<string, string>,
]));

describe('model usage UI contract', () => {
  it('keeps usage metrics and detail cells on one line when space is available', () => {
    expect(html).toContain('<table class="model-usage-table">');
    expect(styles).toMatch(/\.usage-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(140px, 1fr\)\);/s);
    expect(styles).toMatch(/\.usage-tile strong\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.model-usage-table td\s*\{[^}]*white-space:\s*nowrap;/s);
    expect(styles).toMatch(/\.model-usage-table th, \.model-usage-table td\s*\{[^}]*padding:\s*16px 20px;/s);
    expect(styles).toMatch(/\.token-usage\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  });

  it('keeps currency in the summary cards and shortens the detail headers', () => {
    const modelUsageSource = appSource.slice(
      appSource.indexOf('async function loadModelUsage'),
      appSource.indexOf('function switchSection'),
    );
    expect(modelUsageSource).not.toContain('(${currency})');
    expect(locales['zh-CN']?.['modelUsage.taskAudit']).toBe('审计');
    expect(locales.en?.['modelUsage.taskAudit']).toBe('Audit');
    expect(locales.ja?.['modelUsage.taskAudit']).toBe('監査');
  });

  it('shows only the audit arrow while retaining download hints', () => {
    expect(appSource).toMatch(
      /class="audit-download"[^>]*title="\$\{escapeHtml\(t\('common\.download'\)\)\}"[^>]*aria-label="\$\{escapeHtml\(t\('common\.download'\)\)\}"[^>]*><span aria-hidden="true">↓<\/span><\/button>/,
    );
  });
});
