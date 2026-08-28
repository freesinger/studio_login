import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}


interface EncryptedPayload {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export function encryptJson(value: unknown, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const payload: EncryptedPayload = {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  };
  return JSON.stringify(payload);
}

export function decryptJson<T>(payloadText: string, key: Buffer): T {
  const payload = JSON.parse(payloadText) as EncryptedPayload;
  if (payload.v !== 1) throw new Error('不支持的配置密文版本');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const clear = Buffer.concat([
    decipher.update(Buffer.from(payload.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(clear) as T;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

const secretKeys = new Set([
  'lasApiKey',
  'arkApiKey',
  'tosAccessKey',
  'tosSecretKey',
  'secretKey',
]);

export function maskConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      secretKeys.has(key) && typeof nested === 'string' ? maskSecret(nested) : maskConfig(nested),
    ]),
  );
}
