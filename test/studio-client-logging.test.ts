import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppLogger } from '../src/logging.js';
import { StudioAdminClient } from '../src/studio-client.js';

interface LogEntry {
  fields: Record<string, unknown>;
  message?: string;
}

function recordingLogger(entries: LogEntry[]): AppLogger {
  return {
    debug: () => undefined,
    info: (fields: unknown, message?: string) => {
      entries.push({ fields: fields as Record<string, unknown>, message });
    },
    warn: () => undefined,
    error: (fields: unknown, message?: string) => {
      entries.push({ fields: fields as Record<string, unknown>, message });
    },
  } as AppLogger;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StudioAdminClient logging', () => {
  it('sends project-level sharing when upserting a project profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      message: 'success',
      data: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StudioAdminClient();

    await client.upsertProjectProfile({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token',
    }, {
      appId: 'app-1',
      projectId: 'project-1',
      projectLevelSharing: true,
      config: {
        lasApiKey: 'las-secret',
        arkApiKey: 'ark-secret',
        tosBucketName: 'bucket-1',
      },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      appId: 'app-1',
      projectId: 'project-1',
      projectLevelSharing: true,
      tosBucketName: 'bucket-1',
    });
  });

  it('sends config-group sharing when upserting a user profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      message: 'success',
      data: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StudioAdminClient();

    await client.upsertUserProfile({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token',
    }, {
      appId: 'app-1',
      projectId: 'project-1',
      userId: 'worker-1',
      projectLevelSharing: true,
      config: {
        lasApiKey: 'las-secret',
        arkApiKey: 'ark-secret',
        tosBucketName: 'bucket-1',
      },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      appId: 'app-1',
      projectId: 'project-1',
      userId: 'worker-1',
      projectLevelSharing: true,
    });
  });

  it('reads the non-sensitive Studio deployment profile', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      message: 'success',
      data: {
        region: 'cn-beijing',
        tosRegion: 'cn-beijing',
        requiredResourceFields: ['lasApiKey', 'arkApiKey', 'tosBucketName'],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const client = new StudioAdminClient();

    await expect(client.getDeploymentProfile({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token-that-must-never-appear-in-logs',
    }, 'studio')).resolves.toEqual({
      region: 'cn-beijing',
      tosRegion: 'cn-beijing',
      requiredResourceFields: ['lasApiKey', 'arkApiKey', 'tosBucketName'],
    });
  });

  it('reads Studio resource profile for config group display', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      message: 'success',
      data: {
        tosBucketName: 'remote-bucket',
        tosEndpoint: 'https://tos.example.com',
        region: 'cn-beijing',
        customModels: [
          {
            name: 'remote-image',
            type: 'IMAGE',
            model: 'gpt-image-2',
            endpoint: 'https://api.example.com',
            apiKey: 'remote-key',
          },
        ],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StudioAdminClient();

    await expect(client.getResourceProfile({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token',
    }, {
      appId: 'app-1',
      projectId: 'project-1',
    })).resolves.toMatchObject({
      tosBucketName: 'remote-bucket',
      customModels: [
        expect.objectContaining({ name: 'remote-image', type: 'IMAGE' }),
      ],
    });

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://studio.example.com/integration/api/v1/resource-profiles/get');
    expect(JSON.parse(String(request.body))).toMatchObject({
      appId: 'app-1',
      scopeType: 'PROJECT',
      projectId: 'project-1',
    });
    expect(request.headers).toMatchObject({
      'content-type': 'application/json',
      'x-las-integration-token': 'integration-token',
    });
  });

  it('reports resource profile 404 as an unavailable optional capability', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 404,
      message: 'not found',
    }), { status: 404, headers: { 'content-type': 'application/json' } })));
    const client = new StudioAdminClient();

    await expect(client.getResourceProfile({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token',
    }, {
      appId: 'app-1',
      projectId: 'project-1',
    })).rejects.toMatchObject({
      code: 'STUDIO_RESOURCE_PROFILE_UNAVAILABLE',
      message: 'Studio 未开放远端资源配置读取接口，当前展示本地缓存',
    });
  });

  it('records actionable upstream error details without logging credentials or request bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 404,
      message: 'resource not found; token=top-secret',
      data: null,
    }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'x-request-id': 'studio-request-1' },
    })));
    const entries: LogEntry[] = [];
    const client = new StudioAdminClient(recordingLogger(entries));
    const integrationToken = 'integration-token-that-must-never-appear-in-logs';

    await expect(client.registerApplication({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken,
    }, {
      appId: 'studio',
      ticketUrl: 'https://login.example.com/api/internal/studio/tickets/verify?app_id=studio',
    })).rejects.toMatchObject({ code: 'STUDIO_API_FAILED' });

    const failure = entries.find(entry => entry.fields.event === 'studio_api_request_failed');
    expect(failure?.fields).toMatchObject({
      appId: 'studio',
      operation: 'register_ticket_config',
      path: '/integration/api/v1/app-ticket-configs/register',
      responseRequestId: 'studio-request-1',
      statusCode: 404,
      upstreamCode: '404',
      upstreamMessage: 'resource not found; token=[REDACTED]',
    });
    expect(JSON.stringify(entries)).not.toContain(integrationToken);
    expect(JSON.stringify(entries)).not.toContain('top-secret');
    expect(JSON.stringify(entries)).not.toContain('ticketUrl');
  });

  it('does not copy an unstructured upstream response into logs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'unexpected response containing a credential-shaped value',
      { status: 502 },
    )));
    const entries: LogEntry[] = [];
    const client = new StudioAdminClient(recordingLogger(entries));

    await expect(client.registerApplication({
      studioBaseUrl: 'https://studio.example.com',
      integrationToken: 'integration-token-that-must-never-appear-in-logs',
    }, {
      appId: 'studio',
      ticketUrl: 'https://login.example.com/ticket',
    })).rejects.toMatchObject({ code: 'STUDIO_API_FAILED' });

    expect(JSON.stringify(entries)).not.toContain('credential-shaped');
    expect(entries.find(entry => entry.fields.event === 'studio_api_request_failed')?.fields)
      .toMatchObject({ statusCode: 502, upstreamBodyBytes: 56 });
  });
});
