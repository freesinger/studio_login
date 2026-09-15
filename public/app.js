import { runtimeConfig } from './runtime-config.js';
import { t, locale } from './i18n.js';

const { currency, timeZone, defaultPrices } = runtimeConfig;

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
  overview: t('nav.overview'),
  configs: t('nav.resourceGroups'),
  users: t('nav.subaccounts'),
  prices: t('nav.pricing'),
  models: t('nav.modelUsage'),
  bills: t('nav.bills'),
};

const statusLabels = {
  ACTIVE: t('status.active'),
  AVAILABLE: t('status.available'),
  CANCELLED: t('status.cancelled'),
  DISABLED: t('status.disabled'),
  DRAFT: t('status.draft'),
  FAILED: t('status.failed'),
  DELETE_FAILED: t('status.deleteFailed'),
  PARTIAL_FAILED: t('status.partiallySynced'),
  PROVISIONING: t('status.provisioning'),
  READY: t('status.connected'),
  RUNNING: t('status.running'),
  SUCCEEDED: t('status.succeeded'),
  SYNC_FAILED: t('status.syncFailed'),
  SYNCING: t('status.syncing'),
};

const manualResourceFieldNames = [
  'lasApiKey',
  'arkApiKey',
  'tosBucketName',
];

const customModelFieldNames = ['customModels'];

const customModelTypes = {
  IMAGE: t('customModels.imageType'),
  LANGUAGE: t('customModels.languageType'),
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

async function fetchResponse(url, options) {
  try { return await fetch(url, options); }
  catch { throw new Error(t('errors.network')); }
}

async function api(url, options = {}) {
  const response = await fetchResponse(url, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      'accept-language': locale,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || t('errors.requestFailed', { status: response.status }));
  return body;
}

function parseResourceJson(value) {
  try { return JSON.parse(value); }
  catch { throw new Error(t('validation.resourceJsonSyntax')); }
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

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(locale, { timeZone });
}

function modelStatusCell(item) {
  const runningMinutes = Number(item.runningMinutes || 0);
  if (item.status !== 'RUNNING') return badge(item.status);
  const reconcileStatus = item.lastReconcileStatus ? String(item.lastReconcileStatus) : '';
  const stale = runningMinutes >= 30;
  const diagnostics = [];
  if (stale) diagnostics.push(t('modelUsage.overdueDescription', { minutes: runningMinutes }));
  if (reconcileStatus) diagnostics.push(t('modelUsage.lastReconcileStatus', { status: reconcileStatus }));
  if (item.reconcileAttempts) diagnostics.push(t('modelUsage.reconcileAttempts', { count: item.reconcileAttempts }));
  if (item.lastReconcileAt) diagnostics.push(t('modelUsage.lastQueryAt', { date: formatDateTime(item.lastReconcileAt) }));
  if (item.nextReconcileAt) diagnostics.push(t('modelUsage.nextQueryAt', { date: formatDateTime(item.nextReconcileAt) }));
  if (diagnostics.length === 0) return badge(item.status);
  const details = diagnostics.join(locale === 'en' ? '; ' : '；');
  return `<span class="status-tooltip" tabindex="0" aria-label="${escapeHtml(details)}"><span class="badge warning">${stale ? t('modelUsage.runningOverdue') : t('status.running')}</span><span class="status-tooltip-content" role="tooltip">${escapeHtml(details)}</span></span>`;
}

function calendarDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type).value).join('-');
}

function currentPeriod() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function formatMoney(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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
    name: t('customModels.defaultName', { index: index + 1 }),
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
  const name = readStringValue(input.name, input.modelName, input.displayName, model, t('customModels.defaultName', { index: index + 1 }));
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
  if (!isPlainObject(input)) throw new Error(t('validation.resourceJsonObject'));
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
  if (verified === 'testing') return t('customModels.testing');
  if (verified === 'pass') return t('customModels.verified');
  if (verified === 'unpass') return t('customModels.testFailed');
  return t('customModels.untested');
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
    const title = normalized.name || t('customModels.defaultName', { index: index + 1 });
    const status = normalized.verified || 'untested';
    const ratios = uniqueKnownValues(normalized.imageRatios, customImageRatios);
    const resolutions = uniqueKnownValues(normalized.imageResolutions, customImageResolutions);
    return `<article class="custom-model-card" data-custom-model-index="${index}" data-verified="${escapeHtml(status)}">
      <input data-custom-model-field="id" type="hidden" value="${escapeHtml(normalized.id || '')}">
      <div class="custom-model-card-header">
        <div class="custom-model-title"><strong>${escapeHtml(title)}</strong><span class="custom-model-status" data-status="${escapeHtml(status)}"><span></span>${escapeHtml(customModelStatusLabel(status))}</span></div>
        <div class="inline-actions"><button class="small-button" data-custom-model-action="test" type="button">${t('customModels.testConnection')}</button><button class="small-button danger" data-custom-model-action="delete" type="button">${t('common.delete')}</button></div>
      </div>
      <div class="form-grid two-columns">
        <label><span><span class="required-mark">*</span> ${t('customModels.name')}</span><input data-custom-model-field="name" maxlength="128" value="${escapeHtml(normalized.name)}" placeholder="${t('customModels.modelPlaceholder')}"></label>
        <label><span><span class="required-mark">*</span> ${t('customModels.type')}</span><select data-custom-model-field="type">${Object.entries(customModelTypes).map(([value, label]) => `<option value="${value}" ${type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label><span><span class="required-mark">*</span> ${t('customModels.modelId')}</span><input data-custom-model-field="model" maxlength="128" value="${escapeHtml(normalized.model)}" placeholder="${t('customModels.modelPlaceholder')}"></label>
        <label class="custom-endpoint-field ${type === 'ELEVENLABS' ? 'hidden' : ''}"><span><span class="required-mark">*</span> ${t('customModels.baseUrl')}</span><input data-custom-model-field="endpoint" maxlength="512" value="${escapeHtml(normalized.endpoint)}" placeholder="${t('common.unknown')}"></label>
        <label class="span-two"><span><span class="required-mark">*</span> ${t('customModels.apiKey')}</span><span class="secret-input"><input data-custom-model-field="apiKey" type="password" autocomplete="off" value="${escapeHtml(normalized.apiKey)}"><button class="secret-toggle" data-custom-model-action="toggle-secret" type="button">${t('common.show')}</button></span></label>
      </div>
      <div class="custom-image-options ${type === 'IMAGE' ? '' : 'hidden'}">
        <div class="custom-option-group"><span class="custom-option-label"><span class="required-mark">*</span> ${t('customModels.aspectRatios')}</span><div class="choice-chips">${customImageRatios.map(ratio => `<label class="choice-chip"><input data-custom-model-field="imageRatios" type="checkbox" value="${ratio}" ${ratios.includes(ratio) ? 'checked' : ''}><span>${ratio}</span></label>`).join('')}</div><p class="muted">${t('customModels.aspectRatiosHelp')}</p></div>
        <div class="custom-option-group"><span class="custom-option-label"><span class="required-mark">*</span> ${t('customModels.resolutions')}</span><div class="choice-chips">${customImageResolutions.map(resolution => `<label class="choice-chip"><input data-custom-model-field="imageResolutions" type="checkbox" value="${resolution}" ${resolutions.includes(resolution) ? 'checked' : ''}><span>${resolution}</span></label>`).join('')}</div><p class="muted">${t('customModels.resolutionsHelp')}</p></div>
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
  title.textContent = name || t('customModels.defaultName', { index: Number(card.dataset.customModelIndex || 0) + 1 });
}

function validateCustomModels(models) {
  const nameCounts = new Map();
  models.forEach(model => {
    const key = model.name.trim().toLowerCase();
    if (key) nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  });
  models.forEach((model, index) => {
    const position = t('customModels.position', { index: index + 1 });
    if (!model.name.trim()) throw new Error(t('customModels.nameRequired', { model: position }));
    if ((nameCounts.get(model.name.trim().toLowerCase()) || 0) > 1) throw new Error(t('customModels.duplicateName', { model: position }));
    if (!model.model.trim()) throw new Error(t('customModels.idRequired', { model: position }));
    if (model.type !== 'ELEVENLABS' && !model.endpoint.trim()) throw new Error(t('customModels.baseUrlRequired', { model: position }));
    if (!model.apiKey.trim()) throw new Error(t('customModels.apiKeyRequired', { model: position }));
    if (model.type === 'IMAGE' && (!model.imageRatios || model.imageRatios.length === 0)) throw new Error(t('customModels.aspectRatioRequired', { model: position }));
    if (model.type === 'IMAGE' && (!model.imageResolutions || model.imageResolutions.length === 0)) throw new Error(t('customModels.resolutionRequired', { model: position }));
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
      config = normalizeImportedResourceConfig(parseResourceJson(resourceJson));
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
    button.textContent = t('common.testing');
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
    toast(t('customModels.connectionVerified'));
  } catch (error) {
    setCustomModelCardVerified(card, 'unpass');
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = t('customModels.testConnection');
  }
}


async function enterStudio(connectionId, configGroup) {
  setText('#project-message', t('projects.openingStudio'));
  const result = await api('/api/studio/tickets/launch', {
    method: 'POST',
    body: JSON.stringify(configGroup ? { connectionId, configGroup } : {}),
  });
  window.open(result.launchUrl, '_blank', 'noopener,noreferrer');
  setText('#project-message', t('projects.studioOpened'));
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
  setText('#project-user', t('projects.chooseForUser', { name: actor.displayName || actor.loginName }));
  setText('#project-message', t('projects.loading'));
  try {
    const result = await api('/api/auth/my-projects');
    state.loginProjects = result.items || [];
    $('#project-list').innerHTML = state.loginProjects.length
      ? state.loginProjects.map(item => `<button class="connection-add-card project-entry" data-project-connection="${escapeHtml(item.connectionId)}" data-project-group="${escapeHtml(item.name)}" type="button">
          <strong>${escapeHtml(item.projectId || item.name)}</strong>
          <span>${escapeHtml(item.connectionName || item.connectionId)}${item.isDefault ? t('common.defaultSuffix') : ''}</span>
        </button>`).join('')
      : `<div class="empty">${t('projects.empty')}</div>`;
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
  setText('#actor-role', actor.role === 'SYSTEM_ADMIN' ? t('roles.systemAdmin') : t('roles.enterpriseAdmin'));
  setText('#actor-avatar', (actor.displayName || actor.loginName || 'A').slice(0, 1).toUpperCase());
  setText('#account-name', actor.accountId);
  $('#bill-period').value = currentPeriod();
  const today = calendarDate(new Date());
  const weekAgo = new Date(`${today}T00:00:00Z`);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 6);
  $('#model-end-date').value = today;
  $('#model-start-date').value = weekAgo.toISOString().slice(0, 10);
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
    .join('') || `<option value="">${t('connections.createFirst')}</option>`;
  const cards = state.connections.map(item => `<article class="connection-card">
    <div class="connection-card-header">
      <div class="connection-card-title"><h3>${escapeHtml(item.name)}</h3>${item.isDefault ? `<span class="badge neutral">${t('common.default')}</span>` : ''}</div>
      ${badge(item.status)}
    </div>
    <dl class="connection-details">
      <div><dt>${t('connections.studioService')}</dt><dd>${escapeHtml(item.studioBaseUrl || t('common.notConfigured'))}</dd></div>
      <div><dt>${t('connections.loginCallback')}</dt><dd>${escapeHtml(item.callbackBaseUrl || t('common.notConfigured'))}</dd></div>
      <div><dt>${t('connections.deploymentRegion')}</dt><dd>${escapeHtml(item.region || item.tosRegion || t('common.loadFailed'))}</dd></div>
      <div><dt>${t('connections.credentials')}</dt><dd>${item.tokenConfigured ? t('connections.credentialsConfigured') : t('common.unconfigured')}</dd></div>
    </dl>
    <div class="connection-card-actions">
      <button class="small-button" data-connection-action="edit" data-connection-id="${escapeHtml(item.connectionId)}" type="button">${t('common.edit')}</button>
      ${item.status === 'FAILED' ? `<button class="small-button" data-connection-action="retry" data-connection-id="${escapeHtml(item.connectionId)}" type="button">${t('connections.retryRegistration')}</button>` : ''}
      <button class="small-button danger" data-connection-action="delete" data-connection-id="${escapeHtml(item.connectionId)}" type="button">${item.status === 'DELETE_FAILED' ? t('common.retryDeletion') : t('common.delete')}</button>
    </div>
  </article>`).join('');
  $('#connection-list').innerHTML = `${cards}<button class="connection-add-card" data-connection-action="create" type="button">
    <span class="connection-add-icon">+</span><strong>${t('connections.create')}</strong><span>${t('connections.createHelp')}</span>
  </button>`;
}

function openStudioDialog(connection = null) {
  const form = $('#studio-form');
  form.reset();
  setFormMessage(form, '');
  $('#studio-connection-id').value = connection?.connectionId || '';
  setText('#studio-dialog-title', connection ? t('common.editNamed', { name: connection.name }) : t('connections.add'));
  if (connection) {
    form.elements.name.value = connection.name;
    form.elements.studioBaseUrl.value = connection.studioBaseUrl;
    form.elements.callbackBaseUrl.value = connection.callbackBaseUrl;
  } else {
    form.elements.name.value = t('connections.connection');
    form.elements.studioBaseUrl.value = defaultStudioBaseUrl;
  }
  $('#studio-dialog').showModal();
}

async function submitStudioConnection(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, t('connections.registering'));
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
    toast(t('connections.registered'));
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
    toast(t('connections.registrationRetried'));
  } catch (error) {
    await loadConnections().catch(() => undefined);
    toast(error.message, true);
  }
}

async function deleteConnection(connectionId) {
  if (!window.confirm(t('connections.confirmDelete'))) return;
  try {
    await api(`/api/admin/studio/connections/${encodeURIComponent(connectionId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadConnections();
    toast(t('connections.deleted'));
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
  setText('#stat-groups-note', t('overview.assignableGroups', { count: state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status)).length }));
  refreshGroupSelect();
  refreshPriceScopeFilter();
  renderModelConfigGroupOptions();
}

function renderModelConfigGroupOptions() {
  const select = $('#model-config-group');
  if (!select) return;
  const current = select.value;
  const groups = state.groups.filter(group => group.status !== 'DELETED');
  select.innerHTML = `<option value="">${t('common.all')}</option>` + groups
    .map(group => `<option value="${escapeHtml(group.configGroupId)}">${escapeHtml(group.projectId || group.name || group.configGroupId)}</option>`)
    .join('');
  select.value = groups.some(group => group.configGroupId === current) ? current : '';
}

function renderConfigGroups() {
  const list = $('#config-list');
  if (state.groups.length === 0) {
    list.innerHTML = `<div class="empty table-card">${t('groups.empty')}</div>`;
    return;
  }
  list.innerHTML = state.groups.map(group => {
    const config = group.config || {};
    const secretCount = ['lasApiKey', 'arkApiKey', 'tosAccessKey', 'tosSecretKey']
      .filter(key => Boolean(config[key])).length;
    const quota = group.quota || {};
    const limit = quota.limit === null || quota.limit === undefined
      ? t('quota.unlimited')
      : `${formatMoney(quota.limit)} ${currency}`;
    const available = quota.availableAmount === null || quota.availableAmount === undefined
      ? t('quota.unlimited')
      : `${formatMoney(quota.availableAmount)} ${currency}`;
    return `<article class="config-card">
      <div class="config-card-header">
        <div class="config-card-title"><h3>${escapeHtml(group.projectId)}</h3>${group.isDefault ? `<span class="badge neutral">${t('common.default')}</span>` : ''}${badge(group.status)}</div>
        <div class="config-card-actions">
          <button class="small-button" data-config-action="edit" data-group-id="${escapeHtml(group.configGroupId)}" type="button">${t('common.edit')}</button>
          ${group.status === 'PARTIAL_FAILED' ? `<button class="small-button" data-config-action="retry" data-group-id="${escapeHtml(group.configGroupId)}" type="button">${t('common.retrySync')}</button>` : ''}
          <button class="small-button danger" data-config-action="delete" data-group-id="${escapeHtml(group.configGroupId)}" type="button">${t('common.delete')}</button>
        </div>
      </div>
      <div class="config-meta">
        <div><span>${t('groups.configStatus')}</span><strong>${group.currentVersion > 0 ? t('groups.effective') : t('groups.pending')}</strong></div>
        <div><span>${t('connections.connection')}</span><strong>${escapeHtml(group.connectionName || group.appId || t('common.unconfigured'))}</strong></div>
        <div><span>${t('groups.configSource')}</span><strong>${group.resourceConfigSource === 'STUDIO' ? t('groups.remoteSource') : t('groups.localSource')}</strong></div>
        <div><span>${t('common.region')}</span><strong>${escapeHtml(config.region || config.tosRegion || t('common.unconfigured'))}</strong></div>
        <div><span>${t('groups.credentials')}</span><strong>${secretCount > 0 ? t('groups.configuredCredentials', { count: secretCount }) : t('common.unconfigured')}</strong></div>
        <div><span>${t('quota.sharedMonthlyLimit', { period: escapeHtml(group.billingPeriod || currentPeriod()) })}</span><strong>${escapeHtml(limit)}</strong></div>
        <div><span>${t('quota.settledThisMonth')}</span><strong>${escapeHtml(formatMoney(quota.actualAmount || 0))} ${currency}</strong></div>
        <div><span>${t('quota.reservedRunning')}</span><strong>${escapeHtml(formatMoney(quota.reservedAmount || 0))} ${currency}</strong></div>
        <div><span>${t('quota.availableBalance')}</span><strong>${escapeHtml(available)}</strong></div>
        <div><span>${t('groups.dataSharing')}</span><strong>${group.projectLevelSharing ? t('common.enabled') : t('common.disabled')}</strong></div>
      </div>
      ${group.resourceConfigSyncError ? `<div class="sync-notices"><div><strong>${t('groups.showingLocalCache')}</strong><span>${escapeHtml(group.resourceConfigSyncError)}</span></div></div>` : ''}
      ${group.failedUsers?.length ? `<div class="sync-errors">${group.failedUsers.map(user => `<div><strong>${escapeHtml(user.loginName)}</strong><span>${escapeHtml(user.errorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(user.errorMessage || t('status.syncFailed'))}${user.requestId ? ` · Request ID: ${escapeHtml(user.requestId)}` : ''}</span></div>`).join('')}</div>` : ''}
    </article>`;
  }).join('');
}

function refreshGroupSelect() {
  const select = $('#user-config-group');
  if (!select) return;
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  select.innerHTML = available.length
    ? available.map(group => `<option value="${escapeHtml(group.configGroupId)}" ${group.isDefault ? 'selected' : ''}>${escapeHtml(group.projectId)}${group.isDefault ? t('common.defaultParenthetical') : ''}</option>`).join('')
    : `<option value="">${t('groups.createAvailableFirst')}</option>`;
  refreshPriceScopeSelect();
}

function refreshPriceScopeSelect(selectedScopeId = '') {
  const select = $('#price-scope');
  if (!select) return;
  const groups = state.groups.filter(group => group.status !== 'DELETED');
  select.innerHTML = `${groups.map(group =>
    `<option value="${escapeHtml(group.configGroupId)}">${escapeHtml(group.projectId)}</option>`).join('')}
    <option value="*">${t('pricing.platformFallback')}</option>`;
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
    <option value="*">${t('pricing.platformFallback')}</option>`;
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
    <label>${t('common.resourceGroup')}<select data-binding-group required>${available.map(group =>
      `<option value="${escapeHtml(group.configGroupId)}" ${group.configGroupId === binding.configGroupId ? 'selected' : ''}>${escapeHtml(group.projectId)}</option>`).join('')}</select></label>
    <label>${t('quota.subaccountMonthlyLimit', { currency })}<input data-binding-limit inputmode="decimal" placeholder="${t('quota.unlimited')}" value="${escapeHtml(binding.monthlyLimit || '')}"></label>
    <label class="checkbox-row binding-default"><input data-binding-default name="bindingDefault" type="radio" ${binding.isDefault || index === 0 ? 'checked' : ''}><span>${t('common.default')}</span></label>
    <button class="small-button danger" data-binding-remove type="button">${t('common.delete')}</button>
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
  setText('#config-dialog-title', group ? t('common.editNamed', { name: group.projectId }) : t('groups.create'));
  $('#config-default-field').classList.toggle('hidden', Boolean(group));
  // 编辑时锁定 Studio 连接与配置组名称：二者绑定真实 Studio 用户记录与映射，不允许改动
  form.elements.connectionId.disabled = Boolean(group);
  form.elements.projectId.readOnly = Boolean(group);
  const sharingLocked = Boolean(group?.projectLevelSharing);
  form.elements.projectLevelSharing.disabled = sharingLocked;
  $('#config-sharing-field').classList.toggle('locked', sharingLocked);
  $('#config-sharing-locked').classList.toggle('hidden', !sharingLocked);
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
      const config = normalizeImportedResourceConfig(parseResourceJson(form.elements.resourceJson.value.trim()));
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
    if (!resourceJson) throw new Error(t('validation.resourceJsonRequired'));
    config = normalizeImportedResourceConfig(parseResourceJson(resourceJson));
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
    toast(t('groups.synced'));
  } catch (error) {
    await Promise.all([loadConfigGroups(), loadUsers()]).catch(() => undefined);
    toast(error.message, true);
  }
}

async function deleteConfigGroup(configGroupId) {
  if (!window.confirm(t('groups.confirmDelete'))) return;
  try {
    await api(`/api/admin/config-groups/${encodeURIComponent(configGroupId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadConfigGroups();
    toast(t('groups.deleted'));
  } catch (error) {
    toast(error.message, true);
  }
}

async function submitConfig(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, t('groups.saving'));
    const resourceConfig = resourceConfigFromForm(form);
    const monthlyLimit = form.elements.monthlyLimit.value.trim() || null;
    const projectLevelSharing = form.elements.projectLevelSharing.disabled
      ? undefined
      : form.elements.projectLevelSharing.checked;
    const projectId = form.elements.projectId.value.trim();
    const groupId = $('#config-group-id').value;
    if (!groupId && ['lasApiKey', 'arkApiKey', 'tosBucketName'].some(name => !resourceConfig[name])) {
      throw new Error(t('validation.requiredResources'));
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
    toast(groupId ? t('groups.updated') : t('groups.created'));
  } catch (error) {
    setFormMessage(form, error.message, true);
  }
}

async function loadUsers() {
  const result = await api(`/api/admin/subaccounts?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.users = result.items || [];
  renderUsers();
  setText('#stat-users', state.users.length);
  setText('#stat-users-note', t('overview.activeUsers', { count: state.users.filter(user => user.status === 'ACTIVE').length }));
  $('#model-user').innerHTML = `<option value="">${t('common.all')}</option>` + state.users
    .map(user => `<option value="${escapeHtml(user.userId)}">${escapeHtml(user.displayName || user.loginName)}</option>`).join('');
}

function renderUsers() {
  $('#user-empty').classList.toggle('hidden', state.users.length > 0);
  $('#user-list').innerHTML = state.users.map(user => {
    const quota = user.quota || {};
    const personalLimit = user.monthlyLimit
      ? `${formatMoney(user.monthlyLimit)} ${currency}`
      : t('quota.noPersonalLimit');
    const effectiveAvailable = quota.effectiveAvailableAmount === null
      || quota.effectiveAvailableAmount === undefined
      ? t('quota.unlimited')
      : `${formatMoney(quota.effectiveAvailableAmount)} ${currency}`;
    const bindings = user.bindings || [];
    const syncFailures = user.profileSyncFailures || [];
    const bindingColumn = (render, fallback) => bindings.length
      ? `<div class="cell-title">${bindings.map(render).join('')}</div>`
      : fallback;
    return `<tr>
    <td><div class="cell-title"><strong>${escapeHtml(user.displayName || user.loginName)}</strong><span>${escapeHtml(user.loginName)}</span>${user.password ? `<div class="user-password"><span class="secret-value" data-password-value>••••••••</span><button class="small-button link-button" data-user-action="toggle-password" data-user-id="${escapeHtml(user.userId)}" type="button">${t('common.showPassword')}</button></div>` : `<span>${t('users.legacyPasswordUpdate')}</span>`}</div></td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(binding.configGroupName)}${binding.isDefault ? t('common.defaultParenthetical') : ''}</span>`, escapeHtml(user.configGroupName || t('users.unassigned')))}</td>
    <td>${bindingColumn(binding => `<span>${binding.monthlyLimit ? `${escapeHtml(formatMoney(binding.monthlyLimit))} ${currency}` : t('quota.noPersonalLimit')}</span>`, escapeHtml(personalLimit))}</td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(formatMoney(binding.quota?.actualAmount || 0))} ${currency}</span>`, `${escapeHtml(formatMoney(quota.actualAmount || 0))} ${currency}`)}</td>
    <td>${bindingColumn(binding => `<span>${escapeHtml(formatMoney(binding.quota?.reservedAmount || 0))} ${currency}</span>`, `${escapeHtml(formatMoney(quota.reservedAmount || 0))} ${currency}`)}</td>
    <td>${bindingColumn(binding => {
      const available = binding.quota?.effectiveAvailableAmount;
      return `<span>${available === null || available === undefined ? t('quota.unlimited') : `${escapeHtml(formatMoney(available))} ${currency}`}</span>`;
    }, escapeHtml(effectiveAvailable))}</td>
    <td><div class="cell-title user-status">${badge(user.status)}${syncFailures.map(failure =>
      `<span class="profile-sync-failure"><strong>${escapeHtml(failure.configGroupName || failure.configGroupId || t('users.unassigned'))}</strong><span>${escapeHtml(failure.errorCode || 'PROFILE_SYNC_FAILED')} · ${escapeHtml(failure.errorMessage || t('status.syncFailed'))}${failure.requestId ? ` · Request ID: ${escapeHtml(failure.requestId)}` : ''}</span></span>`).join('')}</div></td>
    <td class="user-menu-cell"><button class="user-menu-trigger" data-user-menu="${escapeHtml(user.userId)}" type="button" aria-label="${t('users.actions')}" aria-haspopup="menu">⋯</button></td>
  </tr>`;
  }).join('');
}

function closeUserActionMenu() {
  $('#user-action-menu').classList.add('hidden');
}

function openUserActionMenu(button, user) {
  const menu = $('#user-action-menu');
  menu.innerHTML = `<button data-user-action="edit" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">${t('common.edit')}</button>
    ${user.profileSyncErrorMessage ? `<button data-user-action="retry" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">${t('common.retrySync')}</button>` : ''}
    ${user.status === 'ACTIVE'
      ? `<button class="danger" data-user-action="disable" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">${t('common.disable')}</button>`
      : user.status === 'DISABLED'
        ? `<button data-user-action="enable" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">${t('common.restore')}</button>`
        : ''}
    <button class="danger" data-user-action="delete" data-user-id="${escapeHtml(user.userId)}" role="menuitem" type="button">${t('common.delete')}</button>`;
  const rect = button.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;
  menu.classList.remove('hidden');
}

function openUserDialog(user = null) {
  const available = state.groups.filter(group => ['AVAILABLE', 'PARTIAL_FAILED'].includes(group.status));
  if (available.length === 0) {
    toast(t('users.createGroupFirst'), true);
    switchSection('configs');
    return;
  }
  const form = $('#user-form');
  form.reset();
  form.elements.password.type = 'password';
  $('#toggle-user-password').textContent = t('common.show');
  $('#toggle-user-password').setAttribute('aria-label', t('common.passwordShowLabel'));
  setFormMessage(form, '');
  refreshPriceScopeSelect();
  $('#user-id').value = user?.userId || '';
  setText('#user-dialog-title', user ? t('common.editNamed', { name: user.displayName || user.loginName || '' }).trim() : t('users.add'));
  setText('#user-submit', user ? t('common.save') : t('users.createAccount'));
  form.elements.loginName.readOnly = Boolean(user);
  form.elements.password.required = !user;
  form.dataset.originalPassword = user?.password || '';
  setText('#user-password-help', user?.password ? t('users.currentPasswordHelp') : user ? t('users.legacyPasswordHelp') : t('users.passwordRequiredOnCreate'));
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
    setFormMessage(form, t('users.creating'));
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
    toast(userId ? t('users.updated') : t('users.created'));
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
    toast(status === 'ACTIVE' ? t('users.restored') : t('users.disabled'));
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteSubaccount(userId) {
  if (!window.confirm(t('users.confirmDelete'))) return;
  try {
    await api(`/api/admin/subaccounts/${encodeURIComponent(userId)}?accountId=${encodeURIComponent(state.actor.accountId)}`, {
      method: 'DELETE',
    });
    await loadUsers();
    toast(t('users.deleted'));
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
    toast(t('users.synced'));
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
    <td><div class="cell-title"><strong class="billing-item-full">${escapeHtml(item.billingItemId)}</strong>${item.custom ? `<span>${t('pricing.customBillingItem')}</span>` : ''}</div></td>
    <td>${escapeHtml(item.unit)}</td>
    <td>${escapeHtml(formatPrice(item.customerUnitPrice))}</td>
    <td>${escapeHtml(formatPrice(item.costUnitPrice))}</td>
    <td>${item.configured ? badge(item.enabled ? 'ACTIVE' : 'DISABLED') : item.inherited ? `<span class="badge neutral">${t('pricing.inheritedFallback')}</span>` : item.builtinDefault ? `<span class="badge neutral">${t('pricing.builtinFallback')}</span>` : `<span class="badge neutral">${t('common.notConfigured')}</span>`}</td>
    <td><div class="inline-actions"><button class="small-button" data-price-action="edit" data-price-scope-type="${escapeHtml(item.scopeType || '')}" data-price-scope-id="${escapeHtml(item.scopeId || '')}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">${item.configured ? t('common.edit') : t('common.configure')}</button>${item.enabled ? `<button class="small-button danger" data-price-action="delete" data-price-scope-type="${escapeHtml(item.scopeType)}" data-price-scope-id="${escapeHtml(item.scopeId)}" data-price-item-id="${escapeHtml(item.billingItemId)}" data-price-unit="${escapeHtml(item.unit)}" type="button">${t('common.delete')}</button>` : ''}</div></td>
  </tr>`).join('');
}

async function deletePrice(button) {
  if (!window.confirm(t('pricing.confirmDisable'))) return;
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
    toast(t('pricing.disabled'));
  } catch (error) {
    toast(error.message, true);
  }
}

function openPriceDialog(item = null) {
  const form = $('#price-form');
  form.reset();
  setFormMessage(form, '');
  $('#price-edit-mode').value = item ? '1' : '';
  const title = item ? t('pricing.edit') : t('pricing.add');
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
    form.elements.customerUnitPrice.value = defaultPrices.customerUnitPrice;
    form.elements.costUnitPrice.value = defaultPrices.costUnitPrice;
  }
  $('#price-dialog').showModal();
}

async function submitPrice(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    setFormMessage(form, t('pricing.saving'));
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
    toast(t('pricing.saved'));
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
  const response = await fetchResponse(`/api/admin/${kind}/import-template?${params}`, {
    credentials: 'same-origin',
    headers: { 'accept-language': locale },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || t('csv.downloadFailed', { status: response.status }));
  }
  const blob = await response.blob();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = kind === 'subaccounts' ? 'studio-subaccounts.csv' : 'studio-prices.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importCsv(kind, file) {
  const label = kind === 'subaccounts' ? t('common.subaccount') : t('common.price');
  try {
    toast(t('csv.importing', { kind: label }));
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
    setText('#import-dialog-title', t('csv.resultsForKind', { kind: label }));
    setText('#import-summary', t('csv.summary', { total: result.total, succeeded: result.succeeded, failed: result.failed }));
    $('#import-results').innerHTML = result.items.map(item => `<div class="import-result ${item.success ? '' : 'error'}"><strong>${t('csv.row', { row: escapeHtml(item.row) })}</strong><span>${escapeHtml(item.message)}</span></div>`).join('');
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
  setText('#stat-tasks-note', t('bills.periodLabel', { period: period }));
  setText('#stat-amount', formatMoney(customerAmount));
  $('#bill-empty').classList.toggle('hidden', items.length > 0);
  setText('#bill-subject-heading', dimension === 'configGroup' ? t('common.resourceGroup') : dimension === 'subaccount' ? t('common.subaccount') : t('common.scope'));
  $('#bill-list').innerHTML = items.map(item => `<tr>
    <td>${escapeHtml(item.subject_name || (dimension === 'overall' ? t('bills.overall') : item.subject_id || '—'))}</td>
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
  billingSelect.innerHTML = `<option value="">${t('common.all')}</option>` + billingItems
    .map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('');
  billingSelect.value = billingItems.includes(selectedBilling) ? selectedBilling : '';
}

async function loadModelCatalog() {
  const result = await api(`/api/admin/billing-catalog?accountId=${encodeURIComponent(state.actor.accountId)}`);
  state.billingCatalog = result.items || [];
  renderModelFilterOptions();
}

function formatUsageByUnit(items) {
  if (items.length === 0) return '0';
  const ordered = [...items].sort((left, right) => {
    if (left.unit === 'token') return 1;
    if (right.unit === 'token') return -1;
    return String(left.unit).localeCompare(String(right.unit));
  });
  return `<span class="usage-grid">${ordered.map(item => {
    const label = item.unit === 'token' ? t('modelUsage.totalTokens') : item.unit;
    return `<span class="usage-tile" title="${escapeHtml(usageTitle(item.usageValue, item.unit))}"><strong>${escapeHtml(formatQuantity(item.usageValue, item.unit))}</strong><small>${escapeHtml(label)}</small></span>`;
  }).join('')}</span>`;
}

function formatQuantity(value, unit) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return unit === 'token' ? '0' : '0.00';
  if (unit === 'token') return formatCompactCount(parsed);
  return parsed.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function formatExactCount(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString(locale) : '0';
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
  if (!unit) return Math.round(parsed).toLocaleString(locale);
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
  const label = `${t('modelUsage.inputTokens')}: ${formatExactCount(inputRaw)} token; ${t('modelUsage.outputTokens')}: ${formatExactCount(outputRaw)} token; ${t('modelUsage.cachedTokens')}: ${formatExactCount(cachedRaw)} token`;
  return `<div class="token-usage" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
    <span><em>${t('modelUsage.inputTokens')}</em><strong>${escapeHtml(input)}</strong></span>
    <span><em>${t('modelUsage.outputTokens')}</em><strong>${escapeHtml(output)}</strong></span>
    <span><em>${t('modelUsage.cachedTokens')}</em><strong>${escapeHtml(cached)}</strong></span>
  </div>`;
}

function usageCell(item) {
  const main = `${formatQuantity(item.actualUsage ?? item.estimatedUsage, item.unit)} ${item.unit}`;
  const tokenDetails = tokenUsageDetails(item.tokenUsage);
  if (!tokenDetails) return escapeHtml(main);
  return `<div class="cell-title usage-cell"><strong>${escapeHtml(main)}</strong>${tokenDetails}</div>`;
}

async function downloadModelAudit(taskId) {
  const url = `/api/admin/model-usage/${encodeURIComponent(taskId)}/audit?accountId=${encodeURIComponent(state.actor.accountId)}`;
  const response = await fetchResponse(url, {
    credentials: 'same-origin',
    headers: { 'accept-language': locale },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || t('modelUsage.auditDownloadFailed', { status: response.status }));
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const filename = disposition.match(/filename="([^"]+)"/i)?.[1]
    || `billing-audit-${taskId}.json`;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
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
    ? `<th>${t('common.billingItem')}</th><th>${t('common.unit')}</th><th>${t('modelUsage.calls')}</th><th>${t('status.succeeded')}</th><th>${t('status.failed')}</th><th>${t('modelUsage.usage')}</th><th>${t('billing.customerAmount')} (${currency})</th>`
      + (state.actor.role === 'SYSTEM_ADMIN' ? `<th>${t('billing.internalCost')} (${currency})</th>` : '')
    : `<th>${t('common.time')}</th><th>${t('common.billingItem')}</th><th>${t('common.resourceGroup')}</th><th>${t('common.subaccount')}</th><th>${t('common.status')}</th><th>${t('modelUsage.usage')}</th><th>${t('billing.customerAmount')} (${currency})</th>`
      + (state.actor.role === 'SYSTEM_ADMIN' ? `<th>${t('billing.internalCost')} (${currency})</th>` : '')
      + `<th>${t('modelUsage.taskAudit')}</th>`;
  $('#model-list').innerHTML = result.items.map(item => summary
    ? `<tr><td>${escapeHtml(item.dimensionName || item.dimensionId || '—')}</td><td>${escapeHtml(item.unit)}</td><td>${escapeHtml(item.callCount)}</td><td>${escapeHtml(item.successCount || 0)}</td><td>${escapeHtml(item.failedCount || 0)}</td><td>${escapeHtml(formatQuantity(item.usageValue, item.unit))}</td><td>${escapeHtml(formatMoney(item.customerAmount))}</td>${state.actor.role === 'SYSTEM_ADMIN' ? `<td>${escapeHtml(formatMoney(item.costAmount))}</td>` : ''}</tr>`
    : `<tr><td>${escapeHtml(formatDateTime(item.createdAt))}</td><td>${escapeHtml(item.billingItemId)}</td><td>${escapeHtml(item.configGroupName)}</td><td>${escapeHtml(item.displayName || item.loginName)}</td><td>${modelStatusCell(item)}</td><td>${usageCell(item)}</td><td>${escapeHtml(formatMoney(item.customerAmount))}</td>${state.actor.role === 'SYSTEM_ADMIN' ? `<td>${escapeHtml(formatMoney(item.costAmount))}</td>` : ''}<td>${item.hasAuditPayload ? `<button class="audit-download" data-task-id="${escapeHtml(item.taskId)}" type="button"><span aria-hidden="true">↓</span>${t('common.download')}</button>` : `<span class="muted">${t('common.none')}</span>`}</td></tr>`).join('');
  const totalPages = Math.max(1, Math.ceil(Number(result.total || 0) / Number(result.pageSize || 50)));
  setText('#model-page', t('pagination.pageOf', { page: result.page, totalPages: totalPages }));
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
    message.textContent = t('auth.signingIn');
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

// Enable submission only after the handler above can prevent native navigation.
$('#login-submit').disabled = false;

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
$('#model-list').addEventListener('click', event => {
  const button = event.target.closest('.audit-download');
  if (!button) return;
  button.disabled = true;
  downloadModelAudit(button.dataset.taskId)
    .catch(error => toast(error.message, true))
    .finally(() => { button.disabled = false; });
});
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
    button.textContent = visible ? t('common.show') : t('common.hide');
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
    button.textContent = visible ? t('common.showPassword') : t('common.hidePassword');
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
  $('#toggle-user-password').textContent = visible ? t('common.show') : t('common.hide');
  $('#toggle-user-password').setAttribute('aria-label', visible ? t('common.passwordShowLabel') : t('common.hidePassword'));
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
  .then(async result => {
    await routeActor(result.user);
    const section = window.location.hash.slice(1);
    if (state.actor?.role !== 'SUBACCOUNT' && Object.hasOwn(sectionTitles, section)) switchSection(section);
  })
  .catch(() => undefined);
