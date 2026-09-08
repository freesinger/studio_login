const state = {
  actor: null,
  connection: null,
  connections: [],
  groups: [],
  users: [],
  prices: [],
  billingCatalog: [],
  loginProjects: [],
  modelPage: 1,
};

const sectionTitles = {
  overview: '企业概览',
  configs: '资源配置组',
  users: '企业子账号',
  prices: '价格配置',
  models: '模型统计',
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

const customModelFieldNames = ['customModels'];

const customModelTypes = {
  IMAGE: 'Image',
  LANGUAGE: 'Language',
  ELEVENLABS: 'ElevenLabs',
};

const customImageRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
const customImageResolutions = ['1K', '1.5K', '2K', '3K', '4K'];
const defaultCustomImageRatios = ['16:9', '9:16', '1:1', '4:3'];
const defaultCustomImageResolutions = ['1K', '1.5K', '2K', '3K'];

const optionalResourceFieldNames = [
  'lasBaseUrl',
  'tosAccessKey',
  'tosSecretKey',
  'tosUploadPrefix',
  'tosEndpoint',
  'outputTosPath',
];

const resourceFieldNames = [
  ...manualResourceFieldNames,
  ...optionalResourceFieldNames,
  ...customModelFieldNames,
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

function formatBeijingDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function modelStatusCell(item) {
  const runningMinutes = Number(item.runningMinutes || 0);
  if (item.status !== 'RUNNING') return badge(item.status);
  const reconcileStatus = item.lastReconcileStatus ? String(item.lastReconcileStatus) : '';
  const stale = runningMinutes >= 30;
  const diagnostics = [];
  if (stale) diagnostics.push(`已执行 ${runningMinutes} 分钟，超过 30 分钟未收到 Studio 终态回调`);
  if (reconcileStatus) diagnostics.push(`最近补偿查询：${reconcileStatus}`);
  if (item.reconcileAttempts) diagnostics.push(`补偿次数：${item.reconcileAttempts}`);
  if (item.lastReconcileAt) diagnostics.push(`查询时间：${formatBeijingDateTime(item.lastReconcileAt)}`);
  if (item.nextReconcileAt) diagnostics.push(`下次查询：${formatBeijingDateTime(item.nextReconcileAt)}`);
  if (diagnostics.length === 0) return badge(item.status);
  return `<div class="cell-title"><span class="badge warning">${stale ? '执行中超时' : '执行中'}</span><span>${escapeHtml(diagnostics.join('；'))}</span></div>`;
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
    ? parsed.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
}

function formatPrice(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0';
  return parsed.toFixed(10).replace(/\.?0+$/, '');
}


function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readStringValue(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function normalizeCustomModelType(value, fallback = 'LANGUAGE') {
  const type = String(value || '').trim().toUpperCase();
  if (type === 'IMAGE') return 'IMAGE';
  if (type === 'LANGUAGE' || type === 'LLM' || type === 'TEXT') return 'LANGUAGE';
  if (type === 'ELEVENLABS' || type === 'ELEVEN_LABS') return 'ELEVENLABS';
  const fallbackType = String(fallback || '').trim().toUpperCase();
  if (fallbackType === 'IMAGE') return 'IMAGE';
  if (fallbackType === 'ELEVENLABS' || fallbackType === 'ELEVEN_LABS') return 'ELEVENLABS';
  return 'LANGUAGE';
}

function uniqueKnownValues(values, allowedValues) {
  if (!Array.isArray(values)) return [];
  const allowed = new Set(allowedValues);
  return [...new Set(values
    .map(value => typeof value === 'string' ? value.trim() : '')
    .filter(value => allowed.has(value)))];
}

function defaultCustomModel(type = 'LANGUAGE', index = 0) {
  const normalizedType = normalizeCustomModelType(type);
  return {
    name: `自定义模型 ${index + 1}`,
    type: normalizedType,
    model: '',
    endpoint: '',
    apiKey: '',
    ...(normalizedType === 'IMAGE'
      ? {
        imageRatios: [...defaultCustomImageRatios],
        imageResolutions: [...defaultCustomImageResolutions],
      }
      : {
        imageRatios: undefined,
        imageResolutions: undefined,
      }),
  };
}

function normalizeCustomModelConfig(input, fallbackType = 'LANGUAGE', index = 0) {
  if (!isPlainObject(input)) return null;
  const type = normalizeCustomModelType(input.type ?? input.modelType, fallbackType);
  const model = readStringValue(input.model, input.modelId, input.id, input.modelName, input.name);
  const name = readStringValue(input.name, input.modelName, input.displayName, model, `自定义模型 ${index + 1}`);
  const config = {
    name,
    type,
    model,
    endpoint: readStringValue(input.endpoint, input.baseUrl, input.baseURL),
    apiKey: readStringValue(input.apiKey),
  };
  if (type === 'IMAGE') {
    config.imageRatios = uniqueKnownValues(input.imageRatios ?? input.imageRatiosSelected, customImageRatios);
    config.imageResolutions = uniqueKnownValues(
      input.imageResolutions ?? (input.imageResolution ? [input.imageResolution] : undefined),
      customImageResolutions,
    );
  }
  if (input.verified === 'pass' || input.verified === 'unpass') config.verified = input.verified;
  return config;
}

function normalizeCustomModelsFromConfig(config) {
  if (!isPlainObject(config)) return [];
  let models = [];
  if (Array.isArray(config.customModels)) {
    models = config.customModels
      .map((item, index) => normalizeCustomModelConfig(item, item?.type, index))
      .filter(Boolean);
  }
  if (isPlainObject(config.models)) {
    if (Array.isArray(config.models.custom)) {
      models = config.models.custom
        .map((item, index) => normalizeCustomModelConfig(item, item?.type, index))
        .filter(Boolean);
    }
  }
  return models.map((model, index) => ({
    ...defaultCustomModel(model.type, index),
    ...model,
    ...(model.type === 'IMAGE'
      ? {
        imageRatios: model.imageRatios?.length ? model.imageRatios : [...defaultCustomImageRatios],
        imageResolutions: model.imageResolutions?.length ? model.imageResolutions : [...defaultCustomImageResolutions],
      }
      : {
        imageRatios: undefined,
        imageResolutions: undefined,
      }),
  }));
}

function resourceCustomModelFields(models) {
  const customModels = models.map(model => {
    const type = normalizeCustomModelType(model.type);
    const item = {
      ...(model.id ? { id: model.id } : {}),
      name: model.name.trim(),
      type,
      model: model.model.trim(),
      endpoint: model.endpoint.trim(),
      apiKey: model.apiKey.trim(),
      ...(model.verified ? { verified: model.verified } : {}),
    };
    if (type === 'IMAGE') {
      item.imageRatios = uniqueKnownValues(model.imageRatios, customImageRatios);
      item.imageResolutions = uniqueKnownValues(model.imageResolutions, customImageResolutions);
    }
    return item;
  });
  return { customModels };
}

function studioSettingsJsonFromResourceConfig(config) {
  const models = normalizeCustomModelsFromConfig(config);
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    las: {
      apiKey: config.lasApiKey || '',
    },
    models: {
      arkImage: {
        apiKey: config.arkApiKey || '',
      },
      custom: models.map(model => ({
        ...(model.apiKey ? { apiKey: model.apiKey } : { apiKey: '' }),
        ...(model.endpoint ? { endpoint: model.endpoint } : { endpoint: '' }),
        ...(model.id ? { id: model.id } : {}),
        model: model.model || '',
        name: model.name || '',
        type: normalizeCustomModelType(model.type),
        ...(model.type === 'IMAGE'
          ? {
            imageResolutions: uniqueKnownValues(model.imageResolutions, customImageResolutions),
            imageRatios: uniqueKnownValues(model.imageRatios, customImageRatios),
          }
          : {}),
      })),
    },
    region: config.region || config.tosRegion || '',
    tos: {
      accessKey: config.tosAccessKey || '',
      bucketName: config.tosBucketName || '',
      endpoint: config.tosEndpoint || '',
      secretKey: config.tosSecretKey || '',
      sessionToken: '',
    },
  };
}

function normalizeImportedResourceConfig(input) {
  if (!isPlainObject(input)) throw new Error('资源 JSON 必须是对象');
  const config = {};
  for (const name of resourceFieldNames) {
    const value = typeof input[name] === 'string' ? input[name].trim() : input[name];
    if (value !== undefined && value !== null && value !== '') config[name] = value;
  }
  if (isPlainObject(input.las)) {
    const apiKey = readStringValue(input.las.apiKey);
    if (apiKey) config.lasApiKey = apiKey;
  }
  if (isPlainObject(input.tos)) {
    const bucketName = readStringValue(input.tos.bucketName, input.tos.tosBucketName);
    const endpoint = readStringValue(input.tos.endpoint, input.tos.tosEndpoint);
    const accessKey = readStringValue(input.tos.accessKey, input.tos.tosAccessKey);
    const secretKey = readStringValue(input.tos.secretKey, input.tos.tosSecretKey);
    if (bucketName) config.tosBucketName = bucketName;
    if (endpoint) config.tosEndpoint = endpoint;
    if (accessKey) config.tosAccessKey = accessKey;
    if (secretKey) config.tosSecretKey = secretKey;
  }
  if (isPlainObject(input.models)) {
    const arkApiKey = readStringValue(input.models.arkImage?.apiKey, input.models.arkApiKey);
    if (arkApiKey) config.arkApiKey = arkApiKey;
  }
  const customModels = normalizeCustomModelsFromConfig(input);
  Object.assign(config, resourceCustomModelFields(customModels));
  return config;
}

function customModelStatusLabel(verified) {
  if (verified === 'testing') return '测试中';
  if (verified === 'pass') return '已验证';
  if (verified === 'unpass') return '测试失败';
  return '未测试';
}

function customModelValuesFromCard(card) {
  const type = normalizeCustomModelType(card.querySelector('[data-custom-model-field="type"]').value);
  const model = {
    id: card.querySelector('[data-custom-model-field="id"]')?.value || '',
    name: card.querySelector('[data-custom-model-field="name"]').value,
    type,
    model: card.querySelector('[data-custom-model-field="model"]').value,
    endpoint: card.querySelector('[data-custom-model-field="endpoint"]').value,
    apiKey: card.querySelector('[data-custom-model-field="apiKey"]').value,
  };
  if (type === 'IMAGE') {
    model.imageRatios = [...card.querySelectorAll('[data-custom-model-field="imageRatios"]:checked')]
      .map(input => input.value);
    model.imageResolutions = [...card.querySelectorAll('[data-custom-model-field="imageResolutions"]:checked')]
      .map(input => input.value);
  }
  const verified = card.dataset.verified;
  if (verified === 'pass' || verified === 'unpass') model.verified = verified;
  return model;
}

function getCustomModelConfigsFromDom() {
  return [...$('#custom-model-list').querySelectorAll('.custom-model-card')]
    .map(customModelValuesFromCard);
}

function renderCustomModelCards(models = []) {
  const list = $('#custom-model-list');
  const empty = $('#custom-model-empty');
  if (!list || !empty) return;
  empty.classList.toggle('hidden', models.length > 0);
  list.innerHTML = models.map((model, index) => {
    const type = normalizeCustomModelType(model.type);
    const normalized = {
      ...defaultCustomModel(type, index),
      ...model,
      ...(type === 'IMAGE'
        ? {
          imageRatios: model.imageRatios?.length ? model.imageRatios : [...defaultCustomImageRatios],
          imageResolutions: model.imageResolutions?.length ? model.imageResolutions : [...defaultCustomImageResolutions],
        }
        : {}),
    };
    const title = normalized.name || `自定义模型 ${index + 1}`;
    const status = normalized.verified || 'untested';
    const ratios = uniqueKnownValues(normalized.imageRatios, customImageRatios);
    const resolutions = uniqueKnownValues(normalized.imageResolutions, customImageResolutions);
    return `<article class="custom-model-card" data-custom-model-index="${index}" data-verified="${escapeHtml(status)}">
      <input data-custom-model-field="id" type="hidden" value="${escapeHtml(normalized.id || '')}">
      <div class="custom-model-card-header">
        <div class="custom-model-title"><strong>${escapeHtml(title)}</strong><span class="custom-model-status" data-status="${escapeHtml(status)}"><span></span>${escapeHtml(customModelStatusLabel(status))}</span></div>
        <div class="inline-actions"><button class="small-button" data-custom-model-action="test" type="button">测试连通性</button><button class="small-button danger" data-custom-model-action="delete" type="button">删除</button></div>
      </div>
      <div class="form-grid two-columns">
        <label><span><span class="required-mark">*</span> 模型名称（modelName）</span><input data-custom-model-field="name" maxlength="128" value="${escapeHtml(normalized.name)}" placeholder="例如：gpt-image-2"></label>
        <label><span><span class="required-mark">*</span> 模型类型</span><select data-custom-model-field="type">${Object.entries(customModelTypes).map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label><span><span class="required-mark">*</span> 模型 ID（model）</span><input data-custom-model-field="model" maxlength="128" value="${escapeHtml(normalized.model)}" placeholder="例如：gpt-image-2"></label>
        <label class="custom-endpoint-field ${type === 'ELEVENLABS' ? 'hidden' : ''}"><span><span class="required-mark">*</span> 自定义渠道 Base URL</span><input data-custom-model-field="endpoint" maxlength="512" value="${escapeHtml(normalized.endpoint)}" placeholder="未知"></label>
        <label class="span-two"><span><span class="required-mark">*</span> 自定义渠道 API Key</span><span class="secret-input"><input data-custom-model-field="apiKey" type="password" autocomplete="off" value="${escapeHtml(normalized.apiKey)}"><button class="secret-toggle" data-custom-model-action="toggle-secret" type="button">查看</button></span></label>
      </div>
      <div class="custom-image-options ${type === 'IMAGE' ? '' : 'hidden'}">
        <div class="custom-option-group"><span class="custom-option-label"><span class="required-mark">*</span> 图片比例</span><div class="choice-chips">${customImageRatios.map(ratio => `<label class="choice-chip"><input data-custom-model-field="imageRatios" type="checkbox" value="${ratio}" ${ratios.includes(ratio) ? 'checked' : ''}><span>${ratio}</span></label>`).join('')}</div><p class="muted">主要用于限制应用单次任务自定义模型的图片比例选择范围。</p></div>
        <div class="custom-option-group"><span class="custom-option-label"><span class="required-mark">*</span> 图片清晰度</span><div class="choice-chips">${customImageResolutions.map(resolution => `<label class="choice-chip"><input data-custom-model-field="imageResolutions" type="checkbox" value="${resolution}" ${resolutions.includes(resolution) ? 'checked' : ''}><span>${resolution}</span></label>`).join('')}</div><p class="muted">主要用于限制应用单次任务自定义模型的图片清晰度选择范围。</p></div>
      </div>
    </article>`;
  }).join('');
}

function setCustomModelCardVerified(card, status) {
  card.dataset.verified = status;
  const statusNode = card.querySelector('.custom-model-status');
  if (!statusNode) return;
  statusNode.dataset.status = status;
  statusNode.innerHTML = `<span></span>${escapeHtml(customModelStatusLabel(status))}`;
}

function updateCustomModelTitle(card) {
  const title = card.querySelector('.custom-model-title strong');
  const name = card.querySelector('[data-custom-model-field="name"]').value.trim();
  title.textContent = name || `自定义模型 ${Number(card.dataset.customModelIndex || 0) + 1}`;
}

function validateCustomModels(models) {
  const nameCounts = new Map();
  models.forEach(model => {
    const key = model.name.trim().toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  models.forEach((model, index) => {
    const position = `第 ${index + 1} 个自定义模型`;
    if (!model.name.trim()) throw new Error(`${position}缺少模型名称（modelName）`);
    if ((nameCounts.get(model.name.trim().toLowerCase()) || 0) > 1) throw new Error(`${position}模型名称重复`);
    if (!model.model.trim()) throw new Error(`${position}缺少模型 ID（model）`);
    if (model.type !== 'ELEVENLABS' && !model.endpoint.trim()) throw new Error(`${position}缺少自定义渠道 Base URL`);
    if (!model.apiKey.trim()) throw new Error(`${position}缺少 API Key`);
    if (model.type === 'IMAGE' && (!model.imageRatios || model.imageRatios.length === 0)) throw new Error(`${position}请至少选择一个图片比例`);
    if (model.type === 'IMAGE' && (!model.imageResolutions || model.imageResolutions.length === 0)) throw new Error(`${position}请至少选择一个图片清晰度`);
  });
}

function collectCustomModelFieldsFromForm() {
  const models = getCustomModelConfigsFromDom().map((model, index) => ({
    ...defaultCustomModel(model.type, index),
    ...model,
    name: model.name.trim(),
    model: model.model.trim(),
    endpoint: model.endpoint.trim(),
    apiKey: model.apiKey.trim(),
  })).filter(model => model.name || model.model || model.endpoint || model.apiKey);
  validateCustomModels(models);
  return resourceCustomModelFields(models);
}

function draftResourceConfigFromManualForm(form) {
  let config = {};
  const resourceJson = form.elements.resourceJson.value.trim();
  if (resourceJson) {
    try {
      config = normalizeImportedResourceConfig(JSON.parse(resourceJson));
    } catch {
      config = {};
    }
  }
  for (const name of manualResourceFieldNames) {
    const value = form.elements[name].value.trim();
    if (value) config[name] = value;
  }
  const models = getCustomModelConfigsFromDom()
    .map((model, index) => ({
      ...defaultCustomModel(model.type, index),
      ...model,
      name: model.name.trim(),
      model: model.model.trim(),
      endpoint: model.endpoint.trim(),
      apiKey: model.apiKey.trim(),
    }))
    .filter(model => model.name || model.model || model.endpoint || model.apiKey);
  Object.assign(config, resourceCustomModelFields(models));
  return config;
}

async function testCustomModelConnection(card) {
  const button = card.querySelector('[data-custom-model-action="test"]');
  try {
    button.disabled = true;
    button.textContent = '测试中…';
    setCustomModelCardVerified(card, 'testing');
    const model = customModelValuesFromCard(card);
    const payload = {
      ...defaultCustomModel(model.type, Number(card.dataset.customModelIndex || 0)),
      ...model,
      name: model.name.trim(),
      model: model.model.trim(),
      endpoint: model.endpoint.trim(),
      apiKey: model.apiKey.trim(),
    };
    validateCustomModels([payload]);
    await api('/api/admin/custom-models/test', {
      method: 'POST',
      body: JSON.stringify({
        accountId: state.actor.accountId,
        type: payload.type,
        model: payload.model,
        endpoint: payload.endpoint,
        apiKey: payload.apiKey,
        imageResolutions: payload.imageResolutions || [],
      }),
    });
    setCustomModelCardVerified(card, 'pass');
    toast('自定义模型连通性验证通过。');
  } catch (error) {
    setCustomModelCardVerified(card, 'unpass');
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '测试连通性';
  }
}


async function enterStudio(connectionId, configGroup) {
  setText('#project-message', '正在创建一次性登录凭证并打开 Studio…');
  const result = await api('/api/studio/tickets/launch', {
    method: 'POST',
    body: JSON.stringify(configGroup ? { connectionId, configGroup } : {}),
  });
  window.open(result.launchUrl, '_blank', 'noopener,noreferrer');
  setText('#project-message', 'Studio 已在新窗口打开。');
}

async function routeActor(actor) {
  state.actor = actor;
  if (actor.role === 'SUBACCOUNT') {
    await showProjectChooser(actor);
    return;
  }
  showAdmin(actor);
  await loadAdminData();
}

async function showProjectChooser(actor) {
  $('#login-view').classList.add('hidden');
  $('#admin-view').classList.add('hidden');
  $('#project-view').classList.remove('hidden');
  setText('#project-user', `${actor.displayName || actor.loginName}，请选择要进入的 Project。`);
  setText('#project-message', '正在读取可访问 Project…');
  try {
    const result = await api('/api/auth/my-projects');
    state.loginProjects = result.items || [];
    $('#project-list').innerHTML = state.loginProjects.length
      ? state.loginProjects.map(item => `<button class="connection-add-card project-entry" data-project-connection="${escapeHtml(item.connectionId)}" data-project-group="${escapeHtml(item.name)}" type="button">
          <strong>${escapeHtml(item.projectId || item.name)}</strong>
          <span>${escapeHtml(item.connectionName || item.connectionId)}${item.isDefault ? ' · 默认' : ''}</span>
        </button>`).join('')
      : '<div class="empty">暂无可访问 Project，请联系管理员授权。</div>';
    setText('#project-message', '');
  } catch (error) {
    setText('#project-message', error.message);
    $('#project-message').classList.add('error');
  }
}

function showAdmin(actor) {
  $('#login-view').classList.add('hidden');
  $('#admin-view').classList.remove('hidden');
  setText('#actor-name', actor.displayName || actor.loginName);
  setText('#actor-role', actor.role === 'SYSTEM_ADMIN' ? '系统管理员' : '企业管理员');
  setText('#actor-avatar', (actor.displayName || actor.loginName || 'A').slice(0, 1).toUpperCase());
  setText('#account-name', actor.accountId);
  $('#bill-period').value = currentPeriod();
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 6 * 86_400_000);
  $('#model-end-date').value = today.toLocaleDateString('en-CA');
  $('#model-start-date').value = weekAgo.toLocaleDateString('en-CA');
  if (actor.role !== 'SYSTEM_ADMIN') {
    $$('.system-admin-only').forEach(node => node.classList.add('hidden'));
  }
}

async function loadAdminData() {
  const results = await Promise.allSettled([
    loadConnections(),
    loadConfigGroups(),
    loadUsers(),
    loadBills(currentPeriod()),
  ]);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) toast(failed.reason.message, true);
  if (state.actor.role === 'SYSTEM_ADMIN' && results[1].status === 'fulfilled') {
    await loadPrices().catch(error => toast(error.message, true));
  }
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
  refreshPriceScopeFilter();
  renderModelConfigGroupOptions();
}

function renderModelConfigGroupOptions() {
  const select = $('#model-config-group');
  if (!select) return;
  const current = select.value;
  const groups = state.groups.filter(group => group.status !== 'DELETED');
  select.innerHTML = '<option value="">全部</option>' + groups
    .map(group => `<option value="${escapeHtml(group.configGroupId)}">${escapeHtml(group.projectId || group.name || group.configGroupId)}</option>`)
    .join('');
  select.value = groups.some(group => group.configGroupId === current) ? current : '';
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
    const quota = group.quota || {};
    const limit = quota.limit === null || quota.limit === undefined
      ? '不限额'
      : `${formatMoney(quota.limit)} CNY`;
    const available = quota.availableAmount === null || quota.availableAmount === undefined
      ? '不限额'
      : `${formatMoney(quota.availableAmount)} CNY`;
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
        <div><span>资源配置来源</span><strong>${group.resourceConfigSource === 'STUDIO' ? 'Studio 远端' : '本地缓存'}</strong></div>
        <div><span>区域</span><strong>${escapeHtml(config.region || config.tosRegion || '未配置')}</strong></div>
        <div><span>资源凭证</span><strong>${secretCount > 0 ? `已配置 ${secretCount} 项` : '未配置'}</strong></div>
        <div><span>${escapeHtml(group.billingPeriod || currentPeriod())} 月度共享上限</span><strong>${escapeHtml(limit)}</strong></div>
        <div><span>本月已结算</span><strong>${escapeHtml(formatMoney(quota.actualAmount || 0))} CNY</strong></div>
        <div><span>执行中预冻结</span><strong>${escapeHtml(formatMoney(quota.reservedAmount || 0))} CNY</strong></div>
        <div><span>当前可用额度</span><strong>${escapeHtml(available)}</strong></div>
        <div><span>数据共享</span><strong>${group.projectLevelSharing ? '已开启' : '未开启'}</strong></div>
      </div>
      ${group.resourceConfigSyncError ? `<div class="sync-notices"><div><strong>当前展示本地缓存</strong><span>${escapeHtml(group.resourceConfigSyncError)}</span></div></div>` : ''}
      ${group.failedUsers?.length ? `<div class="sync-errors">${group.failedUsers.map(user => `<div><strong>${escapeHtml(user.loginName)}</strong><span>${escapeHtml(user.errorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(user.errorMessage || '同步失败')}${user.requestId ? ` · Request ID: ${escapeHtml(user.requestId)}` : ''}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}

function refreshGroupSelect() {
  const select = $('#user-config-group');
  if (!select) return;
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  select.innerHTML = available.length
    ? available.map(group => `<option value="${escapeHtml(group.configGroupId)}" ${group.isDefault ? 'selected' : ''}>${escapeHtml(group.projectId)}${group.isDefault ? '（默认）' : ''}</option>`).join('')
    : '<option value="">请先创建一个可用配置组</option>';
  refreshPriceScopeSelect();
}

function refreshPriceScopeSelect(selectedScopeId = '') {
  const select = $('#price-scope');
  if (!select) return;
  const groups = state.groups.filter(group => group.status !== 'DELETED');
  select.innerHTML = `${groups.map(group =>
    `<option value="${escapeHtml(group.configGroupId)}">${escapeHtml(group.projectId)}</option>`).join('')}
    <option value="*">平台默认（兜底）</option>`;
  const defaultGroup = groups.find(group => group.isDefault) || groups[0];
  select.value = selectedScopeId || defaultGroup?.configGroupId || '*';
}

function refreshPriceScopeFilter() {
  const select = $('#price-scope-filter');
  if (!select) return;
  const current = select.value;
  const groups = state.groups.filter(group => group.status !== 'DELETED');
  select.innerHTML = `${groups.map(group =>
    `<option value="${escapeHtml(group.configGroupId)}">${escapeHtml(group.projectId)}</option>`).join('')}
    <option value="*">平台默认（兜底）</option>`;
  const defaultGroup = groups.find(group => group.isDefault) || groups[0];
  const keepCurrent = groups.some(group => group.configGroupId === current)
    || (current === '*' && select.dataset.userSelected === 'true');
  select.value = keepCurrent
    ? current
    : defaultGroup?.configGroupId || '*';
}

function renderUserBindingCards(bindings = []) {
  const list = $('#user-binding-list');
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  const initial = bindings.length ? bindings : [{
    configGroupId: available.find(group => group.isDefault)?.configGroupId || available[0]?.configGroupId || '',
    monthlyLimit: '',
    isDefault: true,
  }];
  list.innerHTML = initial.map((binding, index) => bindingCardHtml(binding, index)).join('');
}

function bindingCardHtml(binding, index) {
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  return `<div class="binding-card" data-binding-card>
    <label>配置组<select data-binding-group required>${available.map(group =>
      `<option value="${escapeHtml(group.configGroupId)}" ${group.configGroupId === binding.configGroupId ? 'selected' : ''}>${escapeHtml(group.projectId)}</option>`).join('')}</select></label>
    <label>子账号月度上限<input data-binding-limit inputmode="decimal" placeholder="不限额" value="${escapeHtml(binding.monthlyLimit || '')}"></label>
    <label class="checkbox-row binding-default"><input data-binding-default name="bindingDefault" type="radio" ${binding.isDefault || index === 0 ? 'checked' : ''}><span>默认</span></label>
    <button class="small-button danger" data-binding-remove type="button">删除</button>
  </div>`;
}

function collectUserBindings() {
  return $$('[data-binding-card]').map(card => ({
    configGroupId: card.querySelector('[data-binding-group]').value,
    monthlyLimit: card.querySelector('[data-binding-limit]').value.trim() || null,
    isDefault: card.querySelector('[data-binding-default]').checked,
  })).filter(binding => binding.configGroupId);
}

function openConfigDialog(group = null) {
  const form = $('#config-form');
  form.reset();
  setConfigMode('manual');
  renderCustomModelCards([]);
  setFormMessage(form, '');
  $('#config-group-id').value = group?.configGroupId || '';
  setText('#config-dialog-title', group ? `编辑 · ${group.projectId}` : '新建配置组');
  $('#config-default-field').classList.toggle('hidden', Boolean(group));
  // 编辑时锁定 Studio 连接与配置组名称：二者绑定真实 Studio 用户记录与映射，不允许改动
  form.elements.connectionId.disabled = Boolean(group);
  form.elements.projectId.readOnly = Boolean(group);
  if (group) {
    form.elements.monthlyLimit.value = group.monthlyLimit || '';
    form.elements.projectLevelSharing.checked = Boolean(group.projectLevelSharing);
    form.elements.connectionId.value = group.connectionId || '';
    form.elements.projectId.value = group.projectId || '';
    const config = group.config || {};
    manualResourceFieldNames.forEach(name => {
      if (form.elements[name] && config[name]) form.elements[name].value = config[name];
    });
    form.elements.resourceJson.value = JSON.stringify(
      studioSettingsJsonFromResourceConfig(config),
      null,
      2,
    );
    renderCustomModelCards(normalizeCustomModelsFromConfig(config));
  }
  if (!group) {
    form.elements.connectionId.value = state.connection?.connectionId || '';
    form.elements.projectId.value = state.actor.accountId;
  }
  $('#config-dialog').showModal();
}

function setConfigMode(mode) {
  const form = $('#config-form');
  if (mode === 'json' && form.dataset.mode !== 'json') {
    form.elements.resourceJson.value = JSON.stringify(
      studioSettingsJsonFromResourceConfig(draftResourceConfigFromManualForm(form)),
      null,
      2,
    );
  }
  if (mode === 'manual' && form.dataset.mode === 'json' && form.elements.resourceJson.value.trim()) {
    try {
      const config = normalizeImportedResourceConfig(JSON.parse(form.elements.resourceJson.value.trim()));
      manualResourceFieldNames.forEach(name => {
        if (form.elements[name]) form.elements[name].value = config[name] || '';
      });
      renderCustomModelCards(normalizeCustomModelsFromConfig(config));
      setFormMessage(form, '');
    } catch (error) {
      setFormMessage(form, error.message, true);
    }
  }
  form.dataset.mode = mode;
  $$('.config-mode-tab').forEach(button => button.classList.toggle('active', button.dataset.configMode === mode));
  $('#config-manual-panel').classList.toggle('hidden', mode !== 'manual');
  $('#config-json-panel').classList.toggle('hidden', mode !== 'json');
  $('#custom-model-panel').classList.toggle('hidden', mode === 'json');
}

function resourceConfigFromForm(form) {
  let config = {};
  if (form.dataset.mode === 'json') {
    const resourceJson = form.elements.resourceJson.value.trim();
    if (!resourceJson) throw new Error('请填写资源 JSON');
    config = normalizeImportedResourceConfig(JSON.parse(resourceJson));
  } else {
    for (const name of manualResourceFieldNames) {
      const value = form.elements[name].value.trim();
      if (value) config[name] = value;
    }
    Object.assign(config, collectCustomModelFieldsFromForm());
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
    const projectLevelSharing = form.elements.projectLevelSharing.checked;
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
          projectLevelSharing,
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
          projectLevelSharing,
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
  $('#model-user').innerHTML = '<option value="">全部</option>' + state.users
    .map(user => `<option value="${escapeHtml(user.userId)}">${escapeHtml(user.displayName || user.loginName)}</option>`).join('');
}

function renderUsers() {
  $('#user-empty').classList.toggle('hidden', state.users.length > 0);
  $('#user-list').innerHTML = state.users.map(user => {
    const quota = user.quota || {};
    const personalLimit = user.monthlyLimit
      ? `${formatMoney(user.monthlyLimit)} CNY`
      : '不设个人上限';
    const effectiveAvailable = quota.effectiveAvailableAmount === null
      || quota.effectiveAvailableAmount === undefined
      ? '不限额'
      : `${formatMoney(quota.effectiveAvailableAmount)} CNY`;
    const bindings = user.bindings || [];
    const bindingColumn = (render, fallback) => bindings.length
      ? `<div class="cell-title">${bindings.map(render).join('')}</div>`
      : fallback;
    return `<tr>
    <td><div class="cell-title"><strong>${escapeHtml(user.loginName)}</strong>${user.password ? `<div class="user-password"><span class="secret-value" data-password-value>••••••••</span><button class="small-button link-button" data-user-action="toggle-password" data-user-id="${escapeHtml(user.userId)}" type="button">查看密码</button></div>` : '<span>历史账号需修改密码</span>'}</div></td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(binding.configGroupName)}${binding.isDefault ? '（默认）' : ''}</span>`, escapeHtml(user.configGroupName || '未分配'))}</td>
    <td>${bindingColumn(binding => `<span>${binding.monthlyLimit ? `${escapeHtml(formatMoney(binding.monthlyLimit))} CNY` : '不设个人上限'}</span>`, escapeHtml(personalLimit))}</td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(formatMoney(binding.quota?.actualAmount || 0))} CNY</span>`, `${escapeHtml(formatMoney(quota.actualAmount || 0))} CNY`)}</td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(formatMoney(binding.quota?.reservedAmount || 0))} CNY</span>`, `${escapeHtml(formatMoney(quota.reservedAmount || 0))} CNY`)}</td>
    <td>${bindingColumn(binding => {
      const available = binding.quota?.effectiveAvailableAmount;
      return `<span>${available === null || available === undefined ? '不限额' : `${escapeHtml(formatMoney(available))} CNY`}</span>`;
    }, escapeHtml(effectiveAvailable))}</td>
    <td><div class="cell-title user-status">${badge(user.status)}${user.profileSyncErrorMessage ? `<span>${escapeHtml(user.profileSyncErrorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(user.profileSyncErrorMessage)}${user.profileSyncRequestId ? ` · Request ID: ${escapeHtml(user.profileSyncRequestId)}` : ''}</span>` : ''}</div></td>
    <td class="user-menu-cell"><button class="user-menu-trigger" data-user-menu="${escapeHtml(user.userId)}" type="button" aria-label="账号操作" aria-haspopup="menu">⋯</button></td>
  </tr>`;
  }).join('');
}

function closeUserActionMenu() {
  $('#user-action-menu').classList.add('hidden');
}

function openUserActionMenu(button, user) {
  const menu = $('#user-action-menu');
  menu.innerHTML = `<button data-user-action="edit" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">编辑</button>
    ${user.profileSyncErrorMessage ? `<button data-user-action="retry" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">重试同步</button>` : ''}
    ${user.status === 'ACTIVE'
      ? `<button class="danger" data-user-action="disable" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">停用</button>`
      : user.status === 'DISABLED'
        ? `<button data-user-action="enable" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">恢复</button>`
        : ''}
    <button class="danger" data-user-action="delete" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">删除</button>`;
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  menu.classList.remove('hidden');
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
  refreshPriceScopeSelect();
  $('#user-id').value = user?.userId || '';
  setText('#user-dialog-title', user ? `编辑 · ${user.displayName || user.loginName || ''}`.trim() : '新建子账号');
  setText('#user-submit', user ? '保存' : '创建账号');
  form.elements.loginName.readOnly = Boolean(user);
  form.elements.password.required = !user;
  form.dataset.originalPassword = user?.password || '';
  setText('#user-password-help', user?.password ? '当前密码，可直接修改' : user ? '历史账号需设置新密码后才能回显' : '创建时必填');
  if (user) {
    form.elements.displayName.value = user.displayName || '';
    form.elements.loginName.value = user.loginName || '';
    form.elements.password.value = user.password || '';
  }
  renderUserBindingCards((user?.bindings || []).map(binding => ({
    configGroupId: binding.configGroupId,
    monthlyLimit: binding.monthlyLimit || '',
    isDefault: binding.isDefault,
  })));
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
        configGroupBindings: collectUserBindings(),
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
  refreshPriceScopeFilter();
  const scopeId = $('#price-scope-filter').value;
  const scopeType = scopeId === '*' ? 'PLATFORM' : 'CONFIG_GROUP';
  const result = await api(`/api/admin/prices?accountId=${encodeURIComponent(state.actor.accountId)}&scopeType=${scopeType}&scopeId=${encodeURIComponent(scopeId)}`);
  const items = result.items || [];
  state.prices = items;
  $('#price-empty').classList.toggle('hidden', items.length > 0);
  $('#price-list').innerHTML = items.map(item => `<tr>
    <td><div class="cell-title"><strong class="billing-item-full">${escapeHtml(item.billingItemId)}</strong>${item.custom ? '<span>自定义计费项</span>' : ''}</div></td>
    <td>${escapeHtml(item.unit)}</td>
    <td>${escapeHtml(formatPrice(item.customerUnitPrice))}</td>
    <td>${escapeHtml(formatPrice(item.costUnitPrice))}</td>
    <td>${item.configured ? badge(item.enabled ? 'ACTIVE' : 'DISABLED') : item.inherited ? '<span class="badge neutral">继承平台兜底</span>' : item.builtinDefault ? '<span class="badge neutral">内置兜底</span>' : '<span class="badge neutral">待配置</span>'}</td>
    <td><div class="inline-actions"><button class="small-button" data-price-action="edit" data-price-scope-type="${escapeHtml(item.scopeType || '')}" data-price-scope-id="${escapeHtml(item.scopeId || '')}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">${item.configured ? '编辑' : '配置'}</button>${item.enabled ? `<button class="small-button danger" data-price-action="delete" data-price-scope-type="${escapeHtml(item.scopeType)}" data-price-scope-id="${escapeHtml(item.scopeId)}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">删除</button>` : ''}</div></td>
  </tr>`).join('');
}

async function deletePrice(button) {
  if (!window.confirm('确认停用该价格配置？历史任务继续使用已有价格快照。')) return;
  try {
    await api('/api/admin/prices', {
      method: 'DELETE',
      body: JSON.stringify({
        accountId: state.actor.accountId,
        scopeType: button.dataset.priceScopeType,
        scopeId: button.dataset.priceScopeId,
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
  const title = item ? '编辑价格' : '新增价格';
  setText('#price-dialog-title', title);
  $('#price-dialog-title').title = title;
  // 计费项 ID、计费单位、作用范围是价格记录的主键，编辑时锁定，仅可改单价
  form.elements.billingItemId.readOnly = Boolean(item);
  form.elements.unit.readOnly = Boolean(item);
  form.elements.scopeId.disabled = Boolean(item?.configured);
  refreshPriceScopeSelect(item?.scopeId || $('#price-scope-filter').value);
  if (item) {
    form.elements.billingItemId.value = item.billingItemId;
    form.elements.unit.value = item.unit;
    form.elements.customerUnitPrice.value = formatPrice(item.customerUnitPrice);
    form.elements.costUnitPrice.value = formatPrice(item.costUnitPrice);
  } else {
    form.elements.billingItemId.value = '';
    form.elements.unit.value = '';
    form.elements.customerUnitPrice.value = '1';
    form.elements.costUnitPrice.value = '0.5';
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
        accountId: state.actor.accountId,
        scopeType: form.elements.scopeId.value === '*' ? 'PLATFORM' : 'CONFIG_GROUP',
        scopeId: form.elements.scopeId.value,
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
  const params = new URLSearchParams({ accountId: state.actor.accountId });
  if (kind === 'prices') {
    const scopeId = $('#price-scope-filter').value || '*';
    params.set('scopeId', scopeId);
    params.set('scopeType', scopeId === '*' ? 'PLATFORM' : 'CONFIG_GROUP');
  }
  const response = await fetch(`/api/admin/${kind}/import-template?${params}`, {
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
    const payload = { accountId: state.actor.accountId, csv: await file.text() };
    if (kind === 'prices') {
      const scopeId = $('#price-scope-filter').value || '*';
      payload.scopeId = scopeId;
      payload.scopeType = scopeId === '*' ? 'PLATFORM' : 'CONFIG_GROUP';
    }
    const result = await api(`/api/admin/${kind}/import`, {
      method: 'POST',
      body: JSON.stringify(payload),
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

function renderModelFilterOptions() {
  const billingSelect = $('#model-billing-item');
  const selectedBilling = billingSelect.value;
  const billingItems = [...new Set(state.billingCatalog.map(item => item.billingItemId))].sort();
  billingSelect.innerHTML = '<option value="">全部</option>' + billingItems
    .map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  billingSelect.value = billingItems.includes(selectedBilling) ? selectedBilling : '';
}

async function loadModelCatalog() {
  const result = await api(`/api/admin/billing-catalog?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.billingCatalog = result.items || [];
  renderModelFilterOptions();
}

function formatUsageByUnit(items) {
  return items.length > 0
    ? `<span class="usage-grid">${items.map(item =>
      `<span title="${escapeHtml(usageTitle(item.usageValue, item.unit))}"><strong>${escapeHtml(formatQuantity(item.usageValue, item.unit))}</strong><small>${escapeHtml(item.unit === 'token' ? 'Token 总量' : item.unit)}</small></span>`).join('')}</span>`
    : '0';
}

function formatQuantity(value, unit) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return unit === 'token' ? '0' : '0.00';
  if (unit === 'token') return formatCompactCount(parsed);
  return parsed.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function formatExactCount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString('zh-CN') : '0';
}

function formatCompactCount(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return '0';
  const abs = Math.abs(parsed);
  const units = [
    { threshold: 1_000_000_000, suffix: 'B' },
    { threshold: 1_000_000, suffix: 'M' },
    { threshold: 10_000, suffix: 'K' },
  ];
  const unit = units.find(item => abs >= item.threshold);
  if (!unit) return Math.round(parsed).toLocaleString('zh-CN');
  const valueInUnit = parsed / unit.threshold;
  const digits = Math.abs(valueInUnit) >= 100 ? 0 : Math.abs(valueInUnit) >= 10 ? 1 : 2;
  return `${valueInUnit.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')}${unit.suffix}`;
}

function usageTitle(value, unit) {
  return unit === 'token'
    ? `${formatExactCount(value)} token`
    : `${formatQuantity(value, unit)} ${unit}`;
}

function tokenUsageDetails(tokenUsage) {
  if (!tokenUsage) return '';
  const inputRaw = tokenUsage.inputTokens ?? 0;
  const outputRaw = tokenUsage.outputTokens ?? 0;
  const cachedRaw = tokenUsage.cachedTokens ?? 0;
  const input = formatCompactCount(inputRaw);
  const output = formatCompactCount(outputRaw);
  const cached = formatCompactCount(cachedRaw);
  const label = `Input: ${formatExactCount(inputRaw)} token；Output: ${formatExactCount(outputRaw)} token；Cache: ${formatExactCount(cachedRaw)} token`;
  return `<div class="token-usage" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
    <span><em>Input</em><strong>${escapeHtml(input)}</strong></span>
    <span><em>Output</em><strong>${escapeHtml(output)}</strong></span>
    <span><em>Cache</em><strong>${escapeHtml(cached)}</strong></span>
  </div>`;
}

function usageCell(item) {
  const main = `${formatQuantity(item.actualUsage ?? item.estimatedUsage, item.unit)} ${item.unit}`;
  const tokenDetails = tokenUsageDetails(item.tokenUsage);
  if (!tokenDetails) return escapeHtml(main);
  return `<div class="cell-title usage-cell"><strong>${escapeHtml(main)}</strong>${tokenDetails}</div>`;
}

async function loadModelUsage(page = 1) {
  state.modelPage = page;
  const params = new URLSearchParams({
    accountId: state.actor.accountId,
    startDate: $('#model-start-date').value,
    endDate: $('#model-end-date').value,
    mode: $('#model-mode').value,
    groupBy: 'billingItem',
    page: String(page),
    pageSize: '50',
  });
  const optional = {
    billingItemId: $('#model-billing-item').value.trim(),
    configGroupId: $('#model-config-group').value,
    userId: $('#model-user').value,
    status: $('#model-status').value,
  };
  Object.entries(optional).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  const result = await api(`/api/admin/model-usage?${params}`);
  const summary = result.mode === 'summary';
  setText('#model-call-count', result.totals.callCount || 0);
  $('#model-usage-total').innerHTML = formatUsageByUnit(result.usageByUnit || []);
  setText('#model-customer-amount', formatMoney(result.totals.customerAmount));
  setText('#model-cost-amount', formatMoney(result.totals.costAmount));
  $('#model-empty').classList.toggle('hidden', result.items.length > 0);
  $('#model-head').innerHTML = summary
    ? '<th>计费项</th><th>单位</th><th>调用数</th><th>成功</th><th>失败</th><th>用量</th><th>客户金额</th>'
      + (state.actor.role === 'SYSTEM_ADMIN' ? '<th>内部成本</th>' : '')
    : '<th>时间</th><th>计费项</th><th>配置组</th><th>子账号</th><th>状态</th><th>用量</th><th>客户金额</th>'
      + (state.actor.role === 'SYSTEM_ADMIN' ? '<th>内部成本</th>' : '');
  $('#model-list').innerHTML = result.items.map(item => summary
    ? `<tr><td>${escapeHtml(item.dimensionName || item.dimensionId || '—')}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.callCount)}</td><td>${escapeHtml(item.successCount || 0)}</td><td>${escapeHtml(item.failedCount || 0)}</td><td>${escapeHtml(formatQuantity(item.usageValue, item.unit))}</td><td>${escapeHtml(formatMoney(item.customerAmount))}</td>${state.actor.role === 'SYSTEM_ADMIN' ? `<td>${escapeHtml(formatMoney(item.costAmount))}</td>` : ''}</tr>`
    : `<tr><td>${escapeHtml(formatBeijingDateTime(item.createdAt))}</td><td>${escapeHtml(item.billingItemId)}</td><td>${escapeHtml(item.configGroupName)}</td><td>${escapeHtml(item.displayName || item.loginName)}</td><td>${modelStatusCell(item)}</td><td>${usageCell(item)}</td><td>${escapeHtml(formatMoney(item.customerAmount))}</td>${state.actor.role === 'SYSTEM_ADMIN' ? `<td>${escapeHtml(formatMoney(item.costAmount))}</td>` : ''}</tr>`).join('');
  const totalPages = Math.max(1, Math.ceil(Number(result.total || 0) / Number(result.pageSize || 50)));
  setText('#model-page', `第 ${result.page} / ${totalPages} 页`);
  $('#model-prev').disabled = result.page <= 1;
  $('#model-next').disabled = result.page >= totalPages;
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
  if (section === 'models') {
    const ensureGroups = state.groups.length === 0
      ? loadConfigGroups()
      : Promise.resolve().then(renderModelConfigGroupOptions);
    ensureGroups
      .then(() => loadModelCatalog())
      .then(() => loadModelUsage())
      .catch(error => toast(error.message, true));
  }
  if (section === 'bills') loadBills().catch(error => toast(error.message, true));
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = $('#login-message');
  try {
    message.textContent = '正在登录…';
    message.classList.remove('error');
    const formData = Object.fromEntries(new FormData(form));
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(formData),
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
$('#project-logout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  window.location.reload();
});
$('#project-list').addEventListener('click', event => {
  const button = event.target.closest('[data-project-connection]');
  if (!button) return;
  enterStudio(button.dataset.projectConnection, button.dataset.projectGroup).catch(error => {
    setText('#project-message', error.message);
    $('#project-message').classList.add('error');
  });
});

$$('.nav-item').forEach(button => button.addEventListener('click', () => switchSection(button.dataset.section)));
$('#new-config').addEventListener('click', () => openConfigDialog());
$('#new-user').addEventListener('click', () => openUserDialog());
$('#add-price').addEventListener('click', () => openPriceDialog());
$('#price-scope-filter').addEventListener('change', event => {
  event.currentTarget.dataset.userSelected = 'true';
  loadPrices().catch(error => toast(error.message, true));
});
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
$('#model-search').addEventListener('click', () => loadModelUsage().catch(error => toast(error.message, true)));
$('#model-prev').addEventListener('click', () => loadModelUsage(Math.max(1, state.modelPage - 1)).catch(error => toast(error.message, true)));
$('#model-next').addEventListener('click', () => loadModelUsage(state.modelPage + 1).catch(error => toast(error.message, true)));
$$('.config-mode-tab').forEach(button => button.addEventListener('click', () => setConfigMode(button.dataset.configMode)));
$('#add-custom-model').addEventListener('click', () => {
  const models = getCustomModelConfigsFromDom();
  models.push(defaultCustomModel('LANGUAGE', models.length));
  renderCustomModelCards(models);
});
$('#custom-model-list').addEventListener('input', event => {
  const card = event.target.closest('.custom-model-card');
  if (!card) return;
  setCustomModelCardVerified(card, 'untested');
  if (event.target.matches('[data-custom-model-field="name"]')) updateCustomModelTitle(card);
  if (event.target.matches('[data-custom-model-field="type"]')) {
    renderCustomModelCards(getCustomModelConfigsFromDom());
  }
});
$('#custom-model-list').addEventListener('change', event => {
  const card = event.target.closest('.custom-model-card');
  if (!card) return;
  setCustomModelCardVerified(card, 'untested');
  if (event.target.matches('[data-custom-model-field="type"]')) {
    renderCustomModelCards(getCustomModelConfigsFromDom());
  }
});
$('#custom-model-list').addEventListener('click', event => {
  const button = event.target.closest('[data-custom-model-action]');
  if (!button) return;
  const card = button.closest('.custom-model-card');
  if (!card) return;
  if (button.dataset.customModelAction === 'delete') {
    const models = getCustomModelConfigsFromDom();
    models.splice(Number(card.dataset.customModelIndex || 0), 1);
    renderCustomModelCards(models);
  }
  if (button.dataset.customModelAction === 'toggle-secret') {
    const input = card.querySelector('[data-custom-model-field="apiKey"]');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    button.textContent = visible ? '查看' : '隐藏';
  }
  if (button.dataset.customModelAction === 'test') testCustomModelConnection(card);
});

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
  const menuButton = event.target.closest('[data-user-menu]');
  if (menuButton) {
    const user = state.users.find(item => item.userId === menuButton.dataset.userMenu);
    if (user) openUserActionMenu(menuButton, user);
    return;
  }
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  if (button.dataset.userAction === 'toggle-password') {
    const user = state.users.find(item => item.userId === button.dataset.userId);
    if (!user?.password) return;
    const visible = button.dataset.visible === 'true';
    const value = button.closest('tr').querySelector('[data-password-value]');
    value.textContent = visible ? '••••••••' : user.password;
    button.dataset.visible = String(!visible);
    button.textContent = visible ? '查看密码' : '隐藏密码';
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

$('#user-action-menu').addEventListener('click', event => {
  const button = event.target.closest('[data-user-action]');
  if (!button) return;
  closeUserActionMenu();
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

document.addEventListener('click', event => {
  if (!event.target.closest('[data-user-menu], #user-action-menu')) closeUserActionMenu();
});
window.addEventListener('resize', closeUserActionMenu);
window.addEventListener('scroll', closeUserActionMenu, true);

$('#price-list').addEventListener('click', event => {
  const button = event.target.closest('[data-price-action]');
  if (!button) return;
  if (button.dataset.priceAction === 'edit') {
    const item = state.prices.find(price =>
      (price.scopeType || '') === button.dataset.priceScopeType
      && (price.scopeId || '') === button.dataset.priceScopeId
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
$('#add-user-binding').addEventListener('click', () => {
  const selectedIds = new Set(collectUserBindings().map(binding => binding.configGroupId));
  const next = state.groups
    .filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status))
    .find(group => !selectedIds.has(group.configGroupId));
  const bindings = collectUserBindings();
  bindings.push({ configGroupId: next?.configGroupId || '', monthlyLimit: null, isDefault: bindings.length === 0 });
  renderUserBindingCards(bindings);
});
$('#user-binding-list').addEventListener('click', event => {
  if (!event.target.closest('[data-binding-remove]')) return;
  const bindings = collectUserBindings();
  if (bindings.length <= 1) return;
  event.target.closest('[data-binding-card]').remove();
  const remaining = collectUserBindings();
  if (!remaining.some(binding => binding.isDefault) && $('#user-binding-list [data-binding-default]')) {
    $('#user-binding-list [data-binding-default]').checked = true;
  }
});

$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => dialog.addEventListener('close', () => {
  const form = dialog.querySelector('form');
  form?.reset();
  if (form) setFormMessage(form, '');
}));

api('/api/auth/me')
  .then(result => routeActor(result.user))
  .catch(() => undefined);
