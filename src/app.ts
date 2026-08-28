import { fileURLToPath } from 'node:url';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { z, ZodError } from 'zod';

import { AuthService, SESSION_COOKIE_NAME } from './auth.js';
import {
  BillingService,
  type BaselineCallbackInput,
  type BaselinePrecheckInput,
} from './billing.js';
import type { AppConfig } from './config.js';
import { ConfigGroupService } from './config-groups.js';
import { importCsvRows, parseCsvRecords } from './csv-import.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import { createAppLogger } from './logging.js';
import { StudioAdminClient } from './studio-client.js';
import { StudioConnectionService } from './studio-connections.js';
import { TicketService } from './tickets.js';

const loginSchema = z.object({
  accountId: z.string().min(1).max(64).optional(),
  loginName: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
});

const studioConnectionSchema = z.object({
  accountId: z.string().min(1).max(64),
  studioBaseUrl: z.string().url().max(512),
  callbackBaseUrl: z.string().url().max(512),
});

const namedStudioConnectionSchema = studioConnectionSchema.extend({
  name: z.string().min(1).max(128),
});

const resourceConfigSchema = z.object({
  lasBaseUrl: z.string().max(512).optional(),
  lasApiKey: z.string().max(4096).optional(),
  arkApiKey: z.string().max(4096).optional(),
  tosAccessKey: z.string().max(4096).optional(),
  tosSecretKey: z.string().max(4096).optional(),
  tosBucketName: z.string().max(128).optional(),
  tosUploadPrefix: z.string().max(512).optional(),
  tosRegion: z.string().max(64).optional(),
  tosEndpoint: z.string().max(512).optional(),
  outputTosPath: z.string().max(1024).optional(),
  region: z.string().max(64).optional(),
  customImageModelConfigs: z.unknown().optional(),
  customLlmModelConfigs: z.unknown().optional(),
}).strict();

const nonNegativeAmount = z.union([z.string(), z.number()])
  .transform(String)
  .refine(value => /^\d+(?:\.\d+)?$/.test(value), '金额必须是非负十进制数');

const optionalAmount = nonNegativeAmount.nullable().optional()
  .transform(value => value === null || value === undefined ? null : String(value));

const createGroupSchema = z.object({
  accountId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  resourceConfig: resourceConfigSchema,
  monthlyLimit: optionalAmount,
  isDefault: z.boolean().default(false),
});

const createVersionSchema = z.object({
  accountId: z.string().min(1).max(64),
  resourceConfig: resourceConfigSchema,
  monthlyLimit: optionalAmount,
});

const saveGroupSchema = z.object({
  accountId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  resourceConfig: resourceConfigSchema,
  monthlyLimit: optionalAmount,
});

const createSubaccountSchema = z.object({
  accountId: z.string().min(1).max(64),
  loginName: z.string().min(3).max(64),
  displayName: z.string().min(1).max(128),
  password: z.string().min(8).max(128),
  configGroupId: z.string().min(1).max(64),
  monthlyLimit: optionalAmount,
});

const subaccountStatusSchema = z.object({
  accountId: z.string().min(1).max(64),
  status: z.enum(['ACTIVE', 'DISABLED']),
});

const updateSubaccountSchema = z.object({
  accountId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(128),
  password: z.string().min(8).max(128).optional(),
  configGroupId: z.string().min(1).max(64),
  monthlyLimit: optionalAmount,
});

const priceSchema = z.object({
  appId: z.string().min(1).max(64),
  billingItemId: z.string().min(1).max(128),
  unit: z.string().min(1).max(32),
  customerUnitPrice: nonNegativeAmount,
  costUnitPrice: nonNegativeAmount,
});

const csvImportSchema = z.object({
  accountId: z.string().min(1).max(64),
  csv: z.string().min(1).max(1_000_000),
});

const subaccountCsvRowSchema = z.object({
  loginName: z.string().min(3).max(64),
  displayName: z.string().min(1).max(128),
  password: z.string().min(8).max(128),
  configGroup: z.string().min(1).max(128),
  monthlyLimit: z.string().max(64).optional(),
}).passthrough();

const priceCsvRowSchema = z.object({
  billingItemId: z.string().min(1).max(128),
  unit: z.string().min(1).max(32),
  customerUnitPrice: nonNegativeAmount,
  costUnitPrice: nonNegativeAmount,
  platformDefault: z.enum(['', 'false', 'true', '0', '1', '否', '是']).default('')
    .transform(value => ['true', '1', '是'].includes(value)),
}).passthrough();

const baselineItemSchema = z.object({
  BillingItemId: z.string().min(1).max(128),
  Unit: z.string().min(1).max(32),
  Usage: z.union([z.number(), z.string()]),
  ModelId: z.string().max(128).optional(),
});

const precheckSchema = z.object({
  RequestId: z.string().min(1).max(128),
  UserId: z.string().min(1).max(128),
  Items: z.array(baselineItemSchema).min(1).max(100),
});

const callbackSchema = precheckSchema.extend({
  Status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
});

function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

export interface AppDependencies {
  config: AppConfig;
  database: Database;
  logger?: FastifyBaseLogger;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, database } = dependencies;
  const logger: FastifyBaseLogger = dependencies.logger ?? createAppLogger(config);
  const app = Fastify({
    trustProxy: true,
    loggerInstance: logger,
  });
  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
  });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    return payload;
  });

  const auth = new AuthService(database, config);
  const studioClient = new StudioAdminClient(app.log);
  const studioConnections = new StudioConnectionService(database, config, studioClient);
  const configGroups = new ConfigGroupService(database, config, studioConnections);
  const tickets = new TicketService(database, config, studioConnections);
  const billing = new BillingService(database);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      request.log.warn({
        errorCode: 'VALIDATION_ERROR',
        issueCount: error.issues.length,
        statusCode: 400,
      }, 'request validation failed');
      void reply.status(400).send({ code: 'VALIDATION_ERROR', message: '请求参数不合法', details: error.issues });
      return;
    }
    if (error instanceof AppError) {
      const logContext = {
        err: error,
        errorCode: error.code,
        statusCode: error.statusCode,
      };
      if (error.statusCode >= 500) request.log.error(logContext, 'request failed');
      else request.log.warn(logContext, 'request rejected');
      void reply.status(error.statusCode).send({ code: error.code, message: error.message });
      return;
    }
    const mysqlCode = (error as { code?: string }).code;
    if (mysqlCode === 'ER_DUP_ENTRY') {
      request.log.warn({
        errorCode: 'DUPLICATE_RESOURCE',
        statusCode: 409,
      }, 'request rejected by unique constraint');
      void reply.status(409).send({ code: 'DUPLICATE_RESOURCE', message: '资源已存在' });
      return;
    }
    request.log.error({
      err: error,
      errorCode: mysqlCode ?? 'UNEXPECTED',
    }, 'unhandled request error');
    void reply.status(500).send({ code: 'INTERNAL_ERROR', message: '服务内部错误' });
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/api/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const session = await auth.login({
      ...body,
      accountId: body.accountId ?? config.STUDIO_LOGIN_ACCOUNT_ID,
      clientIp: requestIp(request),
    });
    reply.setCookie(SESSION_COOKIE_NAME, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.protocol === 'https',
      path: '/',
      expires: new Date(session.expiresAt),
    });
    return { user: session.actor, expiresAt: session.expiresAt };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await auth.logout(request);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { success: true };
  });

  app.get('/api/auth/me', async request => ({ user: await auth.requireActor(request) }));

  app.post('/api/admin/config-groups', async request => {
    const body = createGroupSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    const defaultConnection = await studioConnections.get(body.accountId);
    const connectionId = body.connectionId ?? defaultConnection?.connectionId;
    if (!connectionId) {
      throw new AppError('请先创建 Studio 连接', 409, 'STUDIO_NOT_CONFIGURED');
    }
    const created = await configGroups.create({
      ...body,
      connectionId,
      projectId: body.projectId ?? body.accountId,
      actor,
    });
    const published = await configGroups.publish({
      accountId: body.accountId,
      configGroupId: created.configGroupId,
    });
    return { ...created, ...published, status: published.failed === 0 ? 'AVAILABLE' : 'PARTIAL_FAILED' };
  });

  app.get('/api/admin/config-groups', async request => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return { items: await configGroups.list(query.accountId) };
  });

  app.get('/api/admin/studio/status', async request => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return { connection: await studioConnections.get(query.accountId) };
  });

  app.get('/api/admin/studio/connections', async request => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return { items: await studioConnections.list(query.accountId) };
  });

  app.post('/api/admin/studio/connections', async request => {
    const body = namedStudioConnectionSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    return { connection: await studioConnections.create({ ...body, actor }) };
  });

  app.put('/api/admin/studio/connections/:connectionId', async request => {
    const params = z.object({ connectionId: z.string().min(1).max(64) }).parse(request.params);
    const body = namedStudioConnectionSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    return {
      connection: await studioConnections.update({
        ...body,
        connectionId: params.connectionId,
        actor,
      }),
    };
  });

  app.post('/api/admin/studio/connections/:connectionId/retry-register', async request => {
    const params = z.object({ connectionId: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ accountId: z.string().min(1).max(64) }).parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    return studioConnections.registerById(body.accountId, params.connectionId, actor);
  });

  app.delete('/api/admin/studio/connections/:connectionId', async request => {
    const params = z.object({ connectionId: z.string().min(1).max(64) }).parse(request.params);
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return studioConnections.delete(query.accountId, params.connectionId);
  });

  app.put('/api/admin/studio/config', async request => {
    const body = studioConnectionSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    await studioConnections.save({
      ...body,
      actor,
    });
    const registration = await studioConnections.register(body.accountId, actor);
    return {
      connection: await studioConnections.get(body.accountId),
      registration,
    };
  });

  app.post('/api/admin/config-groups/:configGroupId/versions', async request => {
    const params = z.object({ configGroupId: z.string().min(1).max(64) }).parse(request.params);
    const body = createVersionSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    return configGroups.createVersion({ ...body, configGroupId: params.configGroupId, actor });
  });

  app.post('/api/admin/config-groups/:configGroupId/publish', async request => {
    const params = z.object({ configGroupId: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ accountId: z.string().min(1).max(64) }).parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.publish({ accountId: body.accountId, configGroupId: params.configGroupId });
  });

  app.post('/api/admin/config-groups/:configGroupId/retry', async request => {
    const params = z.object({ configGroupId: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ accountId: z.string().min(1).max(64) }).parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.publish({ accountId: body.accountId, configGroupId: params.configGroupId });
  });

  app.delete('/api/admin/config-groups/:configGroupId', async request => {
    const params = z.object({ configGroupId: z.string().min(1).max(64) }).parse(request.params);
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return configGroups.deleteGroup({ accountId: query.accountId, configGroupId: params.configGroupId });
  });

  app.put('/api/admin/config-groups/:configGroupId', async request => {
    const params = z.object({ configGroupId: z.string().min(1).max(64) }).parse(request.params);
    const body = saveGroupSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    return configGroups.save({ ...body, configGroupId: params.configGroupId, actor });
  });

  app.post('/api/admin/subaccounts', async request => {
    const body = createSubaccountSchema.parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.createSubaccount(body);
  });

  app.get('/api/admin/subaccounts', async request => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return { items: await configGroups.listSubaccounts(query.accountId) };
  });

  app.get('/api/admin/subaccounts/import-template', async (request, reply) => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="studio-subaccounts.csv"')
      .send('\uFEFFloginName,displayName,password,configGroup,monthlyLimit\nworker,示例用户,password-123,默认配置,100\n');
  });

  app.post('/api/admin/subaccounts/import', async request => {
    const body = csvImportSchema.parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    const rows = parseCsvRecords(body.csv);
    return importCsvRows(rows, async row => {
      const parsed = subaccountCsvRowSchema.parse(row);
      const configGroupId = await configGroups.resolveAvailableGroupId(
        body.accountId,
        parsed.configGroup,
      );
      const result = await configGroups.createSubaccount({
        accountId: body.accountId,
        loginName: parsed.loginName,
        displayName: parsed.displayName,
        password: parsed.password,
        configGroupId,
        monthlyLimit: optionalAmount.parse(parsed.monthlyLimit?.trim() || null),
      });
      return `创建成功: ${result.userId}`;
    });
  });

  app.patch('/api/admin/subaccounts/:userId/status', async request => {
    const params = z.object({ userId: z.string().min(1).max(64) }).parse(request.params);
    const body = subaccountStatusSchema.parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.setSubaccountStatus({ ...body, userId: params.userId });
  });

  app.patch('/api/admin/subaccounts/:userId', async request => {
    const params = z.object({ userId: z.string().min(1).max(64) }).parse(request.params);
    const body = updateSubaccountSchema.parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.updateSubaccount({ ...body, userId: params.userId });
  });

  app.post('/api/admin/subaccounts/:userId/retry-profile-sync', async request => {
    const params = z.object({ userId: z.string().min(1).max(64) }).parse(request.params);
    const body = z.object({ accountId: z.string().min(1).max(64) }).parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    return configGroups.retrySubaccount({ accountId: body.accountId, userId: params.userId });
  });

  app.delete('/api/admin/subaccounts/:userId', async request => {
    const params = z.object({ userId: z.string().min(1).max(64) }).parse(request.params);
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    return configGroups.deleteSubaccount({ accountId: query.accountId, userId: params.userId });
  });

  app.post('/api/admin/prices', async request => {
    const body = priceSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.appId === '*' ? undefined : body.appId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError('只有系统管理员可以配置平台默认价格', 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    await billing.upsertPrice({ ...body, actor });
    return { success: true };
  });

  app.get('/api/admin/prices', async request => {
    const query = z.object({ appId: z.string().min(1).max(64) }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.appId);
    const items = await billing.listPrices(query.appId) as Array<Record<string, unknown>>;
    return {
      items: actor.role === 'SYSTEM_ADMIN'
        ? items
        : items.map(({ costUnitPrice: _costUnitPrice, ...item }) => item),
    };
  });

  app.delete('/api/admin/prices', async request => {
    const body = z.object({
      appId: z.string().min(1).max(64),
      billingItemId: z.string().min(1).max(128),
      unit: z.string().min(1).max(32),
    }).parse(request.body);
    const actor = await auth.requireAdmin(request, body.appId === '*' ? undefined : body.appId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError('只有系统管理员可以删除价格', 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    await billing.disablePrice(body);
    return { success: true };
  });

  app.get('/api/admin/prices/import-template', async (request, reply) => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError('只有系统管理员可以批量配置价格', 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="studio-prices.csv"')
      .send('\uFEFFbillingItemId,unit,customerUnitPrice,costUnitPrice,platformDefault\nvideo-second,second,2,1,false\n');
  });

  app.post('/api/admin/prices/import', async request => {
    const body = csvImportSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError('只有系统管理员可以批量配置价格', 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    const rows = parseCsvRecords(body.csv);
    return importCsvRows(rows, async row => {
      const parsed = priceCsvRowSchema.parse(row);
      await billing.upsertPrice({
        appId: parsed.platformDefault ? '*' : body.accountId,
        billingItemId: parsed.billingItemId,
        unit: parsed.unit,
        customerUnitPrice: parsed.customerUnitPrice,
        costUnitPrice: parsed.costUnitPrice,
        actor,
      });
      return '保存成功';
    });
  });

  app.get('/api/admin/bills/:period', async request => {
    const params = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.params);
    const query = z.object({
      accountId: z.string().min(1).max(64),
      dimension: z.enum(['overall', 'configGroup', 'subaccount']).default('overall'),
    }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.accountId);
    const summary = await billing.billSummary(query.accountId, params.period, query.dimension) as {
      accountId: string;
      billingPeriod: string;
      items: Array<Record<string, unknown>>;
    };
    return actor.role === 'SYSTEM_ADMIN'
      ? summary
      : {
          ...summary,
          items: summary.items.map(({ cost_amount: _costAmount, ...item }) => item),
        };
  });

  app.post('/api/studio/tickets/launch', async request => {
    const actor = await auth.requireActor(request);
    return tickets.launch(actor);
  });

  app.post('/api/internal/studio/tickets/verify', async request => {
    const query = z.object({
      app_id: z.string().min(1).max(64),
      connection_id: z.string().min(1).max(64),
    }).parse(request.query);
    const body = z.object({
      bllFields: z.object({ ticket: z.string() }),
    }).parse(request.body);
    const identity = await tickets.consume(
      body.bllFields.ticket,
      query.app_id,
      query.connection_id,
    );
    return {
      code: 0,
      message: 'success',
      data: {
        LoginUserObject: {
          t_b001_user_id: identity.userId,
          t_b002_merchant_id: identity.projectId,
        },
        userId: identity.userId,
        projectId: identity.projectId,
        appId: identity.appId,
      },
    };
  });

  app.post('/api/studio/baseline/tasks', async request => {
    const query = z.object({ connection_id: z.string().min(1).max(64) }).parse(request.query);
    const appId = String(request.headers['x-app-id'] ?? '');
    const token = String(request.headers['x-las-api-key'] ?? '');
    const body = precheckSchema.parse(request.body) as BaselinePrecheckInput;
    if (!await studioConnections.verifyCallbackToken(
      query.connection_id,
      appId,
      token,
      body.UserId,
    )) {
      throw new AppError('Studio 鉴权失败', 401, 'STUDIO_UNAUTHORIZED');
    }
    await billing.precheck(query.connection_id, appId, body);
    return { code: 200, message: 'success' };
  });

  app.post('/api/studio/baseline/tasks/callback', async request => {
    const query = z.object({ connection_id: z.string().min(1).max(64) }).parse(request.query);
    const appId = String(request.headers['x-app-id'] ?? '');
    const token = String(request.headers['x-las-api-key'] ?? '');
    const body = callbackSchema.parse(request.body) as BaselineCallbackInput;
    if (!await studioConnections.verifyCallbackToken(
      query.connection_id,
      appId,
      token,
      body.UserId,
      body.RequestId,
    )) {
      throw new AppError('Studio 鉴权失败', 401, 'STUDIO_UNAUTHORIZED');
    }
    await billing.callback(query.connection_id, appId, body);
    return { code: 200, message: 'success' };
  });


  return app;
}
