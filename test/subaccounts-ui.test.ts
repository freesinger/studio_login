import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const appSource = readFileSync(join(root, 'public/app.js'), 'utf8');
const html = readFileSync(join(root, 'public/index.html'), 'utf8');

const renderUsersSource = appSource.slice(
  appSource.indexOf('function renderUsers()'),
  appSource.indexOf('function closeUserActionMenu()'),
);
const openUserDialogSource = appSource.slice(
  appSource.indexOf('function openUserDialog('),
  appSource.indexOf('async function submitUser('),
);
const submitUserSource = appSource.slice(
  appSource.indexOf('async function submitUser('),
  appSource.indexOf('async function setUserStatus('),
);

describe('subaccount list UI contract', () => {
  it('supports multi-select config-group filtering and settled amount sorting', () => {
    expect(html).toContain('id="user-group-filter-trigger"');
    expect(html).toContain('id="user-group-filter-menu"');
    expect(html).toContain('id="user-settled-sort-asc"');
    expect(html).toContain('id="user-settled-sort-desc"');
    expect(appSource).toContain('state.userGroupFilter');
    expect(appSource).toContain('data-user-group-filter-id');
    expect(appSource).toContain('function visibleUserBindings');
    expect(appSource).toContain('function userSettledAmount');
    expect(appSource).toContain("state.userSettledSort = 'asc'");
    expect(appSource).toContain("state.userSettledSort = 'desc'");
  });

  it('renders only matching binding rows when a group filter is active', () => {
    expect(renderUsersSource).toContain('const bindings = visibleUserBindings(user);');
    expect(renderUsersSource).toContain('binding.quota?.actualAmount');
    expect(renderUsersSource).toContain('users.filteredEmpty');
  });

  it('prefills existing editable passwords and submits only changed passwords', () => {
    expect(openUserDialogSource).toContain("form.dataset.originalPassword = user?.password || '';");
    expect(openUserDialogSource).toContain("form.elements.password.value = user?.password || '';");
    expect(submitUserSource).toContain("const originalPassword = form.dataset.originalPassword || '';");
    expect(submitUserSource).toContain("const passwordChanged = !userId || (Boolean(newPassword) && newPassword !== originalPassword);");
    expect(submitUserSource).toContain('if (passwordChanged && newPassword) payload.password = newPassword;');
  });
});
