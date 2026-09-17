import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';

import { createCanvas } from '@napi-rs/canvas';

import type { Database } from './db.js';
import { AppError } from './errors.js';
import { message } from './i18n.js';
import { assertRateLimit } from './rate-limit.js';
import { decryptJson, encryptJson } from './security.js';

const characters = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const lifetimeMs = 2 * 60 * 1000;

interface CaptchaPayload {
  id: string;
  answer: string;
  expiresAt: number;
}

function randomAnswer(): string {
  return Array.from({ length: 5 }, () => characters[randomInt(characters.length)]).join('');
}

async function renderImage(answer: string): Promise<Buffer> {
  const canvas = createCanvas(190, 64);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f1e8';
  ctx.fillRect(0, 0, 190, 64);
  for (let index = 0; index < 12; index++) {
    ctx.strokeStyle = index % 2 ? '#d7d0c3' : '#e2ac7a';
    ctx.lineWidth = 1 + randomInt(2);
    ctx.beginPath();
    ctx.moveTo(randomInt(190), randomInt(64));
    ctx.lineTo(randomInt(190), randomInt(64));
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 34px sans-serif';
  for (const [index, character] of [...answer].entries()) {
    ctx.save();
    ctx.translate(28 + index * 34 + randomInt(-3, 4), 33 + randomInt(-5, 6));
    ctx.rotate(randomInt(-18, 19) * Math.PI / 180);
    ctx.fillStyle = ['#263d4c', '#744026', '#3f4930'][randomInt(3)]!;
    ctx.fillText(character, 0, 0);
    ctx.restore();
  }
  return Buffer.from(await canvas.encode('png'));
}

function invalidCaptcha(): AppError {
  return new AppError(message('auth.captchaInvalid'), 400, 'INVALID_CAPTCHA');
}

export class CaptchaService {
  constructor(
    private readonly database: Database,
    private readonly encryptionKey: Buffer,
    private readonly createAnswer: () => string = randomAnswer,
  ) {}

  async issue(clientIp: string): Promise<{ captchaToken: string; image: string }> {
    await assertRateLimit(this.database, {
      action: 'captcha-issue-ip', subject: clientIp, limit: 30, windowMs: 10 * 60 * 1000,
    });
    if (randomInt(100) === 0) {
      await this.database.execute(
        `DELETE FROM api_rate_limits
          WHERE updated_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 10 MINUTE)
            AND action IN ('login-captcha-used', 'captcha-issue-ip', 'login-ip', 'login')
          LIMIT 1000`,
      );
    }
    const answer = this.createAnswer();
    if (!new RegExp(`^[${characters}]{5}$`).test(answer)) throw new Error('Invalid captcha answer generator');
    const captchaToken = encryptJson({
      id: randomUUID(), answer, expiresAt: Date.now() + lifetimeMs,
    } satisfies CaptchaPayload, this.encryptionKey);
    return { captchaToken, image: `data:image/png;base64,${(await renderImage(answer)).toString('base64')}` };
  }

  async verify(captchaToken: string, captchaCode: string): Promise<void> {
    let payload: CaptchaPayload;
    try {
      payload = decryptJson<CaptchaPayload>(captchaToken, this.encryptionKey);
    } catch {
      throw invalidCaptcha();
    }
    if (!payload || typeof payload.id !== 'string' || typeof payload.answer !== 'string'
        || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now()) {
      throw invalidCaptcha();
    }
    try {
      await this.database.execute(
        `INSERT INTO api_rate_limits (action, subject_key, window_started_at, request_count)
         VALUES ('login-captcha-used', ?, CURRENT_TIMESTAMP(3), 1)`,
        [payload.id],
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw invalidCaptcha();
      throw error;
    }
    const expected = Buffer.from(payload.answer);
    const received = Buffer.from(captchaCode.trim().toUpperCase());
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw invalidCaptcha();
    }
  }
}
