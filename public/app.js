const state = {
  actor: null,
  connection: null,
  connections: [],
  groups: [],
  users: [],
  prices: [],
};

const sectionTitles = {
  overview: '企业概览',
  configs: '资源配置组',
  users: '企业子账号',
  prices: '价格配置',
  bills: '账单',
};

const statusLabels = {
  ACTIVE: '正常',
  AVAILABLE: '可用',
  CANCELLED: '已取消',
  DISABLED: '已停用',
  DRAFT: '草稿',
  FAILED: '失败',
  DELETE_FAILED: '删除失败',
  PARTIAL_FAILED: '部分同步失败',
  PROVISIONING: '配置中',
  READY: '已连接',
  RUNNING: '执行中',
  SUCCEEDED: '成功',
  SYNC_FAILED: '同步失败',
  SYNCING: '同步中',
};

const manualResourceFieldNames = [
  'lasApiKey',
  'arkApiKey',
  'tosBucketName',
];

const defaultStudioBaseUrl = 'https://laslas.cloud';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败（${response.status}）`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = String(value ?? '—');
}

let toastTimer;
function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3500);
}

function setFormMessage(form, message, error = false) {
  const node = form.querySelector('.form-message');
  node.textContent = message;
  node.classList.toggle('error', error);
}

function badge(status) {
  const success = ['ACTIVE', 'AVAILABLE', 'READY', 'SUCCEEDED'].includes(status);
  const warning = ['DRAFT', 'PROVISIONING', 'RUNNING', 'SYNCING'].includes(status);
  const className = success ? 'success' : warning ? 'warning' : 'danger';
  return `<span class="badge ${className}">${escapeHtml(statusLabels[status] || status)}</span>`;
}

function currentPeriod() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function formatMoney(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : '0.00';
}

async function enterStudio() {
  setText('#login-message', '正在创建一次性登录凭证并进入 Studio…');
  const result = await api('/api/studio/tickets/launch', { method: 'POST', body: '{}' });
  window.location.assign(result.launchUrl);
}

async function routeActor(actor) {
  state.actor = actor;
  if (actor.role === 'SUBACCOUNT') {
    await enterStudio();
    return;
  }
  showAdmin(actor);
  await loadAdminData();
}

function showAdmin(actor) {
  $('#login-view').classList.add('hidden');
  $('#admin-view').classList.remove('hidden');
  setText('#actor-name', actor.displayName || actor.loginName);
  setText('#actor-role', actor.role === 'SYSTEM_ADMIN' ? '系统管理员' : '企业管理员');
  setText('#actor-avatar', (actor.displayName || actor.loginName || 'A').slice(0, 1).toUpperCase());
  setText('#account-name', actor.accountId);
  $('#bill-period').value = currentPeriod();
  if (actor.role !== 'SYSTEM_ADMIN') {
    $$('.system-admin-only').forEach(node => node.classList.add('hidden'));
  }
}

async function loadAdminData() {
  const loaders = [loadConnections(), loadConfigGroups(), loadUsers(), loadBills(currentPeriod())];
  if (state.actor.role === 'SYSTEM_ADMIN') loaders.push(loadPrices());
  const results = await Promise.allSettled(loaders);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) toast(failed.reason.message, true);
}

async function loadConnections() {
  const result = await api(`/api/admin/studio/connections?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.connections = result.items || [];
  state.connection = state.connections.find(item => item.isDefault) || state.connections[0] || null;
  const select = $('#config-connection');
  select.innerHTML = state.connections
    .filter(item => item.status === 'READY')
    .map(item => `<option value="${escapeHtml(item.connectionId)}">${escapeHtml(item.name)}</option>`)
    .join('') || '<option value="">请先创建可用连接</option>';
  const cards = state.connections.map(item => `<article class="connection-card">
    <div class="connection-card-header">
      <div class="connection-card-title"><h3>${escapeHtml(item.name)}</h3>${item.isDefault ? '<span class="badge neutral">默认</span>' : ''}</div>
      ${badge(item.status)}
    </div>
    <dl class="connection-details">
      <div><dt>Studio 服务</dt><dd>${escapeHtml(item.studioBaseUrl || '待配置')}</dd></div>
      <div><dt>Login 回调</dt><dd>${escapeHtml(item.callbackBaseUrl || '待配置')}</dd></div>
      <div><dt>部署 Region</dt><dd>${escapeHtml(item.region || item.tosRegion || '读取失败')}</dd></div>
      <div><dt>服务凭证</dt><dd>${item.tokenConfigured ? '已安全配置' : '未配置'}</dd></div>
    </dl>
    <div class="connection-card-actions">
      <button class="small-button" data-connection-action="edit" data-connection-id="${escapeHtml(item.connectionId)}" type="button">编辑</button>
      ${item.status === 'FAILED' ? `<button class="small-button" data-connection-action="retry" data-connection-id="${escapeHtml(item.connectionId)}" type="button">重试注册</button>` : ''}
      <button class="small-button danger" data-connection-action="delete" data-connection-id="${escapeHtml(item.connectionId)}" type="button">${item.status === 'DELETE_FAILED' ? '重试删除' : '删除'}</button>
    </div>
  </article>`).join('');
  $('#connection-list').innerHTML = `${cards}<button class="connection-add-card" data-connection-action="create" type="button">
    <span class="connection-add-icon">+</span><strong>新建 Studio 连接</strong><span>点击配置一个新的服务实例</span>
  </button>`;
}

function openStudioDialog(connection = null) {
  const form = $('#studio-form');
  form.reset();
  setFormMessage(form, '');
  $('#studio-connection-id').value = connection?.connectionId || '';
  setText('#studio-dialog-title', connection ? `编辑 · ${connection.name}` : '新增 Studio 服务连接');
  if (connection) {
    form.elements.name.value = connection.name;
    form.elements.studioBaseUrl.value = connection.studioBaseUrl;
    form.elements.callbackBaseUrl.value = connection.callbackBaseUrl;
  } else {
    form.elements.name.value = 'Studio 连接';
    form.elements.studioBaseUrl.value = defaultStudioBaseUrl;
  }
  $('#studio-dialog').showModal();
}

async function submitStudioConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, '正在保存地址并向 Studio 注册…');
    const connectionId = $('#studio-connection-id').value;
    await api(connectionId
      ? `/api/admin/studio/connections/${encodeURIComponent(connectionId)}`
      : '/api/admin/studio/connections', {
      method: connectionId ? 'PUT' : 'POST',
      body: JSON.stringify({
        accountId: state.actor.accountId,
        name: form.elements.name.value.trim(),
        studioBaseUrl: form.elements.studioBaseUrl.value.trim(),
        callbackBaseUrl: form.elements.callbackBaseUrl.value.trim(),
      }),
    });
    $('#studio-dialog').close();
    await loadConnections();
    toast('Studio 服务连接已配置并注册。');
  } catch (error) {
    await loadConnections().catch(() => undefined);
    setFormMessage(form, error.message, true);
  }
}

async function retryConnection(connectionId) {
  try {
    await api(`/api/admin/studio/connections/${encodeURIComponent(connectionId)}/retry-register`, {
      method: 'POST',
      body: JSON.stringify({ accountId: state.actor.accountId }),
    });
    await loadConnections();
    toast('Studio 连接注册已重试。');
  } catch (error) {
    await loadConnections().catch(() => undefined);
    toast(error.message, true);
  }
}

async function deleteConnection(connectionId) {
  if (!window.confirm('确认删除该 Studio 连接？请先删除所有关联配置组。')) return;
  try {
    await api(`/api/admin/studio/connections/${encodeURIComponent(connectionId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadConnections();
    toast('Studio 连接已删除。');
  } catch (error) {
    await loadConnections().catch(() => undefined);
    toast(error.message, true);
  }
}

async function loadConfigGroups() {
  const result = await api(`/api/admin/config-groups?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.groups = result.items || [];
  renderConfigGroups();
  setText('#stat-groups', state.groups.length);
  setText('#stat-groups-note', `${state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status)).length} 个可分配`);
  refreshGroupSelect();
}

function renderConfigGroups() {
  const list = $('#config-list');
  if (state.groups.length === 0) {
    list.innerHTML = '<div class="empty table-card">尚未创建资源配置组。请先创建一个配置组，再创建企业子账号。</div>';
    return;
  }
  list.innerHTML = state.groups.map(group => {
    const config = group.config || {};
    const secretCount = ['lasApiKey', 'arkApiKey', 'tosAccessKey', 'tosSecretKey']
      .filter(key => Boolean(config[key])).length;
    return `<article class="config-card">
      <div class="config-card-header">
        <div class="config-card-title"><h3>${escapeHtml(group.projectId)}</h3>${group.isDefault ? '<span class="badge neutral">默认</span>' : ''}${badge(group.status)}</div>
        <div class="config-card-actions">
          <button class="small-button" data-config-action="edit" data-group-id="${escapeHtml(group.configGroupId)}" type="button">编辑</button>
          ${group.status === 'PARTIAL_FAILED' ? `<button class="small-button" data-config-action="retry" data-group-id="${escapeHtml(group.configGroupId)}" type="button">重试同步</button>` : ''}
          <button class="small-button danger" data-config-action="delete" data-group-id="${escapeHtml(group.configGroupId)}" type="button">删除</button>
        </div>
      </div>
      <div class="config-meta">
        <div><span>配置状态</span><strong>${group.currentVersion > 0 ? '已生效' : '待生效'}</strong></div>
        <div><span>Studio 连接</span><strong>${escapeHtml(group.connectionName || group.appId || '未配置')}</strong></div>
        <div><span>区域</span><strong>${escapeHtml(config.region || config.tosRegion || '未配置')}</strong></div>
        <div><span>资源凭证</span><strong>${secretCount > 0 ? `已配置 ${secretCount} 项` : '未配置'}</strong></div>
        <div><span>账期硬上限</span><strong>${group.monthlyLimit ? `${escapeHtml(formatMoney(group.monthlyLimit))} CNY` : '不限额'}</strong></div>
      </div>
      ${group.failedUsers?.length ? `<div class="sync-errors">${group.failedUsers.map(user => `<div><strong>${escapeHtml(user.loginName)}</strong><span>${escapeHtml(user.errorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(user.errorMessage || '同步失败')}${user.requestId ? ` · Request ID: ${escapeHtml(user.requestId)}` : ''}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}

function refreshGroupSelect() {
  const select = $('#user-config-group');
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  select.innerHTML = available.length
    ? available.map(group => `<option value="${escapeHtml(group.configGroupId)}" ${group.isDefault ? 'selected' : ''}>${escapeHtml(group.projectId)}${group.isDefault ? '（默认）' : ''}</option>`).join('')
    : '<option value="">请先创建一个可用配置组</option>';
}

function openConfigDialog(group = null) {
  const form = $('#config-form');
  form.reset();
  setConfigMode('manual');
  setFormMessage(form, '');
  $('#config-group-id').value = group?.configGroupId || '';
  setText('#config-dialog-title', group ? `编辑 · ${group.projectId}` : '新建配置组');
  $('#config-default-field').classList.toggle('hidden', Boolean(group));
  // 编辑时锁定 Studio 连接与配置组名称：二者绑定真实 Studio 用户记录与映射，不允许改动
  form.elements.connectionId.disabled = Boolean(group);
  form.elements.projectId.readOnly = Boolean(group);
  if (group) {
    form.elements.monthlyLimit.value = group.monthlyLimit || '';
    form.elements.connectionId.value = group.connectionId || '';
    form.elements.projectId.value = group.projectId || '';
    const config = group.config || {};
    manualResourceFieldNames.forEach(name => {
      if (form.elements[name] && config[name]) form.elements[name].value = config[name];
    });
    form.elements.resourceJson.value = JSON.stringify(
      Object.fromEntries(manualResourceFieldNames.filter(name => config[name]).map(name => [name, config[name]])),
      null,
      2,
    );
  }
  if (!group) {
    form.elements.connectionId.value = state.connection?.connectionId || '';
    form.elements.projectId.value = state.actor.accountId;
  }
  $('#config-dialog').showModal();
}

function setConfigMode(mode) {
  const form = $('#config-form');
  form.dataset.mode = mode;
  $$('.config-mode-tab').forEach(button => button.classList.toggle('active', button.dataset.configMode === mode));
  $('#config-manual-panel').classList.toggle('hidden', mode !== 'manual');
  $('#config-json-panel').classList.toggle('hidden', mode !== 'json');
}

function resourceConfigFromForm(form) {
  if (form.dataset.mode === 'json') {
    const resourceJson = form.elements.resourceJson.value.trim();
    if (!resourceJson) throw new Error('请填写资源 JSON');
    const parsed = JSON.parse(resourceJson);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('资源 JSON 必须是对象');
    const config = {};
    for (const name of manualResourceFieldNames) {
      const value = typeof parsed[name] === 'string' ? parsed[name].trim() : parsed[name];
      if (value) config[name] = value;
    }
    return config;
  }
  const config = {};
  for (const name of manualResourceFieldNames) {
    const value = form.elements[name].value.trim();
    if (value) config[name] = value;
  }
  return config;
}

async function retryConfigGroup(configGroupId) {
  try {
    await api(`/api/admin/config-groups/${encodeURIComponent(configGroupId)}/retry`, {
      method: 'POST',
      body: JSON.stringify({ accountId: state.actor.accountId }),
    });
    await Promise.all([loadConfigGroups(), loadUsers()]);
    toast('配置组已重新同步。');
  } catch (error) {
    await Promise.all([loadConfigGroups(), loadUsers()]).catch(() => undefined);
    toast(error.message, true);
  }
}

async function deleteConfigGroup(configGroupId) {
  if (!window.confirm('确认删除该配置组？有关联子账号时将拒绝删除。')) return;
  try {
    await api(`/api/admin/config-groups/${encodeURIComponent(configGroupId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadConfigGroups();
    toast('配置组已删除。');
  } catch (error) {
    toast(error.message, true);
  }
}

async function submitConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, '正在安全保存配置…');
    const resourceConfig = resourceConfigFromForm(form);
    const monthlyLimit = form.elements.monthlyLimit.value.trim() || null;
    const projectId = form.elements.projectId.value.trim();
    const groupId = $('#config-group-id').value;
    if (!groupId && ['lasApiKey', 'arkApiKey', 'tosBucketName'].some(name => !resourceConfig[name])) {
      throw new Error('请填写 LAS API Key、Ark API Key 和 Bucket');
    }
    if (groupId) {
      await api(`/api/admin/config-groups/${encodeURIComponent(groupId)}`, {
        method: 'PUT',
        body: JSON.stringify({
          accountId: state.actor.accountId,
          connectionId: form.elements.connectionId.value,
          projectId,
          resourceConfig,
          monthlyLimit,
        }),
      });
    } else {
      await api('/api/admin/config-groups', {
        method: 'POST',
        body: JSON.stringify({
          accountId: state.actor.accountId,
          connectionId: form.elements.connectionId.value,
          projectId,
          resourceConfig,
          monthlyLimit,
          isDefault: form.elements.isDefault.checked,
        }),
      });
    }
    form.reset();
    $('#config-dialog').close();
    await loadConfigGroups();
    toast(groupId ? '配置组已更新并生效。' : '配置组已创建并生效。');
  } catch (error) {
    setFormMessage(form, error.message, true);
  }
}

async function loadUsers() {
  const result = await api(`/api/admin/subaccounts?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.users = result.items || [];
  renderUsers();
  setText('#stat-users', state.users.length);
  setText('#stat-users-note', `${state.users.filter(user => user.status === 'ACTIVE').length} 个正常`);
}

function renderUsers() {
  $('#user-empty').classList.toggle('hidden', state.users.length > 0);
  $('#user-list').innerHTML = state.users.map(user => `<tr>
    <td><div class="cell-title"><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.userId)}</span></div></td>
    <td>${escapeHtml(user.loginName)}</td>
    <td>${user.password ? `<div class="inline-actions"><span class="secret-value" data-password-value>••••••••</span><button class="small-button" data-user-action="toggle-password" data-user-id="${escapeHtml(user.userId)}" type="button">查看</button></div>` : '历史账号需修改密码'}</td>
    <td>${escapeHtml(user.configGroupName || '未分配')}</td>
    <td>${user.monthlyLimit ? `${escapeHtml(formatMoney(user.monthlyLimit))} CNY` : '不限额'}</td>
    <td><div class="cell-title">${badge(user.status)}${user.profileSyncErrorMessage ? `<span>${escapeHtml(user.profileSyncErrorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(user.profileSyncErrorMessage)}${user.profileSyncRequestId ? ` · Request ID: ${escapeHtml(user.profileSyncRequestId)}` : ''}</span>` : ''}</div></td>
    <td><div class="inline-actions"><button class="small-button" data-user-action="edit" data-user-id="${escapeHtml(user.userId)}" type="button">编辑</button>${user.profileSyncErrorMessage ? `<button class="small-button" data-user-action="retry" data-user-id="${escapeHtml(user.userId)}" type="button">重试同步</button>` : ''}${user.status === 'ACTIVE' ? `<button class="small-button danger" data-user-action="disable" data-user-id="${escapeHtml(user.userId)}" type="button">停用</button>` : user.status === 'DISABLED' ? `<button class="small-button" data-user-action="enable" data-user-id="${escapeHtml(user.userId)}" type="button">恢复</button>` : ''}<button class="small-button danger" data-user-action="delete" data-user-id="${escapeHtml(user.userId)}" type="button">删除</button></div></td>
  </tr>`).join('');
}

function openUserDialog(user = null) {
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  if (available.length === 0) {
    toast('请先创建一个可用配置组。', true);
    switchSection('configs');
    return;
  }
  const form = $('#user-form');
  form.reset();
  form.elements.password.type = 'password';
  $('#toggle-user-password').textContent = '查看';
  $('#toggle-user-password').setAttribute('aria-label', '显示密码');
  setFormMessage(form, '');
  refreshGroupSelect();
  $('#user-id').value = user?.userId || '';
  setText('#user-dialog-title', user ? `编辑 · ${user.displayName || user.loginName || ''}`.trim() : '新建子账号');
  form.elements.loginName.readOnly = Boolean(user);
  form.elements.password.required = !user;
  form.dataset.originalPassword = user?.password || '';
  setText('#user-password-help', user?.password ? '当前密码，可直接修改' : user ? '历史账号需设置新密码后才能回显' : '创建时必填');
  if (user) {
    form.elements.displayName.value = user.displayName || '';
    form.elements.loginName.value = user.loginName || '';
    form.elements.password.value = user.password || '';
    form.elements.configGroupId.value = user.configGroupId || '';
    form.elements.monthlyLimit.value = user.monthlyLimit || '';
  }
  $('#user-dialog').showModal();
}

async function submitUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, '正在创建账号并同步资源配置…');
    const userId = $('#user-id').value;
    const payload = {
        accountId: state.actor.accountId,
        displayName: form.elements.displayName.value.trim(),
        configGroupId: form.elements.configGroupId.value,
        monthlyLimit: form.elements.monthlyLimit.value.trim() || null,
    };
    if (form.elements.password.value && form.elements.password.value !== form.dataset.originalPassword) {
      payload.password = form.elements.password.value;
    }
    if (!userId) payload.loginName = form.elements.loginName.value.trim();
    await api(userId ? `/api/admin/subaccounts/${encodeURIComponent(userId)}` : '/api/admin/subaccounts', {
      method: userId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    form.reset();
    $('#user-dialog').close();
    await loadUsers();
    toast(userId ? '企业子账号已更新。' : '企业子账号已创建并可登录 Studio。');
  } catch (error) {
    setFormMessage(form, error.message, true);
  }
}

async function setUserStatus(userId, status) {
  try {
    await api(`/api/admin/subaccounts/${encodeURIComponent(userId)}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ accountId: state.actor.accountId, status }),
    });
    await loadUsers();
    toast(status === 'ACTIVE' ? '账号已恢复。' : '账号已停用，现有登录会话已失效。');
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteSubaccount(userId) {
  if (!window.confirm('确认删除该子账号？历史任务和账单会保留。')) return;
  try {
    await api(`/api/admin/subaccounts/${encodeURIComponent(userId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadUsers();
    toast('子账号已删除。');
  } catch (error) {
    toast(error.message, true);
  }
}

async function retrySubaccount(userId) {
  try {
    await api(`/api/admin/subaccounts/${encodeURIComponent(userId)}/retry-profile-sync`, {
      method: 'POST',
      body: JSON.stringify({ accountId: state.actor.accountId }),
    });
    await Promise.all([loadUsers(), loadConfigGroups()]);
    toast('资源配置已重新同步。');
  } catch (error) {
    await Promise.all([loadUsers(), loadConfigGroups()]).catch(() => undefined);
    toast(error.message, true);
  }
}

async function loadPrices() {
  const result = await api(`/api/admin/prices?appId=${encodeURIComponent(state.actor.accountId)}`);
  const items = result.items || [];
  state.prices = items;
  $('#price-empty').classList.toggle('hidden', items.length > 0);
  $('#price-list').innerHTML = items.map(item => `<tr>
    <td><strong>${escapeHtml(item.billingItemId)}</strong></td>
    <td>${escapeHtml(item.unit)}</td>
    <td>${item.appId === '*' ? '平台默认' : escapeHtml(item.appId)}</td>
    <td>${escapeHtml(formatMoney(item.customerUnitPrice))}</td>
    <td>${escapeHtml(formatMoney(item.costUnitPrice))}</td>
    <td>${badge(item.enabled ? 'ACTIVE' : 'DISABLED')}</td>
    <td><div class="inline-actions"><button class="small-button" data-price-action="edit" data-price-app-id="${escapeHtml(item.appId)}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">编辑</button>${item.enabled ? `<button class="small-button danger" data-price-action="delete" data-price-app-id="${escapeHtml(item.appId)}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">删除</button>` : ''}</div></td>
  </tr>`).join('');
}

async function deletePrice(button) {
  if (!window.confirm('确认停用该价格配置？历史任务继续使用已有价格快照。')) return;
  try {
    await api('/api/admin/prices', {
      method: 'DELETE',
      body: JSON.stringify({
        appId: button.dataset.priceAppId,
        billingItemId: button.dataset.priceItemId,
        unit: button.dataset.priceUnit,
      }),
    });
    await loadPrices();
    toast('价格配置已停用。');
  } catch (error) {
    toast(error.message, true);
  }
}

function openPriceDialog(item = null) {
  const form = $('#price-form');
  form.reset();
  setFormMessage(form, '');
  $('#price-edit-mode').value = item ? '1' : '';
  setText('#price-dialog-title', item ? `编辑 · ${item.billingItemId}` : '配置价格');
  // 计费项 ID、计费单位、作用范围是价格记录的主键，编辑时锁定，仅可改单价
  form.elements.billingItemId.readOnly = Boolean(item);
  form.elements.unit.readOnly = Boolean(item);
  form.elements.platformDefault.disabled = Boolean(item);
  if (item) {
    form.elements.billingItemId.value = item.billingItemId;
    form.elements.unit.value = item.unit;
    form.elements.customerUnitPrice.value = item.customerUnitPrice;
    form.elements.costUnitPrice.value = item.costUnitPrice;
    form.elements.platformDefault.checked = item.appId === '*';
  } else {
    form.elements.customerUnitPrice.value = '0';
    form.elements.costUnitPrice.value = '0';
  }
  $('#price-dialog').showModal();
}

async function submitPrice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, '正在保存价格…');
    await api('/api/admin/prices', {
      method: 'POST',
      body: JSON.stringify({
        appId: form.elements.platformDefault.checked ? '*' : state.actor.accountId,
        billingItemId: form.elements.billingItemId.value.trim(),
        unit: form.elements.unit.value.trim(),
        customerUnitPrice: form.elements.customerUnitPrice.value.trim(),
        costUnitPrice: form.elements.costUnitPrice.value.trim(),
      }),
    });
    form.reset();
    $('#price-dialog').close();
    await loadPrices();
    toast('价格配置已保存。');
  } catch (error) {
    setFormMessage(form, error.message, true);
  }
}

async function downloadCsvTemplate(kind) {
  const response = await fetch(`/api/admin/${kind}/import-template?accountId=${encodeURIComponent(state.actor.accountId)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `模板下载失败（${response.status}）`);
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = kind === 'subaccounts' ? 'studio-subaccounts.csv' : 'studio-prices.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importCsv(kind, file) {
  const label = kind === 'subaccounts' ? '子账号' : '价格';
  try {
    toast(`正在导入${label} CSV…`);
    const result = await api(`/api/admin/${kind}/import`, {
      method: 'POST',
      body: JSON.stringify({ accountId: state.actor.accountId, csv: await file.text() }),
    });
    setText('#import-dialog-title', `${label}导入结果`);
    setText('#import-summary', `共 ${result.total} 行，成功 ${result.succeeded} 行，失败 ${result.failed} 行。`);
    $('#import-results').innerHTML = result.items.map(item => `<div class="import-result ${item.success ? '' : 'error'}"><strong>第 ${escapeHtml(item.row)} 行</strong><span>${escapeHtml(item.message)}</span></div>`).join('');
    $('#import-dialog').showModal();
    if (kind === 'subaccounts') await loadUsers();
    else await loadPrices();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadBills(period = $('#bill-period').value || currentPeriod()) {
  const dimension = $('#bill-dimension').value;
  const result = await api(`/api/admin/bills/${encodeURIComponent(period)}?accountId=${encodeURIComponent(state.actor.accountId)}&dimension=${encodeURIComponent(dimension)}`);
  const items = result.items || [];
  const taskCount = items.reduce((sum, item) => sum + Number(item.task_count || 0), 0);
  const customerAmount = items.reduce((sum, item) => sum + Number(item.customer_amount || 0), 0);
  const costAmount = items.reduce((sum, item) => sum + Number(item.cost_amount || 0), 0);
  setText('#bill-task-count', taskCount);
  setText('#bill-customer-amount', formatMoney(customerAmount));
  setText('#bill-cost-amount', formatMoney(costAmount));
  setText('#stat-tasks', taskCount);
  setText('#stat-tasks-note', `${period} 账期`);
  setText('#stat-amount', formatMoney(customerAmount));
  $('#bill-empty').classList.toggle('hidden', items.length > 0);
  setText('#bill-subject-heading', dimension === 'configGroup' ? '配置组' : dimension === 'subaccount' ? '子账号' : '范围');
  $('#bill-list').innerHTML = items.map(item => `<tr>
    <td>${escapeHtml(item.subject_name || (dimension === 'overall' ? '整体' : item.subject_id || '—'))}</td>
    <td>${badge(item.status)}</td>
    <td>${escapeHtml(item.task_count)}</td>
    <td>${escapeHtml(formatMoney(item.customer_amount))}</td>
    ${state.actor.role === 'SYSTEM_ADMIN' ? `<td>${escapeHtml(formatMoney(item.cost_amount))}</td>` : ''}
  </tr>`).join('');
}

function switchSection(section) {
  if (section === 'prices' && state.actor.role !== 'SYSTEM_ADMIN') return;
  $$('.page-section').forEach(node => node.classList.add('hidden'));
  $(`#section-${section}`).classList.remove('hidden');
  $$('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.section === section));
  setText('#section-title', sectionTitles[section]);
  if (section === 'configs') loadConfigGroups().catch(error => toast(error.message, true));
  if (section === 'users') loadUsers().catch(error => toast(error.message, true));
  if (section === 'prices') loadPrices().catch(error => toast(error.message, true));
  if (section === 'bills') loadBills().catch(error => toast(error.message, true));
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $('#login-message');
  try {
    message.textContent = '正在登录…';
    message.classList.remove('error');
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    await routeActor(result.user);
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  window.location.reload();
});

$$('.nav-item').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
$('#new-config').addEventListener('click', () => openConfigDialog());
$('#new-user').addEventListener('click', () => openUserDialog());
$('#new-price').addEventListener('click', () => openPriceDialog());
$('#download-user-template').addEventListener('click', () => downloadCsvTemplate('subaccounts').catch(error => toast(error.message, true)));
$('#download-price-template').addEventListener('click', () => downloadCsvTemplate('prices').catch(error => toast(error.message, true)));
$('#import-users').addEventListener('click', () => $('#user-csv-file').click());
$('#import-prices').addEventListener('click', () => $('#price-csv-file').click());
$('#user-csv-file').addEventListener('change', event => {
  const [file] = event.target.files;
  if (file) importCsv('subaccounts', file);
  event.target.value = '';
});
$('#price-csv-file').addEventListener('change', event => {
  const [file] = event.target.files;
  if (file) importCsv('prices', file);
  event.target.value = '';
});
$('#config-form').addEventListener('submit', submitConfig);
$('#studio-form').addEventListener('submit', submitStudioConnection);
$('#user-form').addEventListener('submit', submitUser);
$('#price-form').addEventListener('submit', submitPrice);
$('#bill-period').addEventListener('change', event => loadBills(event.target.value).catch(error => toast(error.message, true)));
$('#bill-dimension').addEventListener('change', () => loadBills().catch(error => toast(error.message, true)));
$$('.config-mode-tab').forEach(button => button.addEventListener('click', () => setConfigMode(button.dataset.configMode)));

$('#config-list').addEventListener('click', event => {
  const button = event.target.closest('[data-config-action]');
  if (!button) return;
  const group = state.groups.find(item => item.configGroupId === button.dataset.groupId);
  if (!group) return;
  if (button.dataset.configAction === 'edit') openConfigDialog(group);
  if (button.dataset.configAction === 'retry') retryConfigGroup(group.configGroupId);
  if (button.dataset.configAction === 'delete') deleteConfigGroup(group.configGroupId);
});

$('#connection-list').addEventListener('click', event => {
  const button = event.target.closest('[data-connection-action]');
  if (!button) return;
  if (button.dataset.connectionAction === 'create') {
    openStudioDialog();
    return;
  }
  const connection = state.connections.find(item => item.connectionId === button.dataset.connectionId);
  if (!connection) return;
  if (button.dataset.connectionAction === 'edit') openStudioDialog(connection);
  if (button.dataset.connectionAction === 'retry') retryConnection(connection.connectionId);
  if (button.dataset.connectionAction === 'delete') deleteConnection(connection.connectionId);
});

$('#user-list').addEventListener('click', event => {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  if (button.dataset.userAction === 'toggle-password') {
    const user = state.users.find(item => item.userId === button.dataset.userId);
    if (!user?.password) return;
    const visible = button.dataset.visible === 'true';
    const value = button.closest('tr').querySelector('[data-password-value]');
    value.textContent = visible ? '••••••••' : user.password;
    button.dataset.visible = String(!visible);
    button.textContent = visible ? '查看' : '隐藏';
    return;
  }
  if (button.dataset.userAction === 'edit') {
    const user = state.users.find(item => item.userId === button.dataset.userId);
    if (user) openUserDialog(user);
    return;
  }
  if (button.dataset.userAction === 'retry') {
    retrySubaccount(button.dataset.userId);
    return;
  }
  if (button.dataset.userAction === 'delete') {
    deleteSubaccount(button.dataset.userId);
    return;
  }
  setUserStatus(button.dataset.userId, button.dataset.userAction === 'enable' ? 'ACTIVE' : 'DISABLED');
});

$('#price-list').addEventListener('click', event => {
  const button = event.target.closest('[data-price-action]');
  if (!button) return;
  if (button.dataset.priceAction === 'edit') {
    const item = state.prices.find(price =>
      price.appId === button.dataset.priceAppId
      && price.billingItemId === button.dataset.priceItemId
      && price.unit === button.dataset.priceUnit);
    if (item) openPriceDialog(item);
    return;
  }
  if (button.dataset.priceAction === 'delete') deletePrice(button);
});

$('#toggle-user-password').addEventListener('click', () => {
  const input = $('#user-form').elements.password;
  const visible = input.type === 'text';
  input.type = visible ? 'password' : 'text';
  $('#toggle-user-password').textContent = visible ? '查看' : '隐藏';
  $('#toggle-user-password').setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
});

$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('close', () => {
  const form = dialog.querySelector('form');
  form?.reset();
  if (form) setFormMessage(form, '');
}));

api('/api/auth/me')
  .then(result => result.user.role === 'SUBACCOUNT' ? undefined : routeActor(result.user))
  .catch(() => undefined);
