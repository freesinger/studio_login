import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const appSource = readFileSync(join(root, 'public/app.js'), 'utf8');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');

describe('config group read-only UI contract', () => {
  it('marks env-locked groups as view-only in the admin UI', () => {
    expect(appSource).toContain('group.readOnly');
    expect(appSource).toContain('groups.readOnlyBadge');
    expect(appSource).toContain('data-config-action="delete"');
    expect(appSource).toContain('setConfigFormReadOnly(form, true)');
    expect(html).toContain('id="config-readonly-help"');
    expect(html).toContain('id="config-submit"');
  });
});
