import { randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import type { RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import type { Database, DatabaseExecutor } from './db.js';
import { AppError } from './errors.js';
import { assertRateLimit } from './rate-limit.js';
import { randomToken, sha256 } from './security.js';
import type { Actor, UserRole } from './types.js';

export const SESSION_COOKIE_NAME = 'studio_login_session';

interface StateRow extends RowDataPacket {
  initialized: number;
}

interface UserRow extends RowDataPacket {
  user_id: string;
  account_id: string;
  login_name: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  user_status: string;
  account_status: string;
}

function toActor(row: UserRow): Actor {
  return {
    userId: row.user_id,
    accountId: row.account_id,
    loginName: row.login_name,
    displayName: row.display_name,
    role: row.role,
  };
}

async function findUser(
  tx: DatabaseExecutor,
  accountId: string,
  loginName: string,
): Promise<UserRow | undefined> {
  const rows = await tx.query<UserRow>(
    `SELECT u.user_id, u.account_id, u.login_name, u.display_name, u.password_hash,
            u.role, u.status AS user_status, a.status AS account_status
       FROM users u
       JOIN accounts a ON a.account_id = u.account_id
      WHERE u.account_id = ? AND u.login_name = ?
      LIMIT 1`,
    [accountId, loginName],
  );
  return rows[0];
}

export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
  ) {}

  async isInitialized(): Promise<boolean> {
    const rows = await this.database.query<StateRow>('SELECT initialized FROM system_state WHERE id = 1');
    return Boolean(rows[0]?.initialized);
  }

  async bootstrapConfiguredAdmin(): Promise<Actor> {
    const accountId = this.config.STUDIO_LOGIN_ACCOUNT_ID;
    const loginName = this.config.STUDIO_LOGIN_ADMIN_USERNAME;
    const passwordHash = await bcrypt.hash(this.config.STUDIO_LOGIN_ADMIN_PASSWORD, 12);
    return this.database.transaction(async tx => {
      const states = await tx.query<StateRow>('SELECT initialized FROM system_state WHERE id = 1 FOR UPDATE');
      const existingUsers = await tx.query<UserRow>(
        `SELECT u.user_id, u.account_id, u.login_name, u.display_name, u.password_hash,
                u.role, u.status AS user_status, a.status AS account_status
           FROM users u JOIN accounts a ON a.account_id = u.account_id
          WHERE u.account_id = ? AND u.login_name = ? FOR UPDATE`,
        [accountId, loginName],
      );
      const existing = existingUsers[0];
      if (Boolean(states[0]?.initialized) && !existing) {
        throw new AppError(
          '数据库已初始化，但配置的管理员不存在；拒绝自动创建第二个系统管理员',
          409,
          'BOOTSTRAP_ADMIN_MISMATCH',
        );
      }
      if (existing && existing.role !== 'SYSTEM_ADMIN') {
        throw new AppError('配置的启动管理员角色不是 SYSTEM_ADMIN', 409, 'BOOTSTRAP_ADMIN_MISMATCH');
      }

      await tx.execute(
        `INSERT INTO accounts (account_id, name, status) VALUES (?, ?, 'READY')
         ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'READY'`,
        [accountId, this.config.STUDIO_LOGIN_ACCOUNT_NAME],
      );
      const userId = existing?.user_id ?? `usr_${randomUUID().replaceAll('-', '')}`;
      if (existing) {
        await tx.execute(
          `UPDATE users SET display_name = ?, password_hash = ?, status = 'ACTIVE'
            WHERE user_id = ?`,
          [this.config.STUDIO_LOGIN_ADMIN_DISPLAY_NAME, passwordHash, userId],
        );
      } else {
        await tx.execute(
          `INSERT INTO users
            (user_id, account_id, login_name, display_name, password_hash, role, status)
           VALUES (?, ?, ?, ?, ?, 'SYSTEM_ADMIN', 'ACTIVE')`,
          [userId, accountId, loginName, this.config.STUDIO_LOGIN_ADMIN_DISPLAY_NAME, passwordHash],
        );
      }
      await tx.execute('UPDATE system_state SET initialized = TRUE WHERE id = 1');
      return {
        userId,
        accountId,
        loginName,
        displayName: this.config.STUDIO_LOGIN_ADMIN_DISPLAY_NAME,
        role: 'SYSTEM_ADMIN',
      };
    });
  }

  async login(input: {
    accountId: string;
    loginName: string;
    password: string;
    clientIp: string;
  }): Promise<{ token: string; actor: Actor; expiresAt: string }> {
    await assertRateLimit(this.database, {
      action: 'login',
      subject: `${input.accountId}:${input.loginName}:ip=${input.clientIp}`,
      limit: 10,
      windowMs: 10 * 60 * 1000,
    });
    const row = await findUser(this.database, input.accountId, input.loginName);
    const valid = row ? await bcrypt.compare(input.password, row.password_hash) : false;
    if (!row || !valid) {
      throw new AppError('账号或密码错误', 401, 'INVALID_CREDENTIALS');
    }
    if (row.user_status !== 'ACTIVE' || row.account_status !== 'READY') {
      throw new AppError('账号已停用', 403, 'ACCOUNT_DISABLED');
    }

    const token = randomToken();
    const expiresAt = new Date(Date.now() + this.config.STUDIO_LOGIN_SESSION_TTL_SECONDS * 1000);
    await this.database.execute(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
      [sha256(token), row.user_id, expiresAt],
    );
    return { token, actor: toActor(row), expiresAt: expiresAt.toISOString() };
  }

  async actorFromRequest(request: FastifyRequest): Promise<Actor | null> {
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const cookieToken = request.cookies[SESSION_COOKIE_NAME] ?? '';
    const token = bearer || cookieToken;
    if (!token) return null;

    const rows = await this.database.query<UserRow>(
      `SELECT u.user_id, u.account_id, u.login_name, u.display_name, u.password_hash,
              u.role, u.status AS user_status, a.status AS account_status
         FROM sessions s
         JOIN users u ON u.user_id = s.user_id
         JOIN accounts a ON a.account_id = u.account_id
        WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3)
        LIMIT 1`,
      [sha256(token)],
    );
    const row = rows[0];
    if (!row || row.user_status !== 'ACTIVE' || row.account_status !== 'READY') return null;
    return toActor(row);
  }

  async requireActor(request: FastifyRequest): Promise<Actor> {
    const actor = await this.actorFromRequest(request);
    if (!actor) throw new AppError('请先登录', 401, 'UNAUTHORIZED');
    return actor;
  }

  async requireAdmin(request: FastifyRequest, accountId?: string): Promise<Actor> {
    const actor = await this.requireActor(request);
    if (actor.role === 'SYSTEM_ADMIN') return actor;
    if (actor.role !== 'ACCOUNT_ADMIN' || (accountId && actor.accountId !== accountId)) {
      throw new AppError('需要管理员权限', 403, 'ADMIN_REQUIRED');
    }
    return actor;
  }

  async logout(request: FastifyRequest): Promise<void> {
    const authorization = request.headers.authorization ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const token = bearer || request.cookies[SESSION_COOKIE_NAME] || '';
    if (token) await this.database.execute('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  }
}
