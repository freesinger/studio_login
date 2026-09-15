import { readFileSync } from 'node:fs';

import { createInstance } from 'i18next';
import { z, type ZodError } from 'zod';

import type { MessageKey, MessageParameters } from './i18n-types.js';
export type { MessageKey } from './i18n-types.js';
export type Locale = 'zh-CN' | 'en' | 'ja';
export type MessageValue = string | number | LocalizedMessage;
export interface LocalizedMessage {
  key: MessageKey;
  params: Record<string, MessageValue>;
}
type Args<K extends MessageKey> = {} extends MessageParameters[K]
  ? [params?: MessageParameters[K]] : [params: MessageParameters[K]];

const catalogs = Object.fromEntries(['zh-CN', 'en', 'ja'].map(locale => [locale,
  JSON.parse(readFileSync(new URL(`../public/locales/${locale}.json`, import.meta.url), 'utf8')) as Record<MessageKey, string>,
])) as Record<Locale, Record<MessageKey, string>>;
const i18n = createInstance();
await i18n.init({
  lng: 'zh-CN', fallbackLng: 'zh-CN', supportedLngs: ['zh-CN', 'en', 'ja'],
  keySeparator: false, nsSeparator: false, initAsync: false,
  resources: Object.fromEntries(Object.entries(catalogs).map(([locale, translation]) => [locale, { translation }])),
  // Renderers escape HTML at their output boundary; JSON and plain text stay raw.
  interpolation: { escapeValue: false },
});

export function message<K extends MessageKey>(key: K, ...args: Args<K>): LocalizedMessage {
  return { key, params: args[0] ?? {} };
}

export function translate<K extends MessageKey>(key: K, locale: Locale, ...args: Args<K>): string {
  return formatMessage(message(key, ...args), locale);
}

export function formatMessage(value: LocalizedMessage | string, locale: Locale): string {
  if (typeof value === 'string') return value;
  const params = Object.fromEntries(Object.entries(value.params).map(([key, parameter]) => [
    key, typeof parameter === 'object' ? formatMessage(parameter, locale) : parameter,
  ]));
  // Explicit lng per call: concurrent requests never mutate a global language.
  return i18n.t(value.key, { ...params, lng: locale });
}

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(catalogs['zh-CN'], key);
}

export function formatValidationIssues(issues: ZodError['issues'], locale: Locale): ZodError['issues'] {
  const errorMap = (locale === 'ja' ? z.locales.ja() : locale === 'en' ? z.locales.en() : z.locales.zhCN()).localeError;
  return issues.map(issue => {
    if (isMessageKey(issue.message)) return { ...issue, message: formatMessage({ key: issue.message, params: {} }, locale) };
    // A custom validator may supply a third-party message. Preserve it verbatim.
    if (issue.code === 'custom') return issue;
    const result = errorMap(issue as Parameters<typeof errorMap>[0]);
    return { ...issue, message: typeof result === 'string' ? result : result?.message ?? issue.message };
  });
}
export function requestLocale(header: string | undefined): Locale {
  const languages = (header ?? '').split(',').map((part, order) => {
    const [language = '', ...parameters] = part.trim().split(';');
    const quality = parameters.find(value => value.trim().startsWith('q='));
    return { language: language.toLowerCase(), quality: quality ? Number(quality.trim().slice(2)) : 1, order };
  }).filter(item => Number.isFinite(item.quality) && item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.order - b.order);
  for (const { language } of languages) {
    if (/^zh(?:-|$)/.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/.test(language)) return 'en';
    if (/^ja(?:-|$)/.test(language)) return 'ja';
  }
  return 'zh-CN';
}
