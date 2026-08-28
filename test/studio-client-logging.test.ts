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
