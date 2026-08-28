import { randomUUID } from 'node:crypto';

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

interface StudioRequestContext {
  operation: string;
  appId: string;
  userId?: string;
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
        'Studio API 调用失败: 网络错误',
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
          ? `Studio API 调用失败: ${upstream.message}`
          : `Studio API 调用失败: HTTP ${response.status}`,
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
    config: ResourceConfig;
  }): Promise<void> {
    await this.post(connection, '/integration/api/v1/user-profiles/upsert', {
      appId: input.appId,
      projectId: input.projectId,
      userId: input.userId,
      ...input.config,
    }, { operation: 'upsert_user_profile', appId: input.appId, userId: input.userId });
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
      throw new AppError('Studio 部署信息响应不完整', 502, 'STUDIO_DEPLOYMENT_PROFILE_INVALID');
    }
    return {
      region: profile.region,
      tosRegion: profile.tosRegion,
      requiredResourceFields: profile.requiredResourceFields,
    };
  }
}
