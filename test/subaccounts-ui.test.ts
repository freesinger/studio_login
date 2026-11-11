import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

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

function bindingUi(groups: Array<Record<string, unknown>>, existingGroupIds: string[] = []) {
  const list = { innerHTML: '' };
  const userId = existingGroupIds.length ? 'usr-existing' : '';
  const state = { groups, users: [{ userId: 'usr-existing', bindings: existingGroupIds.map(configGroupId => ({ configGroupId })) }] };
  const source = appSource.slice(
    appSource.indexOf('function selectableUserGroups('),
    appSource.indexOf('function openConfigDialog('),
  ) + appSource.slice(
    appSource.indexOf('function userGroupOptions('),
    appSource.indexOf('function renderUserGroupFilter('),
  );
  const ui = runInNewContext(`${source}\n({ renderUserBindingCards, userGroupOptions, selectableUserGroups });`, {
    state,
    $: (selector: string) => selector === '#user-id' ? { value: userId } : list,
    t: (key: string) => key,
    escapeHtml: (value: string) => value,
    currency: 'USD',
  }) as {
    renderUserBindingCards(bindings?: Array<Record<string, unknown>>): void;
    userGroupOptions(): Array<[string, string]>;
    selectableUserGroups(userId?: string): Array<Record<string, unknown>>;
  };
  return { ui, list };
}

const lockedGroup = { configGroupId: 'grp-locked', projectId: 'locked-project', status: 'AVAILABLE', readOnly: true, isDefault: true };
const editableGroup = { configGroupId: 'grp-editable', projectId: 'editable-project', status: 'PARTIAL_FAILED', readOnly: false };

describe('subaccount list UI contract', () => {
  it('excludes read-only groups from binding choices and default selection but retains filters', () => {
    const { ui, list } = bindingUi([lockedGroup, editableGroup]);
    ui.renderUserBindingCards();
    expect(list.innerHTML).toContain('value="grp-editable" selected');
    expect(list.innerHTML).not.toContain('value="grp-locked"');
    expect(ui.userGroupOptions()).toContainEqual(['grp-locked', 'locked-project']);
    expect(ui.selectableUserGroups()).toEqual([editableGroup]);
    const addBindingSource = appSource.slice(
      appSource.indexOf("$('#add-user-binding').addEventListener"),
      appSource.indexOf("$('#user-binding-list').addEventListener"),
    );
    expect(addBindingSource).toContain('selectableUserGroups()');
  });

  it('preserves the selected read-only binding when editing an existing user', () => {
    const otherLockedGroup = { ...lockedGroup, configGroupId: 'grp-other-locked' };
    const { ui, list } = bindingUi([lockedGroup, otherLockedGroup, editableGroup], ['grp-locked']);
    ui.renderUserBindingCards([{ configGroupId: 'grp-locked', monthlyLimit: '100', isDefault: true }]);
    expect(list.innerHTML).toContain('value="grp-locked" selected');
    expect(list.innerHTML).toContain('value="100"');
    expect(list.innerHTML).not.toContain('groups.readOnlySelection');
    expect(list.innerHTML).not.toContain('value="grp-editable" selected');
    expect(list.innerHTML).not.toContain('value="grp-other-locked"');
    expect(ui.selectableUserGroups('')).toEqual([editableGroup]);
  });

  it('allows editing an existing binding when only read-only groups remain', () => {
    const { ui, list } = bindingUi([lockedGroup], ['grp-locked']);
    ui.renderUserBindingCards([{ configGroupId: 'grp-locked', monthlyLimit: '100', isDefault: true }]);
    expect(list.innerHTML).toContain('value="grp-locked" selected');
    expect(list.innerHTML).not.toContain('<option value=""');
  });

  it('does not offer the old group after an existing user has migrated', () => {
    const { ui } = bindingUi([lockedGroup, editableGroup], ['grp-editable']);
    expect(ui.selectableUserGroups()).toEqual([editableGroup]);
  });

  it('has no assignable group when all groups are read-only', () => {
    const { ui, list } = bindingUi([lockedGroup]);
    ui.renderUserBindingCards();
    expect(list.innerHTML).toContain('<option value="" disabled selected>groups.selectionRequired</option>');
    expect(list.innerHTML).not.toContain('value="grp-locked"');
    expect(ui.userGroupOptions()).toEqual([['grp-locked', 'locked-project']]);
  });

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
