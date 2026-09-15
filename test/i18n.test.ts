import { readFileSync, readdirSync } from 'node:fs';

import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AppError, profileSyncError, StudioApiError } from '../src/errors.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { importCsvRows } from '../src/csv-import.js';
import type { Database } from '../src/db.js';
import { formatMessage, message, requestLocale } from '../src/i18n.js';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const catalogs = Object.fromEntries(['zh-CN', 'en', 'ja'].map(locale => [locale, JSON.parse(read(`public/locales/${locale}.json`)) as Record<string, string>]));
const placeholders = (value: string) => [...value.matchAll(/\{\{\w+\}\}/g)].map(match => match[0]).sort();

describe('translation coverage', () => {
  it('keeps all three catalogs complete and preserves interpolation parameters', () => {
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(catalogs['zh-CN']!).sort());
      for (const [key, value] of Object.entries(catalog)) {
        expect(key).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);
        expect(value.trim(), key).not.toBe('');
        expect(placeholders(value), key).toEqual(placeholders(catalogs['zh-CN']![key]!));
      }
    }
    for (const value of Object.values(catalogs.en!)) expect(value).not.toMatch(/\p{Script=Han}/u);
  });

  it('covers all frontend calls and rejects untranslated Chinese literals or template text', () => {
    for (const file of ['public/app.js', 'public/i18n.js']) {
      const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && node.expression.getText(ast) === 't') {
          const key = node.arguments[0];
          if (key && ts.isStringLiteral(key)) {
            expect(Object.hasOwn(catalogs.en!, key.text), key.text).toBe(true);
            const expected = [...new Set([...catalogs.en![key.text]!.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))].sort();
            const params = node.arguments[1];
            if (params) expect(ts.isObjectLiteralExpression(params), key.text).toBe(true);
            const actual = params && ts.isObjectLiteralExpression(params)
              ? params.properties.map(property => property.name?.getText(ast)).sort() : [];
            expect(actual, key.text).toEqual(expected);
          }
        }
        if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) && /\p{Script=Han}/u.test(node.text)) {
          expect.fail(`Untranslated literal: ${node.getText(ast)}`);
        }
        node.forEachChild(visit);
      }
      visit(ast);
    }
  });

  it('covers static text and accessibility attributes', () => {
    const html = read('public/index.html');
    for (const [, key] of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
      expect(Object.hasOwn(catalogs.en!, key!), key).toBe(true);
    }
    for (const [, tag, attributes, text] of html.matchAll(/<(\w+)([^>]*?)>([^<>]*\p{Script=Han}[^<>]*)/gu)) {
      if (tag === 'option' && /value="(?:zh-CN|ja)"/.test(attributes!)) continue;
      expect(attributes, text).toContain('data-i18n=');
    }
    for (const [, attribute, value] of html.matchAll(/ (placeholder|title|aria-label)="([^"]*\p{Script=Han}[^"]*)"/gu)) {
      expect(html).toMatch(new RegExp(`data-i18n-${attribute}="[a-zA-Z.]+"`));
    }
    expect(html).toContain('type="module" src="/app.js"');
    // The server-rendered form must be safe before any JavaScript can execute.
    expect(html).toMatch(/<form\b[^>]*id="login-form"[^>]*method="post"[^>]*action="\/api\/auth\/login"/);
    expect(html).toMatch(/<button\b[^>]*id="login-submit"[^>]*\bdisabled[\s>]/);
  });

  it('covers explicit server message keys without a source-text registry', () => {
    for (const file of readdirSync(new URL('../src', import.meta.url)).filter(file => file.endsWith('.ts'))) {
      const ast = ts.createSourceFile(file, read(`src/${file}`), ts.ScriptTarget.Latest, true);
      function visit(node: ts.Node) {
        if ((ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) && /\p{Script=Han}/u.test(node.text)) {
          // A historical database default is business data, not a UI translation key.
          expect(node.text.includes('INSERT INTO studio_registrations') && node.text.includes('默认连接'), `${file}: ${node.text}`).toBe(true);
        }
        if (ts.isCallExpression(node) && ['message', 'translate'].includes(node.expression.getText(ast))) {
          const key = node.arguments[0];
          if (key && ts.isStringLiteral(key)) expect(Object.hasOwn(catalogs.en!, key.text), `${file}: ${key.text}`).toBe(true);
        }
        node.forEachChild(visit);
      }
      visit(ast);
    }
    const generated = read('src/i18n-types.ts');
    for (const key of Object.keys(catalogs['zh-CN']!)) expect(generated).toContain(`'${key}':`);
  });

});

describe('response localization', () => {
  it.each([
    [undefined, 'zh-CN'], ['en-US,en;q=0.8', 'en'], ['ja-JP', 'ja'],
    ['fr, ja;q=0.9, en;q=0.5', 'ja'], ['ja;q=0,en;q=1', 'en'],
    ['en;q=bogus,ja;q=0.5', 'ja'], ['de', 'zh-CN'], ['zh-TW', 'zh-CN'],
  ])('negotiates %s as %s', (header, expected) => expect(requestLocale(header)).toBe(expected));

  it('only translates explicit messages and preserves user names and upstream prose', () => {
    const error = new StudioApiError(message('studio.httpError', { status: 503 }), 'UPSTREAM', 'request-123');
    expect(error.localize('en')).toBe('Studio API call failed: HTTP 503');
    expect(profileSyncError(error)).toMatchObject({ code: 'UPSTREAM', requestId: 'request-123' });
    expect(formatMessage(message('common.editNamed', { name: '配置组' }), 'en')).toContain('配置组');
    expect(formatMessage(message('quota.monthlyLimitExceeded', { subject: message('common.resourceGroup') }), 'ja')).toBe('設定グループの月間利用枠が不足しています');
    expect(new AppError('上游自定义错误').localize('en')).toBe('上游自定义错误');
  });

  it('keeps persisted sync diagnostics in their original text without locale metadata', () => {
    const error = new StudioApiError(message('studio.httpError', { status: 503 }), 'UPSTREAM', 'request-123');
    expect(error.localize('en')).toBe('Studio API call failed: HTTP 503');
    expect(profileSyncError(error)).toEqual({ code: 'UPSTREAM', message: 'Studio API 调用失败: HTTP 503', requestId: 'request-123' });
  });

  it('translates CSV row validation without changing row numbers or field paths', async () => {
    const result = await importCsvRows([{ loginName: '' }], async row => {
      z.object({ loginName: z.string().min(3) }).parse(row);
      return 'ok';
    }, 'ja');
    expect(result.items[0]?.row).toBe(2);
    expect(result.items[0]?.message).toContain('loginName:');
    expect(result.items[0]?.message).not.toContain('Too small');
    expect(result.items[0]?.message).toMatch(/[ぁ-んァ-ン]/);
  });
});

const config = loadConfig({
  STUDIO_LOGIN_LOG_LEVEL: 'silent',
  STUDIO_LOGIN_DATABASE_URL: 'mysql://root@127.0.0.1:3307/unused_i18n_test',
  STUDIO_LOGIN_ACCOUNT_ID: 'studio', STUDIO_LOGIN_ADMIN_USERNAME: 'admin',
  STUDIO_LOGIN_ADMIN_PASSWORD: 'test-password-123',
  LAS_STUDIO_INTEGRATION_TOKEN: 'test-integration-token-01234567890123',
});
// These routes reject before needing a database; no development data is touched.
const app = await buildApp({ config, database: {} as Database });
afterAll(() => app.close());

describe('HTTP language contract', () => {
  it.each(['zh-CN', 'en', 'ja'])('localizes authentication and validation responses in %s', async locale => {
    const auth = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'accept-language': locale } });
    expect(auth.statusCode).toBe(401);
    expect(auth.json().code).toBe('UNAUTHORIZED');
    expect(auth.json().messageKey).toBe('auth.unauthorized');
    expect(auth.json().message).toBe(catalogs[locale]!['auth.unauthorized']);
    expect(auth.headers['content-language']).toBe(locale);
    expect(auth.headers.vary).toContain('Accept-Language');
    const validation = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'accept-language': locale }, payload: {} });
    expect(validation.statusCode).toBe(400);
    expect(validation.json().message).toBe(catalogs[locale]!['errors.invalidParameters']);
    if (locale === 'ja') expect(validation.json().details[0].message).toMatch(/[ぁ-んァ-ン]/);
  });

  it('serves the installed i18next browser module locally', async () => {
    const asset = await app.inject({ url: '/vendor/i18next.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    expect(asset.body).toContain('export');
  });

  it('does not leak request language across simultaneous requests', async () => {
    const results = await Promise.all(['en', 'ja', 'zh-CN', 'ja', 'en'].map(async locale => {
      const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { 'accept-language': locale } });
      return [response.json().message, catalogs[locale]!['auth.unauthorized']];
    }));
    for (const [actual, expected] of results) expect(actual).toBe(expected);
  });
});

// Compile-time contract checks: misspelled keys and missing/incorrect parameter names must fail.
if (false) {
  // @ts-expect-error unknown semantic key
  message('unknown.key');
  // @ts-expect-error required status omitted
  message('studio.httpError');
  // @ts-expect-error positional or incorrect parameter names are unsupported
  message('studio.httpError', { code: 503 });
}
