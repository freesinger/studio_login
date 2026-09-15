import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import i18next from 'i18next';
import { describe, expect, it, vi } from 'vitest';

// Execute the browser module with real i18next and controlled resource failures.
const source = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8')
  .replace(/^import .+ from [^;]+;/gm, '')
  .replace(/\bexport /g, '');
const catalogs = Object.fromEntries(['zh-CN', 'en', 'ja'].map(language => [language,
  readFileSync(new URL(`../public/locales/${language}.json`, import.meta.url), 'utf8'),
]));

function start(language: string, failures: Record<string, 'http' | 'network' | 'json' | 'empty' | 'timeout'> = {}) {
  const showError = vi.fn();
  const fetch = vi.fn(async (path: string, options: { signal: AbortSignal }) => {
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const name = path.split('/').at(-1)!.replace('.json', '');
    const failure = failures[name];
    if (failure === 'network') throw new TypeError('Failed to fetch');
    if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    return new Response(failure === 'json' ? '{' : failure === 'empty' ? '{}' : catalogs[name], {
      status: failure === 'http' ? 503 : 200,
    });
  });
  const ready = runInNewContext(`(async () => { ${source}\nreturn { locale, t }; })()`, {
    i18next, URL, AbortSignal, fetch,
    runtimeConfig: { currency: 'CNY', timeZone: 'Asia/Shanghai' },
    window: { location: { href: `https://login.test/?lang=${language}` } },
    localStorage: { getItem: () => null },
    document: {
      querySelectorAll: () => [],
      querySelector: () => ({ classList: { remove: showError } }),
      documentElement: {},
      addEventListener: () => {},
    },
  }) as Promise<{ locale: string; t: (key: string) => string }>;
  return { ready, showError, fetch };
}

describe('browser locale startup', () => {
  it.each(['zh-CN', 'en', 'ja'])('preserves the selected language %s when resources are healthy', async language => {
    const { ready, showError } = start(language);
    const result = await ready;
    expect(result.locale).toBe(language);
    expect(result.t('auth.signIn')).toBe(JSON.parse(catalogs[language]!)['auth.signIn']);
    expect(showError).not.toHaveBeenCalled();
  });

  it.each(['http', 'network', 'json', 'empty', 'timeout'] as const)('starts in English when the Chinese fallback has a %s failure', async failure => {
    const { ready, showError } = start('en', { 'zh-CN': failure });
    const result = await ready;
    expect(result.locale).toBe('en');
    expect(result.t('auth.signIn')).toBe('Sign in');
    expect(showError).not.toHaveBeenCalled();
  });

  it('keeps the existing Chinese fallback for a failed selected language', async () => {
    const result = await start('ja', { ja: 'http' }).ready;
    expect(result.locale).toBe('zh-CN');
    expect(result.t('auth.signIn')).toBe('登录');
  });

  it('can start the default Chinese page using an available alternate language', async () => {
    const result = await start('zh-CN', { 'zh-CN': 'http', en: 'network' }).ready;
    expect(result.locale).toBe('ja');
    expect(result.t('auth.signIn')).toBe('ログイン');
  });

  it('shows a startup error when no language can be loaded', async () => {
    const { ready, showError } = start('en', { 'zh-CN': 'http', en: 'json', ja: 'network' });
    await expect(ready).rejects.toThrow('No locale available');
    expect(showError).toHaveBeenCalledWith('hidden');
  });
});
