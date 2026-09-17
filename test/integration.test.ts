import { createServer, type Server } from 'node:http';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { BillingReconciler } from '../src/billing-reconcile.js';
import { BillingService } from '../src/billing.js';
import { bootstrapApplication } from '../src/bootstrap.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createDatabase, type Database } from '../src/db.js';
import { currentBillingPeriod } from '../src/quota.js';
import { encryptJson } from '../src/security.js';
import { StudioAdminClient } from '../src/studio-client.js';
import { StudioConnectionService } from '../src/studio-connections.js';

const testUrl = process.env.STUDIO_LOGIN_TEST_DATABASE_URL;
if (!testUrl) throw new Error('集成测试必须配置 STUDIO_LOGIN_TEST_DATABASE_URL');

let app: FastifyInstance;
let database: Database;
let studioServer: Server;
let studioBase: string;
let secondStudioBase: string;
let config: AppConfig;
const studioCalls: string[] = [];
const studioUsageEndpointBodies: unknown[] = [];
const studioRequestBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
let studioIntegrationHeaderSeen = false;
let studioUsagePayload: unknown = { Requests: [], TotalCount: 0 };
const integrationToken = 'integration-test-token-0123456789';

function cookieFrom(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : String(raw ?? '');
  return value.split(';')[0] ?? '';
}

async function captchaFields(): Promise<{ captchaToken: string; captchaCode: string }> {
  const response = await app.inject({ url: '/api/auth/captcha' });
  expect(response.statusCode).toBe(200);
  expect(response.json().image).toMatch(/^data:image\/png;base64,/);
  return { captchaToken: response.json().captchaToken, captchaCode: 'ABCDE' };
}

async function login(accountId: string, loginName: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { accountId, loginName, password, ...await captchaFields() },
  });
  expect(response.statusCode).toBe(200);
  return cookieFrom(response.headers);
}

async function configureStudio(cookie: string) {
  return app.inject({
    method: 'PUT',
    url: '/api/admin/studio/config',
    headers: { cookie },
    payload: {
      accountId: 'acc_demo',
      studioBaseUrl: studioBase,
      callbackBaseUrl: 'http://studio-login.test',
    },
  });
}

beforeAll(async () => {
  studioServer = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      const requestUrl = (request.url ?? '').replace(/^\/second(?=\/)/, '');
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const requestBody = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {};
      studioCalls.push(requestUrl);
      studioRequestBodies.push({ path: requestUrl, body: requestBody });
      studioIntegrationHeaderSeen ||= request.headers['x-las-integration-token'] === integrationToken;
      if (requestUrl === '/integration/api/v1/usage-endpoints/register') {
        studioUsageEndpointBodies.push(requestBody);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(requestUrl === '/api/v1/open/usage/get'
        ? studioUsagePayload
        : requestUrl === '/integration/api/v1/deployment-profile/get'
          ? {
              code: 200,
              message: 'success',
              data: {
                region: 'cn-beijing',
                tosRegion: 'cn-beijing',
                requiredResourceFields: ['lasApiKey', 'arkApiKey', 'tosBucketName'],
              },
            }
          : requestUrl === '/integration/api/v1/billing-catalog/get'
            ? {
                code: 200,
                message: 'success',
                data: {
                  items: [
                    {
                      billingItemId: 'video-second', unit: 'second',
                      operatorIds: ['video'],
                    },
                    {
                      billingItemId: 'image', unit: 'count',
                      operatorIds: ['image'],
                    },
                  ],
                },
              }
          : { code: 200, message: 'success', data: {} }));
    });
  });
  await new Promise<void>(resolve => studioServer.listen(0, '127.0.0.1', resolve));
  const address = studioServer.address();
  if (!address || typeof address === 'string') throw new Error('mock Studio 启动失败');
  studioBase = `http://127.0.0.1:${address.port}`;
  secondStudioBase = `${studioBase}/second`;
  config = loadConfig({
    APP_ENV: 'test',
    STUDIO_LOGIN_DATABASE_URL: testUrl,
    STUDIO_LOGIN_ACCOUNT_ID: 'acc_demo',
    STUDIO_LOGIN_ADMIN_USERNAME: 'root',
    STUDIO_LOGIN_ADMIN_PASSWORD: 'StrongPass123!',
    LAS_STUDIO_INTEGRATION_TOKEN: integrationToken,
  });
  database = createDatabase(config);
  app = await buildApp({ config, database, captchaAnswerFactory: () => 'ABCDE' });
});

beforeEach(async () => {
  studioCalls.length = 0;
  studioUsageEndpointBodies.length = 0;
  studioRequestBodies.length = 0;
  studioIntegrationHeaderSeen = false;
  studioUsagePayload = { Requests: [], TotalCount: 0 };
  await database.execute('SET FOREIGN_KEY_CHECKS = 0');
  for (const table of [
    'period_usage',
    'studio_task_items',
    'studio_tasks',
    'operator_prices',
    'studio_login_tickets',
    'studio_registrations',
    'config_group_versions',
    'config_groups',
    'sessions',
    'users',
    'accounts',
    'api_rate_limits',
  ]) {
    await database.execute(`TRUNCATE TABLE ${table}`);
  }
  await database.execute('UPDATE system_state SET initialized = FALSE WHERE id = 1');
  await database.execute('SET FOREIGN_KEY_CHECKS = 1');
  await bootstrapApplication(database, config);
});

afterAll(async () => {
  await app.close();
  await database.close();
  await new Promise<void>((resolve, reject) => studioServer.close(error => error ? reject(error) : resolve()));
});

describe('studio-login MVP', () => {
  it('requires a fresh one-use captcha before checking the password', async () => {
    const credentials = { accountId: 'acc_demo', loginName: 'root', password: 'StrongPass123!' };
    const missing = await app.inject({ method: 'POST', url: '/api/auth/login', payload: credentials });
    expect(missing.statusCode).toBe(400);

    const first = await captchaFields();
    const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      ...credentials, ...first, captchaCode: 'ZZZZZ',
    } });
    expect(wrong.json().code).toBe('INVALID_CAPTCHA');
    const replay = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      ...credentials, ...first,
    } });
    expect(replay.json().code).toBe('INVALID_CAPTCHA');

    const expired = await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      ...credentials,
      captchaToken: encryptJson({ id: 'expired', answer: 'ABCDE', expiresAt: Date.now() - 1 }, config.encryptionKey),
      captchaCode: 'ABCDE',
    } });
    expect(expired.json().code).toBe('INVALID_CAPTCHA');

    const valid = await captchaFields();
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      ...credentials, ...valid,
    } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: {
      ...credentials, ...valid,
    } })).json().code).toBe('INVALID_CAPTCHA');
  });

  it('rejects weak passwords in create, update, and CSV import', async () => {
    const adminCookie = await login('acc_demo', 'root', 'StrongPass123!');
    const headers = { cookie: adminCookie };
    const create = await app.inject({ method: 'POST', url: '/api/admin/subaccounts', headers, payload: {
      accountId: 'acc_demo', loginName: 'worker', displayName: 'Worker', password: 'weakpassword1!', monthlyLimit: null,
    } });
    expect(create.statusCode).toBe(400);
    expect(create.json().details[0].message).toContain('大写字母');
    const update = await app.inject({ method: 'PATCH', url: '/api/admin/subaccounts/unknown', headers, payload: {
      accountId: 'acc_demo', displayName: 'Worker', password: 'weakpassword1!', monthlyLimit: null,
    } });
    expect(update.statusCode).toBe(400);
    const csv = await app.inject({ method: 'POST', url: '/api/admin/subaccounts/import', headers, payload: {
      accountId: 'acc_demo',
      csv: 'loginName,displayName,password,configGroup,monthlyLimit\nworker,Worker,weakpassword1!,default,100\n',
    } });
    expect(csv.json()).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
  });

  it('keeps Date round trips, database clocks and session expiry consistent', async () => {
    await database.transaction(async tx => {
      await tx.execute('CREATE TEMPORARY TABLE clock_probe (created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), bound_at DATETIME(3))');
      try {
        const instant = new Date();
        await tx.execute('INSERT INTO clock_probe (bound_at) VALUES (?)', [instant]);
        const row = (await tx.query<any>('SELECT created_at, bound_at, TIMESTAMPDIFF(SECOND, bound_at, CURRENT_TIMESTAMP(3)) AS elapsed, @@session.time_zone AS zone FROM clock_probe'))[0];
        expect(row.zone).toBe('+08:00');
        expect(row.bound_at.toISOString()).toBe(instant.toISOString());
        expect(Math.abs(row.created_at.getTime() - instant.getTime())).toBeLessThan(2000);
        expect(Math.abs(Number(row.elapsed))).toBeLessThan(2);
      } finally { await tx.execute('DROP TEMPORARY TABLE clock_probe'); }
    });
    const cookie = await login('acc_demo', 'root', 'StrongPass123!');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await database.execute('UPDATE sessions SET expires_at = ?', [new Date(Date.now() - 1000)]);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it.each(['CNY', 'USD'] as const)('keeps %s defaults, overrides, snapshots and callback periods consistent', async currency => {
    const defaultPrices = { customerUnitPrice: '1', costUnitPrice: '0.5' };
    const deployment = { ...config, STUDIO_LOGIN_CURRENCY: currency, timeZone: 'America/Los_Angeles', defaultPrices };
    const variant = await buildApp({ config: deployment, database });
    try {
      const cookie = await login('acc_demo', 'root', 'StrongPass123!');
      expect((await configureStudio(cookie)).statusCode).toBe(200);
      const group = await app.inject({ method: 'POST', url: '/api/admin/config-groups', headers: { cookie }, payload: {
        accountId: 'acc_demo', name: 'Money test', monthlyLimit: '1000', isDefault: true,
        resourceConfig: { lasApiKey: 'test-las', arkApiKey: 'test-ark', tosBucketName: 'test-bucket' },
      } });
      expect(group.statusCode, group.body).toBe(200);
      const configGroupId = group.json().configGroupId;
      const user = await app.inject({ method: 'POST', url: '/api/admin/subaccounts', headers: { cookie }, payload: {
        accountId: 'acc_demo', loginName: 'money-worker', displayName: 'Money worker', password: 'StrongPass123!', configGroupId, monthlyLimit: '100',
      } });
      expect(user.statusCode, user.body).toBe(200);
      const userCookie = await login('acc_demo', 'money-worker', 'StrongPass123!');
      const launchTicket = async () => {
        const response = await variant.inject({ method: 'POST', url: '/api/studio/tickets/launch', headers: { cookie: userCookie } });
        expect(response.statusCode, response.body).toBe(200);
        return new URL(response.json().launchUrl).searchParams.get('ticket');
      };
      const verifyTicket = (ticket: string | null) => variant.inject({ method: 'POST', url: '/api/internal/studio/tickets/verify?app_id=acc_demo&connection_id=acc_demo', payload: { bllFields: { ticket } } });
      const liveTicket = await launchTicket();
      expect((await verifyTicket(liveTicket)).statusCode).toBe(200);
      expect((await verifyTicket(liveTicket)).statusCode).toBe(401);
      const expiredTicket = await launchTicket();
      await database.execute('UPDATE studio_login_tickets SET expires_at = ?', [new Date(Date.now() - 1000)]);
      expect((await verifyTicket(expiredTicket)).statusCode).toBe(401);

      const list = await variant.inject({ url: '/api/admin/prices?accountId=acc_demo&scopeType=PLATFORM&scopeId=*', headers: { cookie } });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items.find((item: any) => item.billingItemId === 'image')).toMatchObject(defaultPrices);
      const csv = await variant.inject({ url: '/api/admin/prices/import-template?accountId=acc_demo', headers: { cookie } });
      expect(csv.body).toContain(`image,count,${defaultPrices.customerUnitPrice},${defaultPrices.costUnitPrice}`);
      const headers = { 'x-app-id': 'acc_demo', 'x-las-api-key': 'test-las' };
      const precheck = (requestId: string) => variant.inject({ method: 'POST', url: '/api/studio/baseline/tasks?connection_id=acc_demo', headers, payload: {
        RequestId: requestId, UserId: 'money-worker', Items: [{ BillingItemId: 'image', Unit: 'count', Usage: 2 }],
      } });
      expect((await precheck('default-price')).statusCode).toBe(200);
      const stored = (await database.query<any>("SELECT billing_period FROM studio_tasks WHERE request_id = 'default-price'"))[0];
      expect(stored.billing_period).toBe(currentBillingPeriod(new Date(), deployment.timeZone));
      const savePrice = (scopeType: string, scopeId: string, price: string) => variant.inject({ method: 'POST', url: '/api/admin/prices', headers: { cookie }, payload: {
        accountId: 'acc_demo', scopeType, scopeId, billingItemId: 'image', unit: 'count', customerUnitPrice: price, costUnitPrice: '0', enabled: true,
      } });
      expect((await savePrice('PLATFORM', '*', '0.25')).statusCode).toBe(200);
      // A callback must settle the original month, even after the current month/price changes.
      await database.execute("UPDATE studio_tasks SET billing_period = '2020-01' WHERE request_id = 'default-price'");
      await database.execute("UPDATE period_usage SET billing_period = '2020-01'");
      const callback = await variant.inject({ method: 'POST', url: '/api/studio/baseline/tasks/callback?connection_id=acc_demo', headers, payload: {
        RequestId: 'default-price', UserId: 'money-worker', Status: 'SUCCEEDED', Items: [{ BillingItemId: 'image', Unit: 'count', Usage: 3 }],
      } });
      expect(callback.statusCode, callback.body).toBe(200);
      const settled = (await database.query<any>("SELECT actual_amount, actual_cost FROM studio_tasks WHERE request_id = 'default-price'"))[0];
      expect(Number(settled.actual_amount)).toBe(Number(defaultPrices.customerUnitPrice) * 3);
      expect(Number(settled.actual_cost)).toBe(Number(defaultPrices.costUnitPrice) * 3);
      const usage = await database.query<any>("SELECT billing_period, actual_amount, reserved_amount FROM period_usage");
      expect(usage.length).toBeGreaterThan(0);
      for (const row of usage) {
        expect(row.billing_period).toBe('2020-01');
        expect(Number(row.actual_amount)).toBe(Number(defaultPrices.customerUnitPrice) * 3);
        expect(Number(row.reserved_amount)).toBe(0);
      }
      expect((await precheck('platform-price')).statusCode).toBe(200);
      expect((await savePrice('CONFIG_GROUP', configGroupId, '0.375')).statusCode).toBe(200);
      expect((await precheck('group-price')).statusCode).toBe(200);
      const snapshots = await database.query<any>('SELECT t.request_id, i.customer_unit_price FROM studio_task_items i JOIN studio_tasks t ON t.task_id = i.task_id');
      expect(Object.fromEntries(snapshots.map(row => [row.request_id, Number(row.customer_unit_price)]))).toEqual({
        'default-price': Number(defaultPrices.customerUnitPrice), 'platform-price': 0.25, 'group-price': 0.375,
      });
      const reconciler = new BillingReconciler(database, new StudioConnectionService(database, deployment, new StudioAdminClient()), new BillingService(database, deployment));
      await database.execute("UPDATE studio_tasks SET created_at = ?, next_reconcile_at = ? WHERE status = 'RUNNING'", [new Date(Date.now() - 20 * 60_000), new Date(Date.now() + 60_000)]);
      expect((await reconciler.reconcile({ olderThanMinutes: 10, limit: 10 })).scanned).toBe(0);
      await database.execute("UPDATE studio_tasks SET next_reconcile_at = ? WHERE request_id = 'platform-price'", [new Date(Date.now() - 1000)]);
      expect((await reconciler.reconcile({ olderThanMinutes: 10, limit: 10 })).scanned).toBe(1);
      const retried = (await database.query<any>("SELECT last_reconcile_at, next_reconcile_at, reconcile_attempts FROM studio_tasks WHERE request_id = 'platform-price'"))[0];
      expect(Math.abs(retried.last_reconcile_at.getTime() - Date.now())).toBeLessThan(3000);
      expect(retried.next_reconcile_at.getTime()).toBeGreaterThan(Date.now());
      expect(retried.reconcile_attempts).toBe(1);
      // The same instant belongs to different calendar days in Shanghai and LA.
      await database.execute("UPDATE studio_tasks SET created_at = ?", [new Date('2026-09-01T06:59:59Z')]);
      await database.execute("UPDATE studio_tasks SET created_at = ? WHERE request_id = 'group-price'", [new Date('2026-09-01T07:00:00Z')]);
      const usageResponse = await variant.inject({ url: '/api/admin/model-usage?accountId=acc_demo&startDate=2026-09-01&endDate=2026-09-01&mode=detail&groupBy=model&page=1&pageSize=50', headers: { cookie } });
      expect(usageResponse.statusCode, usageResponse.body).toBe(200);
      expect(usageResponse.json().items.map((item: any) => item.requestId)).toEqual(['group-price']);
      expect(usageResponse.json().items[0].createdAt).toBe('2026-09-01T07:00:00.000Z');
    } finally { await variant.close(); }
  });

  it('页面提供登录、管理工作台和运行时连接配置入口', async () => {
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('企业概览');
    expect(page.body).toContain('资源配置组');
    expect(page.body).toContain('企业子账号');
    expect(page.body).toContain('Studio 服务连接');
    expect(page.body).toContain('保存并注册');
    expect(page.body).toContain('完整资源配置');
    expect(page.body).toContain('图形验证码');
    expect(page.body).toContain('至少 12 位');
    expect(page.body).not.toContain('首次使用');
    expect(page.body).toContain('配置组名称');
    expect(page.body).not.toContain('企业管理员注册');
    expect(page.body).not.toContain('企业标识');
    expect((await app.inject({ method: 'POST', url: '/api/public/register', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({
      method: 'PUT',
      url: '/api/admin/studio/config',
      payload: {
        accountId: 'acc_demo',
        studioBaseUrl: studioBase,
        callbackBaseUrl: 'http://studio-login.test',
      },
    })).statusCode).toBe(401);
  });

  it('按客户端 IP 限制验证码获取和登录请求', async () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await app.inject({ url: '/api/auth/captcha' });
      expect(response.statusCode).toBe(200);
    }
    expect((await app.inject({ url: '/api/auth/captcha' })).statusCode).toBe(429);

    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await app.inject({
        method: 'POST', url: '/api/auth/login', payload: {},
      });
      expect(response.statusCode).toBe(400);
    }
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login', payload: {},
    })).statusCode).toBe(429);
  });

  it('无公网地址时正常启动，并由 SYSTEM_ADMIN 在运行时完成 Studio 注册', async () => {
    expect(studioCalls).toEqual([]);
    await bootstrapApplication(database, config);
    const loginResponse = await app.inject({
      method: 'POST', url: '/api/auth/login',
      headers: { 'x-forwarded-proto': 'https' },
      payload: { loginName: 'root', password: 'StrongPass123!', ...await captchaFields() },
    });
    expect(loginResponse.statusCode).toBe(200);
    expect(String(loginResponse.headers['set-cookie'])).toContain('Secure');
    const productionApp = await buildApp({
      config: { ...config, APP_ENV: 'production' }, database, captchaAnswerFactory: () => 'ABCDE',
    });
    try {
      const captchaResponse = await productionApp.inject({ url: '/api/auth/captcha' });
      const productionLogin = await productionApp.inject({
        method: 'POST', url: '/api/auth/login',
        payload: {
          loginName: 'root', password: 'StrongPass123!',
          captchaToken: captchaResponse.json().captchaToken, captchaCode: 'ABCDE',
        },
      });
      expect(productionLogin.statusCode).toBe(200);
      expect(String(productionLogin.headers['set-cookie'])).toContain('Secure');
    } finally { await productionApp.close(); }
    const adminCookie = cookieFrom(loginResponse.headers);
    const systemAdmin = await app.inject({
      method: 'GET', url: '/api/auth/me', headers: { cookie: adminCookie },
    });
    expect(systemAdmin.json().user.role).toBe('SYSTEM_ADMIN');
    const beforeConfiguration = await app.inject({
      method: 'GET', url: '/api/admin/studio/status?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(beforeConfiguration.statusCode).toBe(200);
    expect(beforeConfiguration.json().connection).toBeNull();
    const configured = await configureStudio(adminCookie);
    expect(configured.statusCode).toBe(200);
    expect(configured.json().connection.status).toBe('READY');
    expect(configured.json().connection.region).toBe('cn-beijing');
    expect(configured.body).not.toContain(integrationToken);
    expect(studioCalls).toContain('/integration/api/v1/app-ticket-configs/register');
    expect(studioCalls).not.toContain('/integration/api/v1/usage-endpoints/register');
    expect(studioIntegrationHeaderSeen).toBe(true);
    const adminLaunch = await app.inject({
      method: 'POST', url: '/api/studio/tickets/launch', headers: { cookie: adminCookie },
    });
    expect(adminLaunch.statusCode).toBe(403);
    expect(adminLaunch.json().code).toBe('STUDIO_CREATOR_ACCOUNT_REQUIRED');
    const connection = await app.inject({
      method: 'GET', url: '/api/admin/studio/status?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(connection.statusCode).toBe(200);
    expect(connection.json().connection.status).toBe('READY');
    expect(connection.body).not.toContain(integrationToken);
    studioCalls.length = 0;
    const retried = await app.inject({
      method: 'POST',
      url: `/api/admin/studio/connections/${connection.json().connection.connectionId}/retry-register`,
      headers: { cookie: adminCookie },
      payload: { accountId: 'acc_demo' },
    });
    expect(retried.statusCode).toBe(200);
    expect(studioCalls).toContain('/integration/api/v1/app-ticket-configs/register');
  });

  it('完成 Studio 注册、配置同步、Ticket 和后付费闭环', async () => {
    const adminCookie = await login('acc_demo', 'root', 'StrongPass123!');
    expect((await configureStudio(adminCookie)).statusCode).toBe(200);

    const groupResponse = await app.inject({
      method: 'POST',
      url: '/api/admin/config-groups',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        name: 'default',
        monthlyLimit: '1000',
        isDefault: true,
        projectLevelSharing: true,
        resourceConfig: {
          lasBaseUrl: 'https://las.example.com',
          lasApiKey: 'las-secret',
          arkApiKey: 'ark-secret',
          tosAccessKey: 'tos-access-secret',
          tosSecretKey: 'tos-secret',
          tosBucketName: 'studio-login-test',
          tosUploadPrefix: 'uploads/',
          tosEndpoint: 'https://tos.example.com',
          outputTosPath: 'tos://studio-login-test/output/',
          customModels: [{ name: 'custom-model', type: 'IMAGE' }],
        },
      },
    });
    expect(groupResponse.statusCode).toBe(200);
    expect(studioRequestBodies).toContainEqual({
      path: '/integration/api/v1/user-profiles/upsert',
      body: expect.objectContaining({
        appId: 'acc_demo',
        projectId: 'acc_demo',
        projectLevelSharing: true,
      }),
    });
    expect(studioUsageEndpointBodies).toContainEqual(expect.objectContaining({
      appId: 'acc_demo',
      estimateUrl: 'http://studio-login.test/api/studio/baseline/tasks?connection_id=acc_demo',
      actualUrl: 'http://studio-login.test/api/studio/baseline/tasks/callback?connection_id=acc_demo',
      lasApiKey: 'las-secret',
    }));
    expect(JSON.stringify(studioUsageEndpointBodies)).not.toContain(integrationToken);
    const configGroupId = groupResponse.json().configGroupId as string;
    const groupList = await app.inject({
      method: 'GET',
      url: '/api/admin/config-groups?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(groupList.statusCode).toBe(200);
    expect(groupList.body).toContain('las-secret');
    expect(groupList.body).toContain('ark-secret');
    expect(groupList.json().items[0].projectLevelSharing).toBe(true);

    const publish = await app.inject({
      method: 'POST',
      url: `/api/admin/config-groups/${configGroupId}/publish`,
      headers: { cookie: adminCookie },
      payload: { accountId: 'acc_demo' },
    });
    expect(publish.statusCode).toBe(200);

    const nextVersion = await app.inject({
      method: 'PUT',
      url: `/api/admin/config-groups/${configGroupId}`,
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        name: 'default-updated',
        resourceConfig: { arkApiKey: 'ark-secret-next' },
        monthlyLimit: '1200',
        projectLevelSharing: true,
      },
    });
    expect(nextVersion.statusCode).toBe(200);
    const mergedGroupList = await app.inject({
      method: 'GET',
      url: '/api/admin/config-groups?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(mergedGroupList.body).toContain('cn-beijing');
    expect(mergedGroupList.body).toContain('acc_demo');
    expect(mergedGroupList.body).toContain('las-secret');
    expect(mergedGroupList.body).toContain('ark-secret-next');
    expect(mergedGroupList.json().items[0].projectLevelSharing).toBe(true);

    const disabledSharing = await app.inject({
      method: 'PUT',
      url: `/api/admin/config-groups/${configGroupId}`,
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        resourceConfig: {},
        monthlyLimit: '1200',
        projectLevelSharing: false,
      },
    });
    expect(disabledSharing.statusCode).toBe(409);
    expect(disabledSharing.json()).toMatchObject({
      code: 'PROJECT_LEVEL_SHARING_IMMUTABLE',
      message: '数据共享开启后不能关闭，以避免已有资源归属发生变化',
    });

    studioRequestBodies.length = 0;
    const subaccount = await app.inject({
      method: 'POST',
      url: '/api/admin/subaccounts',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        loginName: 'worker',
        displayName: 'Worker',
        password: 'StrongPass123!',
        configGroupId,
        monthlyLimit: '100',
      },
    });
    expect(subaccount.statusCode).toBe(200);
    const subaccountId = subaccount.json().userId as string;
    const workerProfileRequests = studioRequestBodies.filter(request =>
      request.path === '/integration/api/v1/user-profiles/upsert'
      && request.body.userId === 'worker');
    expect(workerProfileRequests).toHaveLength(1);
    expect(workerProfileRequests[0]?.body).toMatchObject({
      appId: 'acc_demo',
      projectId: 'acc_demo',
      userId: 'worker',
      projectLevelSharing: true,
    });
    expect(studioRequestBodies.filter(request =>
      request.path === '/integration/api/v1/user-profiles/upsert'
      && !request.body.userId)).toHaveLength(0);

    const users = await app.inject({
      method: 'GET',
      url: '/api/admin/subaccounts?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(users.statusCode).toBe(200);
    expect(users.json().items[0]).toMatchObject({
      userId: subaccountId,
      loginName: 'worker',
      status: 'ACTIVE',
      configGroupId,
    });
    expect(users.body).toContain('StrongPass123!');

    studioRequestBodies.length = 0;
    const updatedUser = await app.inject({
      method: 'PATCH',
      url: `/api/admin/subaccounts/${subaccountId}`,
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        displayName: 'Worker Updated',
        password: 'StrongPass456!',
        configGroupId,
        monthlyLimit: '90',
      },
    });
    expect(updatedUser.statusCode).toBe(200);
    expect(studioRequestBodies.filter(request =>
      request.path === '/integration/api/v1/user-profiles/upsert')).toHaveLength(0);
    const usersAfterPasswordUpdate = await app.inject({
      method: 'GET',
      url: '/api/admin/subaccounts?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(usersAfterPasswordUpdate.body).toContain('StrongPass456!');
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { accountId: 'acc_demo', loginName: 'worker', password: 'StrongPass123!', ...await captchaFields() },
    })).statusCode).toBe(401);

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/api/admin/subaccounts/${subaccountId}/status`,
      headers: { cookie: adminCookie },
      payload: { accountId: 'acc_demo', status: 'DISABLED' },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { accountId: 'acc_demo', loginName: 'worker', password: 'StrongPass456!', ...await captchaFields() },
    })).statusCode).toBe(403);
    expect((await app.inject({
      method: 'PATCH',
      url: `/api/admin/subaccounts/${subaccountId}/status`,
      headers: { cookie: adminCookie },
      payload: { accountId: 'acc_demo', status: 'ACTIVE' },
    })).statusCode).toBe(200);

    const price = await app.inject({
      method: 'POST',
      url: '/api/admin/prices',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        scopeType: 'CONFIG_GROUP',
        scopeId: configGroupId,
        billingItemId: 'video-second',
        unit: 'second',
        customerUnitPrice: '2',
        costUnitPrice: '1',
      },
    });
    expect(price.statusCode).toBe(200);
    const prices = await app.inject({
      method: 'GET',
      url: `/api/admin/prices?accountId=acc_demo&scopeType=CONFIG_GROUP&scopeId=${configGroupId}`,
      headers: { cookie: adminCookie },
    });
    expect(prices.statusCode).toBe(200);
    expect(prices.json().items.find((item: { billingItemId: string }) =>
      item.billingItemId === 'video-second')).toMatchObject({
      scopeType: 'CONFIG_GROUP',
      scopeId: configGroupId,
      scopeName: 'acc_demo',
      billingItemId: 'video-second',
      customerUnitPrice: '2.0000000000',
      costUnitPrice: '1.0000000000',
    });

    const subaccountTemplate = await app.inject({
      method: 'GET',
      url: '/api/admin/subaccounts/import-template?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(subaccountTemplate.statusCode).toBe(200);
    expect(subaccountTemplate.body).toContain('loginName,displayName,password,configGroup,monthlyLimit');
    const subaccountImport = await app.inject({
      method: 'POST',
      url: '/api/admin/subaccounts/import',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        csv: 'loginName,displayName,password,configGroup,monthlyLimit\nworker2,Worker 2,StrongPass789!,acc_demo,80\n',
      },
    });
    expect(subaccountImport.statusCode).toBe(200);
    expect(subaccountImport.json()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });

    studioRequestBodies.length = 0;
    const synchronizedGroup = await app.inject({
      method: 'PUT',
      url: `/api/admin/config-groups/${configGroupId}`,
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        resourceConfig: {
          lasApiKey: 'las-secret-next',
          arkApiKey: 'ark-secret-final',
          tosBucketName: 'studio-login-test-next',
        },
        monthlyLimit: '1200',
      },
    });
    expect(synchronizedGroup.statusCode).toBe(200);
    expect(synchronizedGroup.json()).toMatchObject({ synced: 2, failed: 0 });
    const synchronizedProfiles = studioRequestBodies
      .filter(request => request.path === '/integration/api/v1/user-profiles/upsert'
        && request.body.userId);
    expect(synchronizedProfiles).toHaveLength(2);
    expect(synchronizedProfiles.map(request => request.body.userId).sort())
      .toEqual(['worker', 'worker2']);
    synchronizedProfiles.forEach(request => expect(request.body).toMatchObject({
      lasApiKey: 'las-secret-next',
      arkApiKey: 'ark-secret-final',
      tosBucketName: 'studio-login-test-next',
      projectLevelSharing: true,
    }));
    expect(studioRequestBodies.filter(request =>
      request.path === '/integration/api/v1/user-profiles/upsert'
      && !request.body.userId)).toHaveLength(1);

    const priceImport = await app.inject({
      method: 'POST',
      url: '/api/admin/prices/import',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        scopeType: 'CONFIG_GROUP',
        scopeId: configGroupId,
        csv: 'billingItemId,unit,customerUnitPrice,costUnitPrice\nimage,count,3,1.5\n',
      },
    });
    expect(priceImport.statusCode).toBe(200);
    expect(priceImport.json()).toMatchObject({ total: 1, succeeded: 1, failed: 0 });

    const userCookie = await login('acc_demo', 'worker', 'StrongPass456!');
    const launch = await app.inject({
      method: 'POST',
      url: '/api/studio/tickets/launch',
      headers: { cookie: userCookie },
    });
    expect(launch.statusCode).toBe(200);
    const launchUrl = new URL(launch.json().launchUrl as string);
    expect(launchUrl.origin).toBe(studioBase);
    expect(launchUrl.pathname).toBe('/');
    const ticket = launchUrl.searchParams.get('ticket');
    expect(ticket).toBeTruthy();

    const verify = await app.inject({
      method: 'POST',
      url: '/api/internal/studio/tickets/verify?app_id=acc_demo&connection_id=acc_demo',
      payload: { bllFields: { ticket } },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().data.LoginUserObject.t_b001_user_id).toBe('worker');
    expect(verify.json().data.userId).toBe('worker');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/internal/studio/tickets/verify?app_id=acc_demo&connection_id=acc_demo',
      payload: { bllFields: { ticket } },
    });
    expect(replay.statusCode).toBe(401);

    const billingHeaders = {
      'x-app-id': 'acc_demo',
      'x-las-api-key': 'las-secret-next',
    };
    const precheck = await app.inject({
      method: 'POST',
      url: '/api/studio/baseline/tasks?connection_id=acc_demo',
      headers: billingHeaders,
      payload: {
        RequestId: 'req-1',
        UserId: 'worker',
        Items: [{ BillingItemId: 'video-second', Unit: 'second', Usage: 10 }],
      },
    });
    expect(precheck.statusCode).toBe(200);

    const callback = await app.inject({
      method: 'POST',
      url: '/api/studio/baseline/tasks/callback?connection_id=acc_demo',
      headers: billingHeaders,
      payload: {
        RequestId: 'req-1',
        UserId: 'worker',
        Status: 'SUCCEEDED',
        CallbackMetadata: { traceId: 'trace-1' },
        Items: [{
          BillingItemId: 'video-second',
          Unit: 'second',
          Usage: 8,
          BillingContext: '{"output_tokens":8,"total_tokens":8}',
          UsageMetadata: { source: 'operator' },
        }],
      },
    });
    expect(callback.statusCode).toBe(200);
    const callbackTaskRows = await database.query<{ taskId: string } & import('mysql2/promise').RowDataPacket>(
      'SELECT task_id AS taskId FROM studio_tasks WHERE request_id = ?',
      ['req-1'],
    );
    const callbackTaskId = callbackTaskRows[0]?.taskId;
    expect(callbackTaskId).toBeTruthy();
    const callbackAudit = await app.inject({
      method: 'GET',
      url: `/api/admin/model-usage/${callbackTaskId}/audit?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(callbackAudit.statusCode).toBe(200);
    expect(callbackAudit.headers['content-disposition']).toContain('billing-audit-');
    expect(callbackAudit.json().audit.settlement).toMatchObject({
      source: 'callback',
      requestBody: {
        RequestId: 'req-1',
        UserId: 'worker',
        Status: 'SUCCEEDED',
        CallbackMetadata: { traceId: 'trace-1' },
        Items: [{
          BillingItemId: 'video-second',
          Unit: 'second',
          Usage: 8,
          BillingContext: '{"output_tokens":8,"total_tokens":8}',
          UsageMetadata: { source: 'operator' },
        }],
      },
      responseBody: {
        code: 200,
        message: 'success',
        requestId: 'req-1',
      },
    });

    const period = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    }).format(new Date()).slice(0, 7);
    const bill = await app.inject({
      method: 'GET',
      url: `/api/admin/bills/${period}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(bill.statusCode).toBe(200);
    expect(bill.json().items[0].customer_amount).toBe('16.000000');
    const userBill = await app.inject({
      method: 'GET',
      url: `/api/admin/bills/${period}?accountId=acc_demo&dimension=subaccount`,
      headers: { cookie: adminCookie },
    });
    expect(userBill.statusCode).toBe(200);
    expect(userBill.json().items[0]).toMatchObject({
      subject_id: subaccountId,
      subject_name: 'Worker Updated',
      customer_amount: '16.000000',
    });

    const lostCallbackPrecheck = await app.inject({
      method: 'POST',
      url: '/api/studio/baseline/tasks?connection_id=acc_demo',
      headers: billingHeaders,
      payload: {
        RequestId: 'req-lost-callback',
        UserId: 'worker',
        Items: [{ BillingItemId: 'video-second', Unit: 'second', Usage: 10 }],
      },
    });
    expect(lostCallbackPrecheck.statusCode).toBe(200);
    await database.execute(
      'UPDATE studio_tasks SET created_at = DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL 20 MINUTE) WHERE request_id = ?',
      ['req-lost-callback'],
    );
    studioUsagePayload = {
      Requests: [{
        RequestId: 'req-lost-callback',
        UserId: 'worker',
        Status: 'SUCCEEDED',
        Items: [{ BillingItemId: 'video-second', Unit: 'second', Usage: 5 }],
      }],
      TotalCount: 1,
    };
    const reconciler = new BillingReconciler(
      database,
      new StudioConnectionService(database, config, new StudioAdminClient()),
      new BillingService(database),
    );
    const reconciled = await reconciler.reconcile({ olderThanMinutes: 10, limit: 20 });
    expect(reconciled).toEqual({ scanned: 1, settled: 1, skipped: 0, failed: 0 });
    expect(studioCalls).toContain('/api/v1/open/usage/get');
    const reconciledTaskRows = await database.query<{ taskId: string } & import('mysql2/promise').RowDataPacket>(
      'SELECT task_id AS taskId FROM studio_tasks WHERE request_id = ?',
      ['req-lost-callback'],
    );
    const reconciledTaskId = reconciledTaskRows[0]?.taskId;
    expect(reconciledTaskId).toBeTruthy();
    const reconcileAudit = await app.inject({
      method: 'GET',
      url: `/api/admin/model-usage/${reconciledTaskId}/audit?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(reconcileAudit.statusCode).toBe(200);
    expect(reconcileAudit.json().audit).toMatchObject({
      settlement: {
        source: 'reconciliation',
        requestBody: {
          RequestId: 'req-lost-callback',
          UserId: 'worker',
          Status: 'SUCCEEDED',
        },
      },
      reconciliationQueries: [{
        request: {
          method: 'POST',
          body: { RequestIds: ['req-lost-callback'] },
        },
        response: {
          httpStatus: 200,
          body: studioUsagePayload,
        },
      }],
    });

    const reconciledAgain = await reconciler.reconcile({ olderThanMinutes: 10, limit: 20 });
    expect(reconciledAgain).toEqual({ scanned: 0, settled: 0, skipped: 0, failed: 0 });
    const reconciledBill = await app.inject({
      method: 'GET',
      url: `/api/admin/bills/${period}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(reconciledBill.json().items.find((item: { status: string }) => item.status === 'SUCCEEDED')
      .customer_amount).toBe('26.000000');

    const deletedSubaccount = await app.inject({
      method: 'DELETE',
      url: `/api/admin/subaccounts/${subaccountId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(deletedSubaccount.statusCode).toBe(200);
    expect(deletedSubaccount.json()).toMatchObject({
      userId: subaccountId,
      status: 'DELETED',
    });
    const usersAfterDelete = await app.inject({
      method: 'GET',
      url: '/api/admin/subaccounts?accountId=acc_demo',
      headers: { cookie: adminCookie },
    });
    expect(usersAfterDelete.json().items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ loginName: 'worker' }),
    ]));

    const recreatedSubaccount = await app.inject({
      method: 'POST',
      url: '/api/admin/subaccounts',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        loginName: 'worker',
        displayName: 'Worker Recreated',
        password: 'RecreatedPass123!',
        configGroupId,
        monthlyLimit: '70',
      },
    });
    expect(recreatedSubaccount.statusCode).toBe(200);
    expect(recreatedSubaccount.json()).toMatchObject({
      userId: subaccountId,
      status: 'ACTIVE',
    });
    const recreatedLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        accountId: 'acc_demo',
        loginName: 'worker',
        password: 'RecreatedPass123!',
        ...await captchaFields(),
      },
    });
    expect(recreatedLogin.statusCode).toBe(200);
    const duplicateRecreatedSubaccount = await app.inject({
      method: 'POST',
      url: '/api/admin/subaccounts',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        loginName: 'worker',
        displayName: 'Worker Duplicate',
        password: 'DuplicatePass123!',
        configGroupId,
        monthlyLimit: null,
      },
    });
    expect(duplicateRecreatedSubaccount.statusCode).toBe(409);
    expect(duplicateRecreatedSubaccount.json()).toMatchObject({
      code: 'SUBACCOUNT_ALREADY_EXISTS',
      messageKey: 'users.loginNameExists',
    });
  }, 20_000);

  it('多 Studio 连接按配置组映射 Project、Ticket 与删除顺序', async () => {
    const adminCookie = await login('acc_demo', 'root', 'StrongPass123!');
    const defaultConnection = await configureStudio(adminCookie);
    expect(defaultConnection.statusCode).toBe(200);
    const defaultConnectionId = defaultConnection.json().connection.connectionId as string;

    const duplicateConnection = await app.inject({
      method: 'POST',
      url: '/api/admin/studio/connections',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        name: 'duplicate-studio',
        studioBaseUrl: `${studioBase}/`,
        callbackBaseUrl: 'http://studio-login.test',
      },
    });
    expect(duplicateConnection.statusCode).toBe(409);
    expect(duplicateConnection.json()).toMatchObject({
      code: 'STUDIO_INSTANCE_ALREADY_REGISTERED',
    });

    const secondConnection = await app.inject({
      method: 'POST',
      url: '/api/admin/studio/connections',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        name: 'second-studio',
        studioBaseUrl: secondStudioBase,
        callbackBaseUrl: 'http://studio-login.test',
      },
    });
    expect(secondConnection.statusCode).toBe(200);
    expect(secondConnection.json().connection).toMatchObject({
      appId: 'acc_demo',
      name: 'second-studio',
      status: 'READY',
    });
    const connectionId = secondConnection.json().connection.connectionId as string;
    const updatedSecondConnection = await app.inject({
      method: 'PUT',
      url: `/api/admin/studio/connections/${connectionId}`,
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        name: 'second-studio',
        studioBaseUrl: `${secondStudioBase}/`,
        callbackBaseUrl: 'http://studio-login.test',
      },
    });
    expect(updatedSecondConnection.statusCode).toBe(200);

    const group = await app.inject({
      method: 'POST',
      url: '/api/admin/config-groups',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        connectionId,
        projectId: 'studio_project_2',
        name: 'second-group',
        monthlyLimit: null,
        isDefault: false,
        resourceConfig: {
          lasApiKey: 'las-second',
          arkApiKey: 'ark-second',
          tosBucketName: 'second-bucket',
        },
      },
    });
    expect(group.statusCode).toBe(200);
    const configGroupId = group.json().configGroupId as string;

    const subaccount = await app.inject({
      method: 'POST',
      url: '/api/admin/subaccounts',
      headers: { cookie: adminCookie },
      payload: {
        accountId: 'acc_demo',
        loginName: 'worker-second',
        displayName: 'Worker Second',
        password: 'StrongPass123!',
        configGroupId,
        monthlyLimit: null,
      },
    });
    expect(subaccount.statusCode).toBe(200);
    const userId = subaccount.json().userId as string;
    const secondUserProfileRequests = studioRequestBodies.filter(request =>
      request.path === '/integration/api/v1/user-profiles/upsert'
      && request.body.userId === 'worker-second');
    expect(secondUserProfileRequests).toHaveLength(1);
    expect(secondUserProfileRequests[0]?.body).toMatchObject({
      appId: 'acc_demo',
      projectId: 'studio_project_2',
      userId: 'worker-second',
      projectLevelSharing: false,
    });

    const userCookie = await login('acc_demo', 'worker-second', 'StrongPass123!');
    const launch = await app.inject({
      method: 'POST',
      url: '/api/studio/tickets/launch',
      headers: { cookie: userCookie },
    });
    expect(launch.statusCode).toBe(200);
    const launchUrl = new URL(launch.json().launchUrl as string);
    expect(`${launchUrl.origin}${launchUrl.pathname}`).toBe(secondStudioBase);
    expect(launchUrl.searchParams.get('app_id')).toBe('acc_demo');
    const ticket = launchUrl.searchParams.get('ticket');
    expect(ticket).toBeTruthy();

    const wrongConnection = await app.inject({
      method: 'POST',
      url: `/api/internal/studio/tickets/verify?app_id=acc_demo&connection_id=${defaultConnectionId}`,
      payload: { bllFields: { ticket } },
    });
    expect(wrongConnection.statusCode).toBe(401);

    const verified = await app.inject({
      method: 'POST',
      url: `/api/internal/studio/tickets/verify?app_id=acc_demo&connection_id=${connectionId}`,
      payload: { bllFields: { ticket } },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().data.LoginUserObject).toEqual({
      t_b001_user_id: 'worker-second',
      t_b002_merchant_id: 'studio_project_2',
    });
    expect(verified.json().data).toMatchObject({
      appId: 'acc_demo',
      projectId: 'studio_project_2',
      userId: 'worker-second',
    });

    const blockedConnectionDelete = await app.inject({
      method: 'DELETE',
      url: `/api/admin/studio/connections/${connectionId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(blockedConnectionDelete.statusCode).toBe(409);
    const blockedGroupDelete = await app.inject({
      method: 'DELETE',
      url: `/api/admin/config-groups/${configGroupId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    });
    expect(blockedGroupDelete.statusCode).toBe(409);

    expect((await app.inject({
      method: 'DELETE',
      url: `/api/admin/subaccounts/${userId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    })).statusCode).toBe(200);
    expect(studioRequestBodies).toContainEqual({
      path: '/integration/api/v1/user-profiles/delete',
      body: {
        appId: 'acc_demo',
        projectId: 'studio_project_2',
        userId: 'worker-second',
      },
    });
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/admin/config-groups/${configGroupId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: 'DELETE',
      url: `/api/admin/studio/connections/${connectionId}?accountId=acc_demo`,
      headers: { cookie: adminCookie },
    })).statusCode).toBe(200);
    expect(studioRequestBodies).toContainEqual({
      path: '/integration/api/v1/applications/unregister',
      body: { appId: 'acc_demo' },
    });
  }, 20_000);
});
