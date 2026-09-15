import { randomUUID } from 'node:crypto';

import { message } from './i18n.js';
import { AppError, StudioApiError } from './errors.js';
import { noopLogger, type AppLogger } from './logging.js';
import type { ResourceConfig } from './types.js';

export interface StudioConnection {
  studioBaseUrl: string;
  integrationToken: string;
}

export interface StudioDeploymentProfile {
  region: string;
  tosRegion: string;
  requiredResourceFields: string[];
}

export interface StudioResourceProfile {
  lasBaseUrl?: string;
  tosBucketName?: string;
  tosUploadPrefix?: string;
  tosRegion?: string;
  tosEndpoint?: string;
  outputTosPath?: string;
  region?: string;
  customModels?: unknown;
}

export interface StudioBillingCatalogItem {
  billingItemId: string;
  unit: string;
  operatorIds: string[];
}

export class StudioResourceProfileUnavailableError extends AppError {
  constructor(readonly requestId: string) {
    super(message('groups.remoteProfileUnavailable'), 200, 'STUDIO_RESOURCE_PROFILE_UNAVAILABLE');
  }
}

interface StudioRequestContext {
  operation: string;
  appId: string;
  userId?: string;
  projectId?: string;
}

function safeUpstreamMessage(value: unknown, integrationToken: string): string | null {
  if (typeof value !== 'string') return null;
  let message = value.replaceAll(integrationToken, '[REDACTED]');
  message = message.replace(
    /((?:authorization|token|api[-_ ]?key|secret|password)\s*[:=]\s*)[^\s,;]+/gi,
    '$1[REDACTED]',
  );
  message = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return message ? message.slice(0, 512) : null;
}

function parseUpstreamError(body: string, integrationToken: string): {
  code: string;
  message: string | null;
} {
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    const rawCode = payload.code;
    return {
      code: typeof rawCode === 'string' || typeof rawCode === 'number'
        ? String(rawCode).slice(0, 128)
        : 'STUDIO_API_ERROR',
      message: safeUpstreamMessage(payload.message, integrationToken),
    };
  } catch {
    return { code: 'STUDIO_API_ERROR', message: null };
  }
}

export class StudioAdminClient {
  constructor(private readonly logger: AppLogger = noopLogger) {}

  private async post(
    connection: StudioConnection,
    path: string,
    body: unknown,
    context: StudioRequestContext,
  ): Promise<Response> {
    const requestId = `sl_${randomUUID()}`;
    const startedAt = Date.now();
    const targetOrigin = new URL(connection.studioBaseUrl).origin;
    this.logger.info({
      event: 'studio_api_request_started',
      ...context,
      method: 'POST',
      path,
      requestId,
      targetOrigin,
    }, 'Studio API request started');

    let response: Response;
    try {
      response = await fetch(`${connection.studioBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-las-integration-token': connection.integrationToken,
          'x-request-id': requestId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      this.logger.error({
        err: error,
        event: 'studio_api_request_failed',
        ...context,
        durationMs: Date.now() - startedAt,
        method: 'POST',
        path,
        requestId,
        targetOrigin,
      }, 'Studio API network request failed');
      throw new StudioApiError(
        message('studio.networkError'),
        'STUDIO_NETWORK_ERROR',
        requestId,
      );
    }

    if (!response.ok) {
      const responseBody = await response.text();
      const upstream = parseUpstreamError(responseBody, connection.integrationToken);
      const responseRequestId = response.headers.get('x-request-id')?.slice(0, 255) || requestId;
      this.logger.error({
        event: 'studio_api_request_failed',
        ...context,
        upstreamBodyBytes: Buffer.byteLength(responseBody),
        upstreamCode: upstream.code,
        upstreamMessage: upstream.message ?? undefined,
        durationMs: Date.now() - startedAt,
        method: 'POST',
        path,
        requestId,
        responseRequestId,
        statusCode: response.status,
        targetOrigin,
      }, 'Studio API returned an error response');
      throw new StudioApiError(
        upstream.message
          ? message('studio.upstreamError', { message: upstream.message })
          : message('studio.httpError', { status: response.status }),
        upstream.code,
        responseRequestId,
        response.status,
      );
    }

    this.logger.info({
      event: 'studio_api_request_completed',
      ...context,
      durationMs: Date.now() - startedAt,
      method: 'POST',
      path,
      requestId,
      responseRequestId: response.headers.get('x-request-id') ?? undefined,
      statusCode: response.status,
      targetOrigin,
    }, 'Studio API request completed');
    return response;
  }

  async registerApplication(connection: StudioConnection, input: {
    appId: string;
    ticketUrl: string;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/app-ticket-configs/register', {
      appId: input.appId,
      ticketUrl: input.ticketUrl,
      fieldMapping: null,
    }, { operation: 'register_ticket_config', appId: input.appId });
  }

  async registerUsageEndpoint(connection: StudioConnection, input: {
    appId: string;
    estimateUrl: string;
    actualUrl: string;
    lasApiKey: string;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/usage-endpoints/register', {
      appId: input.appId,
      estimateUrl: input.estimateUrl,
      actualUrl: input.actualUrl,
      lasApiKey: input.lasApiKey,
    }, { operation: 'register_usage_endpoint', appId: input.appId });
  }

  async upsertUserProfile(connection: StudioConnection, input: {
    appId: string;
    projectId: string;
    userId: string;
    projectLevelSharing: boolean;
    config: ResourceConfig;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/user-profiles/upsert', {
      appId: input.appId,
      projectId: input.projectId,
      userId: input.userId,
      projectLevelSharing: input.projectLevelSharing,
      ...input.config,
    }, {
      operation: 'upsert_user_profile',
      appId: input.appId,
      userId: input.userId,
      projectId: input.projectId,
    });
  }

  async upsertProjectProfile(connection: StudioConnection, input: {
    appId: string;
    projectId: string;
    projectLevelSharing: boolean;
    config: ResourceConfig;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/user-profiles/upsert', {
      appId: input.appId,
      projectId: input.projectId,
      projectLevelSharing: input.projectLevelSharing,
      ...input.config,
    }, {
      operation: 'upsert_project_profile',
      appId: input.appId,
      projectId: input.projectId,
    });
  }

  async deleteUserProfile(connection: StudioConnection, input: {
    appId: string;
    projectId: string;
    userId: string;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/user-profiles/delete', input, {
      operation: 'delete_user_profile',
      appId: input.appId,
      userId: input.userId,
    });
  }

  async unregisterApplication(connection: StudioConnection, appId: string): Promise<void> {
    await this.post(connection, '/integration/api/v1/applications/unregister', { appId }, {
      operation: 'unregister_application',
      appId,
    });
  }

  async getDeploymentProfile(
    connection: StudioConnection,
    appId: string,
  ): Promise<StudioDeploymentProfile> {
    const response = await this.post(connection, '/integration/api/v1/deployment-profile/get', {
      appId,
    }, { operation: 'get_deployment_profile', appId });
    const payload = await response.json() as { data?: Partial<StudioDeploymentProfile> };
    const profile = payload.data;
    if (!profile?.region || !profile.tosRegion || !Array.isArray(profile.requiredResourceFields)) {
      throw new AppError(message('studio.invalidDeploymentProfile'), 502, 'STUDIO_DEPLOYMENT_PROFILE_INVALID');
    }
    return {
      region: profile.region,
      tosRegion: profile.tosRegion,
      requiredResourceFields: profile.requiredResourceFields,
    };
  }

  async getResourceProfile(
    connection: StudioConnection,
    input: {
      appId: string;
      projectId: string;
    },
  ): Promise<StudioResourceProfile> {
    let response: Response;
    try {
      response = await this.post(connection, '/integration/api/v1/resource-profiles/get', {
        appId: input.appId,
        scopeType: 'PROJECT',
        projectId: input.projectId,
      }, { operation: 'get_resource_profile', appId: input.appId });
    } catch (error) {
      if (error instanceof StudioApiError && error.upstreamStatus === 404) {
        throw new StudioResourceProfileUnavailableError(error.requestId);
      }
      throw error;
    }
    const payload = await response.json() as { data?: Record<string, unknown> | null };
    const profile = payload.data;
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
    return {
      ...(typeof profile.lasBaseUrl === 'string' ? { lasBaseUrl: profile.lasBaseUrl } : {}),
      ...(typeof profile.tosBucketName === 'string' ? { tosBucketName: profile.tosBucketName } : {}),
      ...(typeof profile.tosUploadPrefix === 'string' ? { tosUploadPrefix: profile.tosUploadPrefix } : {}),
      ...(typeof profile.tosRegion === 'string' ? { tosRegion: profile.tosRegion } : {}),
      ...(typeof profile.tosEndpoint === 'string' ? { tosEndpoint: profile.tosEndpoint } : {}),
      ...(typeof profile.outputTosPath === 'string' ? { outputTosPath: profile.outputTosPath } : {}),
      ...(typeof profile.region === 'string' ? { region: profile.region } : {}),
      ...(profile.customModels !== undefined ? { customModels: profile.customModels } : {}),
    };
  }

  async getBillingCatalog(
    connection: StudioConnection,
    appId: string,
  ): Promise<StudioBillingCatalogItem[]> {
    const response = await this.post(connection, '/integration/api/v1/billing-catalog/get', {
      appId,
    }, { operation: 'get_billing_catalog', appId });
    const payload = await response.json() as { data?: { items?: unknown } };
    if (!Array.isArray(payload.data?.items)) {
      throw new AppError(message('studio.invalidBillingCatalog'), 502, 'STUDIO_BILLING_CATALOG_INVALID');
    }
    return payload.data.items.map(item => {
      const value = item as Partial<StudioBillingCatalogItem>;
      if (!value.billingItemId || !value.unit || !Array.isArray(value.operatorIds)) {
        throw new AppError(message('studio.invalidBillingCatalog'), 502, 'STUDIO_BILLING_CATALOG_INVALID');
      }
      return {
        billingItemId: value.billingItemId,
        unit: value.unit,
        operatorIds: value.operatorIds.filter(operatorId => typeof operatorId === 'string'),
      };
    });
  }
}
