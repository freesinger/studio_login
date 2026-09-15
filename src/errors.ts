import { formatMessage, message, type Locale, type LocalizedMessage } from './i18n.js';

export class AppError extends Error {
  readonly localizedMessage: LocalizedMessage | null;

  constructor(
    description: LocalizedMessage | string,
    readonly statusCode = 400,
    readonly code = 'BAD_REQUEST',
    readonly details?: unknown,
  ) {
    super(formatMessage(description, 'zh-CN'));
    this.localizedMessage = typeof description === 'string' ? null : description;
  }

  localize(locale: Locale): string {
    return formatMessage(this.localizedMessage ?? this.message, locale);
  }
}

export class StudioApiError extends AppError {
  constructor(
    description: LocalizedMessage | string,
    readonly upstreamCode: string,
    readonly requestId: string,
    readonly upstreamStatus?: number,
  ) {
    super(description, 502, 'STUDIO_API_FAILED');
  }
}

// Operational logs retain readable canonical text, independently of UI locale.
export function asErrorMessage(error: unknown): string {
  return error instanceof AppError ? `${error.code}: ${error.message}` : 'unexpected error';
}

export function profileSyncError(error: unknown): {
  code: string;
  message: string;
  requestId: string | null;
} {
  if (error instanceof AppError) {
    return {
      code: error instanceof StudioApiError ? error.upstreamCode : error.code,
      message: error.message,
      requestId: error instanceof StudioApiError ? error.requestId : null,
    };
  }
  const description = message('errors.profileSyncFailed');
  return { code: 'PROFILE_SYNC_FAILED', message: formatMessage(description, 'zh-CN'), requestId: null };
}
