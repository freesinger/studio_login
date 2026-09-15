import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { z, ZodError } from 'zod';

import { message, formatValidationIssues, requestLocale, translate, type LocalizedMessage } from './i18n.js';
import { AuthService, SESSION_COOKIE_NAME } from './auth.js';
import {
  BillingService,
  type BaselineCallbackInput,
  type BaselinePrecheckInput,
} from './billing.js';
import type { AppConfig } from './config.js';
import { ConfigGroupService } from './config-groups.js';
import { derivedCustomBillingCatalog } from './custom-billing-items.js';
import { importCsvRows, parseCsvRecords } from './csv-import.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import { createAppLogger } from './logging.js';
import { ModelUsageService } from './model-usage.js';
import { StudioAdminClient } from './studio-client.js';
import { StudioConnectionService } from './studio-connections.js';
import { TicketService } from './tickets.js';

const loginSchema = z.object({
  accountId: z.string().min(1).max(64).optional(),
  connectionId: z.string().min(1).max(64).optional(),
  loginName: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  configGroup: z.string().min(1).max(128).optional(),
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
  customModels: z.unknown().optional(),
}).strict();

const nonNegativeAmount = z.union([z.string(), z.number()])
  .transform(String)
  .refine(value => /^\d+(?:\.\d+)?$/.test(value), 'validation.nonNegativeAmount');

const priceAmount = z.union([z.string(), z.number()])
  .transform(String)
  .refine(value => /^\d+(?:\.\d{1,10})?$/.test(value), 'validation.pricePrecision');

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
  projectLevelSharing: z.boolean().default(false),
});

const createVersionSchema = z.object({
  accountId: z.string().min(1).max(64),
  resourceConfig: resourceConfigSchema,
  monthlyLimit: optionalAmount,
  projectLevelSharing: z.boolean().optional(),
});

const saveGroupSchema = z.object({
  accountId: z.string().min(1).max(64),
  connectionId: z.string().min(1).max(64).optional(),
  projectId: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  resourceConfig: resourceConfigSchema,
  monthlyLimit: optionalAmount,
  projectLevelSharing: z.boolean().optional(),
});

const createSubaccountSchema = z.object({
  accountId: z.string().min(1).max(64),
  loginName: z.string().min(3).max(64),
  displayName: z.string().min(1).max(128),
  password: z.string().min(8).max(128),
  configGroupId: z.string().min(1).max(64).optional(),
  configGroupBindings: z.array(z.object({
    configGroupId: z.string().min(1).max(64),
    monthlyLimit: optionalAmount,
    isDefault: z.boolean().optional(),
  })).min(1).max(20).optional(),
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
  configGroupId: z.string().min(1).max(64).optional(),
  configGroupBindings: z.array(z.object({
    configGroupId: z.string().min(1).max(64),
    monthlyLimit: optionalAmount,
    isDefault: z.boolean().optional(),
  })).min(1).max(20).optional(),
  monthlyLimit: optionalAmount,
});

const priceSchema = z.object({
  accountId: z.string().min(1).max(64),
  scopeType: z.enum(['CONFIG_GROUP', 'PLATFORM']),
  scopeId: z.string().min(1).max(64),
  billingItemId: z.string().min(1).max(128),
  unit: z.string().min(1).max(32),
  customerUnitPrice: priceAmount,
  costUnitPrice: priceAmount,
});

const csvImportSchema = z.object({
  accountId: z.string().min(1).max(64),
  csv: z.string().min(1).max(1_000_000),
});

const priceCsvImportSchema = csvImportSchema.extend({
  scopeType: z.enum(['CONFIG_GROUP', 'PLATFORM']),
  scopeId: z.string().min(1).max(64),
});

const customModelTestSchema = z.object({
  accountId: z.string().min(1).max(64),
  type: z.enum(['IMAGE', 'LANGUAGE', 'ELEVENLABS']),
  model: z.string().min(1).max(128),
  endpoint: z.string().max(512).optional(),
  apiKey: z.string().min(1).max(4096),
  imageResolutions: z.array(z.enum(['1K', '1.5K', '2K', '3K', '4K'])).optional(),
}).strict();

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
  configGroup: z.string().max(128).optional(),
  customerUnitPrice: priceAmount,
  costUnitPrice: priceAmount,
}).passthrough();

const baselineItemSchema = z.object({
  BillingItemId: z.string().min(1).max(128),
  Unit: z.string().min(1).max(32),
  Usage: z.union([z.number(), z.string()]),
  ModelId: z.string().max(128).optional(),
  BillingContext: z.string().max(20000).optional(),
}).passthrough();

const precheckSchema = z.object({
  RequestId: z.string().min(1).max(128),
  UserId: z.string().min(1).max(128),
  ProjectId: z.string().min(1).max(128).optional(),
  Items: z.array(baselineItemSchema).min(1).max(100),
}).passthrough();

const callbackSchema = precheckSchema.extend({
  Status: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED']),
});

function requestIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function validRequestId(value: string | undefined): string | undefined {
  const requestId = value?.trim();
  if (!requestId || requestId.length > 128) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(requestId) ? requestId : undefined;
}

const customImageSizes: Record<string, string> = {
  '1K': '1024x1024',
  '1.5K': '1536x1536',
  '2K': '2048x2048',
  '3K': '3072x3072',
  '4K': '4096x4096',
};

function normalizeEndpointOrigin(endpoint: string): string {
  const raw = endpoint.trim();
  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError(message('customModels.invalidBaseUrl'), 400, 'CUSTOM_MODEL_CONNECTION_INVALID');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || (url.pathname && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new AppError(
      message('customModels.baseUrlWithoutPath'),
      400,
      'CUSTOM_MODEL_CONNECTION_INVALID',
    );
  }
  return url.origin;
}

async function readResponsePayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    const payload = JSON.parse(text) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isLanguageModelResponse(payload: Record<string, unknown>): boolean {
  const choices = payload.choices;
  const firstChoice = Array.isArray(choices) && choices[0] && typeof choices[0] === 'object'
    ? choices[0] as Record<string, unknown>
    : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : null;
  return typeof message?.content === 'string';
}

function customModelConnectionError(status: number): LocalizedMessage {
  if (status === 401 || status === 403) return message('customModels.invalidApiKey');
  if (status === 404) return message('customModels.endpointNotFound');
  if (status === 408 || status === 504) return message('customModels.upstreamTimeout');
  if (status === 400 || status === 422) return message('customModels.invalidParameters');
  if (status === 429) return message('customModels.rateLimited');
  if (status >= 500) return message('customModels.upstreamUnavailable');
  return message('customModels.connectionFailed');
}

async function testCustomModelConnection(input: z.infer<typeof customModelTestSchema>): Promise<void> {
  const key = input.apiKey.trim().replace(/^Bearer\s+/i, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const endpoint = input.type === 'ELEVENLABS'
      ? ''
      : normalizeEndpointOrigin(input.endpoint || '');
    const response = await fetch(
      input.type === 'ELEVENLABS'
        ? 'https://api.elevenlabs.io/v1/models'
        : input.type === 'IMAGE'
          ? `${endpoint}/v1/images/generations`
          : `${endpoint}/v1/chat/completions`,
      {
        method: input.type === 'ELEVENLABS' ? 'GET' : 'POST',
        headers: input.type === 'ELEVENLABS'
          ? {
            'content-type': 'application/json',
            'xi-api-key': key,
          }
          : {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
        ...(input.type === 'ELEVENLABS'
          ? {}
          : {
            body: JSON.stringify(input.type === 'IMAGE'
              ? {
                model: input.model.trim(),
                n: 1,
                prompt: '1',
                quality: 'low',
                size: customImageSizes[input.imageResolutions?.[0] || '1K'],
              }
              : {
                messages: [
                  { content: 'Return a short plain-text answer.', role: 'system' },
                  { content: 'Reply with OK.', role: 'user' },
                ],
                model: input.model.trim(),
                stream: false,
                temperature: 0.7,
              }),
          }),
        signal: controller.signal,
      },
    );
    const payload = await readResponsePayload(response);
    if (!response.ok) {
      throw new AppError(customModelConnectionError(response.status), 502, 'CUSTOM_MODEL_CONNECTION_FAILED');
    }
    if (input.type === 'LANGUAGE' && !isLanguageModelResponse(payload)) {
      throw new AppError(message('customModels.invalidResponse'), 502, 'CUSTOM_MODEL_CONNECTION_FAILED');
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AppError(message('customModels.timeout'), 504, 'CUSTOM_MODEL_CONNECTION_TIMEOUT');
    }
    throw new AppError(message('customModels.networkFailed'), 502, 'CUSTOM_MODEL_CONNECTION_FAILED');
  } finally {
    clearTimeout(timeout);
  }
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
    genReqId: request => validRequestId(headerValue(request.headers['x-request-id']))
      ?? validRequestId(headerValue(request.headers['x-las-request-id']))
      ?? validRequestId(headerValue(request.headers['x-client-request-id']))
      ?? randomUUID(),
  });
  await app.register(cookie);
  await app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    prefix: '/',
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (request.url.startsWith('/api/')) {
      const locale = requestLocale(request.headers['accept-language']);
      reply.header('content-language', locale);
      reply.header('vary', [reply.getHeader('vary'), 'Accept-Language'].filter(Boolean).join(', '));
    }
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-las-request-id', request.id);
  });

  const auth = new AuthService(database, config);
  const studioClient = new StudioAdminClient(app.log);
  const studioConnections = new StudioConnectionService(database, config, studioClient);
  const configGroups = new ConfigGroupService(database, config, studioConnections);
  const tickets = new TicketService(database, config, studioConnections);
  const billing = new BillingService(database, config, app.log);
  const modelUsage = new ModelUsageService(database, config.timeZone);

  app.setErrorHandler((error, request, reply) => {
    const locale = requestLocale(request.headers['accept-language']);
    if (error instanceof ZodError) {
      request.log.warn({
        errorCode: 'VALIDATION_ERROR',
        issueCount: error.issues.length,
        statusCode: 400,
      }, 'request validation failed');
      void reply.status(400).send({ code: 'VALIDATION_ERROR', messageKey: 'errors.invalidParameters', message: translate('errors.invalidParameters', locale), details: formatValidationIssues(error.issues, locale) });
      return;
    }
    if (error instanceof AppError) {
      const logContext = {
        err: error,
        errorCode: error.code,
        statusCode: error.statusCode,
        requestId: request.id,
      };
      if (error.statusCode >= 500) request.log.error(logContext, 'request failed');
      else request.log.warn(logContext, 'request rejected');
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.localize(locale),
        ...(error.localizedMessage ? { messageKey: error.localizedMessage.key, messageParams: error.localizedMessage.params } : {}),
        requestId: request.id,
        ...(error.details === undefined ? {} : { data: error.details }),
      });
      return;
    }
    const mysqlCode = (error as { code?: string }).code;
    if (mysqlCode === 'ER_DUP_ENTRY') {
      request.log.warn({
        errorCode: 'DUPLICATE_RESOURCE',
        statusCode: 409,
      }, 'request rejected by unique constraint');
      void reply.status(409).send({ code: 'DUPLICATE_RESOURCE', messageKey: 'errors.resourceExists', message: translate('errors.resourceExists', locale) });
      return;
    }
    request.log.error({
      err: error,
      errorCode: mysqlCode ?? 'UNEXPECTED',
    }, 'unhandled request error');
    void reply.status(500).send({ code: 'INTERNAL_ERROR', messageKey: 'errors.internal', message: translate('errors.internal', locale) });
  });

  const i18nextRoot = dirname(createRequire(import.meta.url).resolve('i18next/package.json'));
  const i18nextBrowser = readFileSync(join(i18nextRoot, 'dist/esm/i18next.js'), 'utf8');
  app.get('/vendor/i18next.js', async (_request, reply) => reply.type('text/javascript').send(i18nextBrowser));

  app.get('/api/runtime-config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { currency: config.STUDIO_LOGIN_CURRENCY, timeZone: config.timeZone, defaultPrices: config.defaultPrices };
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/api/auth/projects', async request => {
    const query = z.object({
      accountId: z.string().min(1).max(64).optional(),
    }).parse(request.query);
    const accountId = query.accountId ?? config.STUDIO_LOGIN_ACCOUNT_ID;
    const rows = await database.query<{
      config_group_id: string;
      connection_id: string;
      project_id: string;
      name: string;
      connection_name: string;
      connection_default: number;
      is_default: number;
    } & import('mysql2/promise').RowDataPacket>(
      `SELECT g.config_group_id, g.connection_id, g.project_id, g.name,
              r.name AS connection_name, r.is_default AS connection_default, g.is_default
         FROM config_groups g
         JOIN studio_registrations r ON r.connection_id = g.connection_id
        WHERE g.account_id = ?
          AND g.status IN ('AVAILABLE', 'PARTIAL_FAILED')
          AND r.status = 'READY'
        ORDER BY r.is_default DESC, r.name, g.is_default DESC, g.created_at, g.config_group_id`,
      [accountId],
    );
    return {
      items: rows.map(row => ({
        configGroupId: row.config_group_id,
        connectionId: row.connection_id,
        projectId: row.project_id,
        name: row.name,
        connectionName: row.connection_name,
        connectionDefault: Boolean(row.connection_default),
        isDefault: Boolean(row.is_default),
      })),
    };
  });

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

  app.get('/api/auth/my-projects', async request => {
    const actor = await auth.requireActor(request);
    if (actor.role !== 'SUBACCOUNT') return { items: [] };
    const rows = await database.query<{
      config_group_id: string;
      connection_id: string;
      project_id: string;
      name: string;
      connection_name: string;
      is_default: number;
    } & import('mysql2/promise').RowDataPacket>(
      `SELECT g.config_group_id, g.connection_id, g.project_id, g.name,
              r.name AS connection_name, b.is_default
         FROM user_config_group_bindings b
         JOIN config_groups g ON g.config_group_id = b.config_group_id
         JOIN studio_registrations r ON r.connection_id = g.connection_id
        WHERE b.user_id = ?
          AND g.status IN ('AVAILABLE', 'PARTIAL_FAILED')
          AND r.status = 'READY'
        ORDER BY b.is_default DESC, r.name, g.name`,
      [actor.userId],
    );
    return {
      items: rows.map(row => ({
        configGroupId: row.config_group_id,
        connectionId: row.connection_id,
        projectId: row.project_id,
        name: row.name,
        connectionName: row.connection_name,
        isDefault: Boolean(row.is_default),
      })),
    };
  });

  app.post('/api/admin/config-groups', async request => {
    const body = createGroupSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    const defaultConnection = await studioConnections.get(body.accountId);
    const connectionId = body.connectionId ?? defaultConnection?.connectionId;
    if (!connectionId) {
      throw new AppError(message('connections.required'), 409, 'STUDIO_NOT_CONFIGURED');
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
    return { items: await configGroups.list(query.accountId, requestLocale(request.headers['accept-language'])) };
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

  app.post('/api/admin/custom-models/test', async request => {
    const body = customModelTestSchema.parse(request.body);
    await auth.requireAdmin(request, body.accountId);
    await testCustomModelConnection(body);
    return { ok: true };
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
      .send(`\uFEFFloginName,displayName,password,configGroup,monthlyLimit\nworker,${translate('csv.exampleUser', requestLocale(request.headers['accept-language']))},password-123,${translate('csv.exampleGroup', requestLocale(request.headers['accept-language']))},100\n`);
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
      return message('csv.userCreated', { userId: result.userId });
    }, requestLocale(request.headers['accept-language']));
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
    const actor = await auth.requireAdmin(request, body.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError(message('pricing.systemAdminRequired'), 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    await billing.upsertPrice({ ...body, actor });
    return { success: true };
  });

  app.get('/api/admin/prices', async request => {
    const query = z.object({
      accountId: z.string().min(1).max(64),
      scopeType: z.enum(['CONFIG_GROUP', 'PLATFORM']),
      scopeId: z.string().min(1).max(64),
    }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.accountId);
    const [catalog, customCatalog, configuredResult, platformResult] = await Promise.all([
      studioConnections.billingCatalog(actor.accountId),
      derivedCustomBillingCatalog(database, config, actor.accountId),
      billing.listPrices(query.accountId, query.scopeType, query.scopeId, requestLocale(request.headers['accept-language'])) as Promise<{
        scopeName: string;
        items: Array<Record<string, unknown>>;
      }>,
      query.scopeType === 'CONFIG_GROUP'
        ? billing.listPrices(query.accountId, 'PLATFORM', '*', requestLocale(request.headers['accept-language'])) as Promise<{
          scopeName: string;
          items: Array<Record<string, unknown>>;
        }>
        : Promise.resolve({ scopeName: translate('pricing.platformDefault', requestLocale(request.headers['accept-language'])), items: [] }),
    ]);
    const configured = configuredResult.items;
    const platformPrices = platformResult.items;
    const platformByItem = new Map(platformPrices.map(item => [
      `${item.billingItemId}\0${item.unit}`,
      item,
    ]));
    const mergedCatalog = new Map<string, Record<string, unknown>>();
    for (const item of catalog) {
      mergedCatalog.set(`${item.billingItemId}\0${item.unit}`, { ...item, custom: false });
    }
    for (const item of customCatalog) {
      mergedCatalog.set(`${item.billingItemId}\0${item.unit}`, { ...item });
    }
    const catalogItems = [...mergedCatalog.values()].sort((left, right) =>
      String(left.billingItemId).localeCompare(String(right.billingItemId))
      || String(left.unit).localeCompare(String(right.unit)));
    const catalogKeys = new Set(catalogItems.map(item => `${item.billingItemId}\0${item.unit}`));
    const items: Array<Record<string, unknown>> = catalogItems.flatMap(catalogItem => {
      const matches = configured.filter(item => item.billingItemId === catalogItem.billingItemId
        && item.unit === catalogItem.unit);
      const inherited = platformByItem.get(`${catalogItem.billingItemId}\0${catalogItem.unit}`);
      const records: Array<Record<string, unknown>> = matches.length > 0 ? matches : [inherited ? {
        ...inherited,
        inherited: true,
        configured: false,
      } : {
        scopeType: null,
        scopeId: null,
        scopeName: null,
        billingItemId: catalogItem.billingItemId,
        unit: catalogItem.unit,
        customerUnitPrice: config.defaultPrices.customerUnitPrice,
        costUnitPrice: config.defaultPrices.costUnitPrice,
        enabled: false,
        configured: false,
        builtinDefault: true,
      }];
      return records.map(item => ({
        ...item,
        ...catalogItem,
        configured: matches.length > 0,
        custom: Boolean(catalogItem.custom),
      }));
    });
    for (const item of configured) {
      if (catalogKeys.has(`${item.billingItemId}\0${item.unit}`)) continue;
      items.push({
        ...item,
        operatorIds: [],
        connectionNames: [],
        configured: true,
        custom: true,
      });
    }
    for (const item of platformPrices) {
      const key = `${item.billingItemId}\0${item.unit}`;
      if (catalogKeys.has(key) || configured.some(current => `${current.billingItemId}\0${current.unit}` === key)) {
        continue;
      }
      items.push({
        ...item,
        operatorIds: [],
        connectionNames: [],
        configured: false,
        inherited: true,
        custom: true,
      });
    }
    return {
      scopeType: query.scopeType,
      scopeId: query.scopeId,
      scopeName: configuredResult.scopeName,
      items: actor.role === 'SYSTEM_ADMIN'
        ? items
        : items.map(({ costUnitPrice: _costUnitPrice, ...item }) => item),
    };
  });

  app.get('/api/admin/billing-catalog', async request => {
    const query = z.object({ accountId: z.string().min(1).max(64) }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    const [catalog, customCatalog] = await Promise.all([
      studioConnections.billingCatalog(query.accountId),
      derivedCustomBillingCatalog(database, config, query.accountId),
    ]);
    const merged = new Map<string, Record<string, unknown>>();
    for (const item of catalog) merged.set(`${item.billingItemId}\0${item.unit}`, { ...item, custom: false });
    for (const item of customCatalog) merged.set(`${item.billingItemId}\0${item.unit}`, { ...item });
    return {
      items: [...merged.values()].sort((left, right) =>
        String(left.billingItemId).localeCompare(String(right.billingItemId))
        || String(left.unit).localeCompare(String(right.unit))),
    };
  });

  app.delete('/api/admin/prices', async request => {
    const body = z.object({
      accountId: z.string().min(1).max(64),
      scopeType: z.enum(['CONFIG_GROUP', 'PLATFORM']),
      scopeId: z.string().min(1).max(64),
      billingItemId: z.string().min(1).max(128),
      unit: z.string().min(1).max(32),
    }).parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError(message('pricing.deleteAdminRequired'), 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    await billing.disablePrice(body);
    return { success: true };
  });

  app.get('/api/admin/prices/import-template', async (request, reply) => {
    const query = z.object({
      accountId: z.string().min(1).max(64),
      scopeType: z.enum(['CONFIG_GROUP', 'PLATFORM']).optional(),
      scopeId: z.string().min(1).max(64).optional(),
    }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError(message('pricing.bulkAdminRequired'), 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    const scopeType = query.scopeType ?? 'PLATFORM';
    const scopeId = query.scopeId ?? '*';
    if (scopeType === 'PLATFORM' && scopeId !== '*') {
      throw new AppError(message('pricing.invalidPlatformScope'), 400, 'INVALID_PRICE_SCOPE');
    }
    if (scopeType === 'CONFIG_GROUP') {
      await configGroups.resolveAvailableGroupId(actor.accountId, scopeId);
    }
    const [catalog, customCatalog, configuredResult] = await Promise.all([
      studioConnections.billingCatalog(actor.accountId).catch(() => []),
      derivedCustomBillingCatalog(database, config, actor.accountId),
      billing.listPrices(actor.accountId, scopeType, scopeId),
    ]);
    const configured = new Map(configuredResult.items.map(item => {
      const price = item as {
        billingItemId: string;
        unit: string;
        customerUnitPrice: string;
        costUnitPrice: string;
      };
      return [`${price.billingItemId}\0${price.unit}`, price];
    }));
    const merged = new Map<string, { billingItemId: string; unit: string }>();
    for (const item of catalog) merged.set(`${item.billingItemId}\0${item.unit}`, item);
    for (const item of customCatalog) merged.set(`${item.billingItemId}\0${item.unit}`, item);
    for (const item of configured.values()) merged.set(`${item.billingItemId}\0${item.unit}`, item);
    const rows = [...merged.values()]
      .map(item => {
        const price = configured.get(`${item.billingItemId}\0${item.unit}`);
        return `${item.billingItemId},${item.unit},${price?.customerUnitPrice ?? config.defaultPrices.customerUnitPrice},${price?.costUnitPrice ?? config.defaultPrices.costUnitPrice}`;
      })
      .join('\n');
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="studio-prices.csv"')
      .send(`\uFEFFbillingItemId,unit,customerUnitPrice,costUnitPrice\n${rows}\n`);
  });

  app.post('/api/admin/prices/import', async request => {
    const body = priceCsvImportSchema.parse(request.body);
    const actor = await auth.requireAdmin(request, body.accountId);
    if (actor.role !== 'SYSTEM_ADMIN') {
      throw new AppError(message('pricing.bulkAdminRequired'), 403, 'SYSTEM_ADMIN_REQUIRED');
    }
    if (body.scopeType === 'PLATFORM' && body.scopeId !== '*') {
      throw new AppError(message('pricing.invalidPlatformScope'), 400, 'INVALID_PRICE_SCOPE');
    }
    if (body.scopeType === 'CONFIG_GROUP') {
      await configGroups.resolveAvailableGroupId(body.accountId, body.scopeId);
    }
    const [catalog, customCatalog] = await Promise.all([
      studioConnections.billingCatalog(actor.accountId).catch(() => []),
      derivedCustomBillingCatalog(database, config, actor.accountId),
    ]);
    const supported = new Set([
      ...catalog.map(item => `${item.billingItemId}\0${item.unit}`),
      ...customCatalog.map(item => `${item.billingItemId}\0${item.unit}`),
    ]);
    const rows = parseCsvRecords(body.csv);
    return importCsvRows(rows, async row => {
      const parsed = priceCsvRowSchema.parse(row);
      if (!supported.has(`${parsed.billingItemId}\0${parsed.unit}`)) {
        return message('csv.unknownBillingItemSkipped');
      }
      await billing.upsertPrice({
        accountId: body.accountId,
        scopeType: body.scopeType,
        scopeId: body.scopeId,
        billingItemId: parsed.billingItemId,
        unit: parsed.unit,
        customerUnitPrice: parsed.customerUnitPrice,
        costUnitPrice: parsed.costUnitPrice,
        actor,
      });
      return message('csv.saved');
    }, requestLocale(request.headers['accept-language']));
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

  app.get('/api/admin/model-usage', async request => {
    const query = z.object({
      accountId: z.string().min(1).max(64),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      mode: z.enum(['detail', 'summary']).default('detail'),
      groupBy: z.enum(['billingItem', 'model', 'configGroup', 'subaccount', 'unit', 'status'])
        .default('billingItem'),
      billingItemId: z.string().max(128).optional(),
      modelId: z.string().max(128).optional(),
      configGroupId: z.string().max(64).optional(),
      userId: z.string().max(64).optional(),
      status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const actor = await auth.requireAdmin(request, query.accountId);
    return modelUsage.query(query, actor.role === 'SYSTEM_ADMIN', requestLocale(request.headers['accept-language']));
  });

  app.get('/api/admin/model-usage/:taskId/audit', async (request, reply) => {
    const params = z.object({
      taskId: z.string().min(1).max(64),
    }).parse(request.params);
    const query = z.object({
      accountId: z.string().min(1).max(64),
    }).parse(request.query);
    await auth.requireAdmin(request, query.accountId);
    const document = await modelUsage.auditDocument(query.accountId, params.taskId);
    const safeTaskId = params.taskId.replaceAll(/[^A-Za-z0-9._-]/g, '_');
    reply
      .type('application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="billing-audit-${safeTaskId}.json"`);
    return document;
  });

  app.post('/api/studio/tickets/launch', async request => {
    const actor = await auth.requireActor(request);
    const body = z.object({
      connectionId: z.string().min(1).max(64).optional(),
      configGroup: z.string().min(1).max(128).optional(),
    })
      .parse(request.body ?? {});
    return tickets.launch(actor, body.connectionId, body.configGroup);
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
    request.log.info({
      event: 'studio_usage_precheck_received',
      requestId: body.RequestId,
      httpRequestId: request.id,
      appId,
      connectionId: query.connection_id,
      userId: body.UserId,
      itemCount: body.Items.length,
    }, 'Studio usage precheck received');
    if (!await studioConnections.verifyCallbackToken(
      query.connection_id,
      appId,
      token,
      body.UserId,
    )) {
      throw new AppError(message('errors.studioUnauthorized'), 401, 'STUDIO_UNAUTHORIZED');
    }
    await billing.precheck(query.connection_id, appId, body, token);
    return { code: 200, message: 'success', requestId: body.RequestId };
  });

  app.post('/api/studio/baseline/tasks/callback', async request => {
    const query = z.object({ connection_id: z.string().min(1).max(64) }).parse(request.query);
    const appId = String(request.headers['x-app-id'] ?? '');
    const token = String(request.headers['x-las-api-key'] ?? '');
    const body = callbackSchema.parse(request.body) as BaselineCallbackInput;
    request.log.info({
      event: 'studio_usage_callback_received',
      requestId: body.RequestId,
      httpRequestId: request.id,
      appId,
      connectionId: query.connection_id,
      userId: body.UserId,
      status: body.Status,
      itemCount: body.Items.length,
    }, 'Studio usage callback received');
    if (!await studioConnections.verifyCallbackToken(
      query.connection_id,
      appId,
      token,
      body.UserId,
      body.RequestId,
    )) {
      throw new AppError(message('errors.studioUnauthorized'), 401, 'STUDIO_UNAUTHORIZED');
    }
    await billing.callback(query.connection_id, appId, body);
    return { code: 200, message: 'success', requestId: body.RequestId };
  });


  return app;
}
