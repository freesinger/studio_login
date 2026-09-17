import { runtimeConfig } from './runtime-config.js';
import i18next from '/vendor/i18next.js';

const supported = ['zh-CN', 'en', 'ja'];
const storageKey = 'studio-login.locale';
const url = new URL(window.location.href);
let saved;
try { saved = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
const requested = url.searchParams.get('lang') || saved;
export let locale = supported.includes(requested) ? requested : 'zh-CN';
async function loadCatalog(language) {
  const response = await fetch(`/locales/${language}.json`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Locale unavailable: ${language}`);
  const catalog = await response.json();
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)
      || !Object.keys(catalog).length || Object.values(catalog).some(value => typeof value !== 'string')) {
    throw new Error(`Invalid locale: ${language}`);
  }
  return catalog;
}
// A failed fallback must not prevent a healthy selected language from starting.
const catalogs = Object.fromEntries(await Promise.all([...new Set([locale, 'zh-CN'])].map(async language =>
  [language, await loadCatalog(language).catch(() => null)],
)));
if (!catalogs[locale]) locale = 'zh-CN';
if (!catalogs[locale]) {
  for (const language of supported.filter(language => !(language in catalogs))) {
    catalogs[language] = await loadCatalog(language).catch(() => null);
    if (catalogs[language]) {
      locale = language;
      break;
    }
  }
}
if (!catalogs[locale]) {
  document.querySelector('#login-load-error').classList.remove('hidden');
  throw new Error('No locale available');
}
const instance = i18next.createInstance();
await instance.init({
  lng: locale, fallbackLng: 'zh-CN', supportedLngs: supported,
  keySeparator: false, nsSeparator: false,
  resources: Object.fromEntries(Object.entries(catalogs)
    .filter(([, catalog]) => catalog)
    .map(([language, translation]) => [language, { translation }])),
  interpolation: { escapeValue: false },
});
export function t(key, params = {}) {
  return instance.t(key, params);
}

for (const node of document.querySelectorAll('[data-i18n]')) {
  node.textContent = t(node.dataset.i18n, { currency: runtimeConfig.currency, timeZone: runtimeConfig.timeZone });
}
for (const attribute of ['placeholder', 'title', 'aria-label', 'alt']) {
  for (const node of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
    node.setAttribute(attribute, t(node.getAttribute(`data-i18n-${attribute}`)));
  }
}
for (const node of document.querySelectorAll('[data-currency]')) node.textContent = runtimeConfig.currency;
document.documentElement.lang = locale;

// Switching reloads server-provided messages as well as UI text, while keeping
// the authenticated session. Never store passwords or unsaved form contents.
for (const picker of document.querySelectorAll('.language-select')) {
  picker.value = locale;
  picker.addEventListener('change', () => {
    if (document.querySelector('form[data-dirty="true"]')
        && !window.confirm(t('common.confirmLanguageReload'))) {
      picker.value = locale;
      return;
    }
    const selected = picker.value;
    try { localStorage.setItem(storageKey, selected); } catch { /* URL fallback below. */ }
    const next = new URL(window.location.href);
    next.searchParams.set('lang', selected);
    const section = document.querySelector('.nav-item.active')?.dataset.section;
    if (section) next.hash = section;
    window.location.replace(next);
  });
}

// Native validation messages otherwise follow the browser's language, which
// can differ from the user's explicit selection in this application.
function validateField(field) {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLSelectElement || field instanceof HTMLTextAreaElement)) return;
  field.setCustomValidity('');
  const v = field.validity;
  if (v.valid) return;
  field.setCustomValidity(v.valueMissing ? t('validation.required')
    : v.tooShort ? t('validation.minLength', { minLength: field.minLength })
    : v.typeMismatch && field.type === 'url' ? t('validation.url')
    : v.patternMismatch ? t('validation.format') : t('validation.invalidValue'));
}
document.addEventListener('invalid', event => validateField(event.target), true);
document.addEventListener('input', event => {
  validateField(event.target);
  if (event.target.form) event.target.form.dataset.dirty = 'true';
});
document.addEventListener('change', event => {
  validateField(event.target);
  if (event.target.form) event.target.form.dataset.dirty = 'true';
});
document.addEventListener('reset', event => {
  delete event.target.dataset.dirty;
  for (const field of event.target.elements) field.setCustomValidity?.('');
}, true);
