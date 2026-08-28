export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'BAD_REQUEST',
  ) {
    super(message);
  }
}

export class StudioApiError extends AppError {
  constructor(
    message: string,
    readonly upstreamCode: string,
    readonly requestId: string,
    readonly upstreamStatus?: number,
  ) {
    super(message, 502, 'STUDIO_API_FAILED');
  }
}

export function asErrorMessage(error: unknown): string {
  return error instanceof AppError ? `${error.code}: ${error.message}` : 'unexpected error';
}

export function profileSyncError(error: unknown): {
  code: string;
  message: string;
  requestId: string | null;
} {
  if (error instanceof StudioApiError) {
    return {
      code: error.upstreamCode,
      message: error.message,
      requestId: error.requestId,
    };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, requestId: null };
  }
  return {
    code: 'PROFILE_SYNC_FAILED',
    message: 'Studio Profile 同步失败，请稍后重试',
    requestId: null,
  };
}
