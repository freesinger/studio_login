import type { RowDataPacket } from 'mysql2/promise';

import type { Database } from './db.js';
import { AppError } from './errors.js';

interface RateLimitRow extends RowDataPacket {
  request_count: number;
  window_started_at: Date;
}

export async function assertRateLimit(
  database: Database,
  input: { action: string; subject: string; limit: number; windowMs: number },
): Promise<void> {
  const now = new Date();
  await database.transaction(async tx => {
    const rows = await tx.query<RateLimitRow>(
      `SELECT request_count, window_started_at
         FROM api_rate_limits
        WHERE action = ? AND subject_key = ?
        FOR UPDATE`,
      [input.action, input.subject],
    );
    const current = rows[0];
    if (!current) {
      await tx.execute(
        `INSERT INTO api_rate_limits (action, subject_key, window_started_at, request_count)
         VALUES (?, ?, ?, 1)`,
        [input.action, input.subject, now],
      );
      return;
    }
    const sameWindow = now.getTime() - new Date(current.window_started_at).getTime() < input.windowMs;
    const nextCount = sameWindow ? Number(current.request_count) + 1 : 1;
    await tx.execute(
      `UPDATE api_rate_limits
          SET window_started_at = ?, request_count = ?
        WHERE action = ? AND subject_key = ?`,
      [sameWindow ? current.window_started_at : now, nextCount, input.action, input.subject],
    );
    if (nextCount > input.limit) {
      throw new AppError('操作过于频繁，请稍后再试', 429, 'RATE_LIMITED');
    }
  });
}
