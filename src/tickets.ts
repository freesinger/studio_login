import type { RowDataPacket } from 'mysql2/promise';

import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { AppError } from './errors.js';
import { randomToken, sha256 } from './security.js';
import { StudioConnectionService } from './studio-connections.js';
import type { Actor } from './types.js';

interface LaunchRow extends RowDataPacket {
  status: string;
  login_name: string;
  config_group_id: string | null;
  connection_id: string | null;
  project_id: string | null;
  profile_sync_version: number | null;
  current_version: number | null;
  registration_status: string | null;
  connection_app_id: string | null;
}

interface TicketRow extends RowDataPacket {
  user_id: string;
  login_name: string;
  app_id: string;
  account_id: string;
  project_id: string;
}

export class TicketService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly studioConnections: StudioConnectionService,
  ) {}

  async launch(
    actor: Actor,
    connectionId?: string,
    configGroup?: string,
  ): Promise<{ launchUrl: string; expiresAt: string }> {
    if (actor.role !== 'SUBACCOUNT') {
      throw new AppError('管理员账号仅用于管理，请使用企业子账号进入 Studio', 403, 'STUDIO_CREATOR_ACCOUNT_REQUIRED');
    }
    const rows = await this.database.query<LaunchRow>(
      `SELECT u.status, u.login_name, b.config_group_id, b.profile_sync_version, g.current_version,
              g.connection_id, g.project_id, r.status AS registration_status,
              r.app_id AS connection_app_id
         FROM users u
         JOIN user_config_group_bindings b ON b.user_id = u.user_id
         JOIN config_groups g ON g.config_group_id = b.config_group_id
         JOIN studio_registrations r ON r.connection_id = g.connection_id
        WHERE u.user_id = ? AND u.account_id = ?
          AND (? IS NULL OR g.connection_id = ?)
          AND (? IS NULL OR g.name = ? OR g.project_id = ?)`,
      [
        actor.userId,
        actor.accountId,
        connectionId ?? null,
        connectionId ?? null,
        configGroup ?? null,
        configGroup ?? null,
        configGroup ?? null,
      ],
    );
    const row = rows[0];
    if (!row || row.status !== 'ACTIVE' || row.registration_status !== 'READY') {
      throw new AppError('账号或 Studio 配置未就绪', 409, 'STUDIO_LOGIN_NOT_READY');
    }
    if (!row.config_group_id || !row.connection_id || !row.project_id || !row.connection_app_id) {
      throw new AppError('资源配置尚未同步', 409, 'PROFILE_NOT_SYNCED');
    }

    const ticket = randomToken();
    const expiresAt = new Date(Date.now() + this.config.STUDIO_LOGIN_TICKET_TTL_SECONDS * 1000);
    await this.database.transaction(async tx => {
      await tx.execute(
        `DELETE FROM studio_login_tickets
          WHERE expires_at <= UTC_TIMESTAMP(3)
             OR consumed_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 DAY)`,
      );
      await tx.execute(
        `INSERT INTO studio_login_tickets
          (ticket_hash, connection_id, app_id, user_id, project_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          sha256(ticket),
          row.connection_id,
          row.connection_app_id,
          actor.userId,
          row.project_id,
          expiresAt,
        ],
      );
    });

    const entry = await this.studioConnections.entryConnection(actor.accountId, row.connection_id);
    const url = new URL(entry.studioBaseUrl);
    url.searchParams.set('ticket', ticket);
    url.searchParams.set('app_id', entry.appId);
    return { launchUrl: url.toString(), expiresAt: expiresAt.toISOString() };
  }

  async consume(ticket: string, expectedAppId: string, expectedConnectionId: string): Promise<{
    userId: string;
    accountId: string;
    projectId: string;
    appId: string;
  }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      throw new AppError('ticket invalid', 401, 'INVALID_STUDIO_TICKET');
    }
    return this.database.transaction(async tx => {
      const rows = await tx.query<TicketRow>(
        `SELECT t.user_id, t.app_id, u.login_name, u.account_id, t.project_id
           FROM studio_login_tickets t
           JOIN users u ON u.user_id = t.user_id
           JOIN user_config_group_bindings b ON b.user_id = u.user_id
           JOIN config_groups g ON g.config_group_id = b.config_group_id
             AND g.connection_id = t.connection_id
             AND g.project_id = t.project_id
           JOIN studio_registrations r ON r.connection_id = t.connection_id
          WHERE t.ticket_hash = ?
            AND t.connection_id = ?
            AND t.app_id = ?
            AND r.app_id = ?
            AND u.status = 'ACTIVE'
            AND g.status IN ('AVAILABLE', 'PARTIAL_FAILED')
            AND r.status = 'READY'
            AND t.consumed_at IS NULL
            AND t.expires_at > UTC_TIMESTAMP(3)
          FOR UPDATE`,
        [sha256(ticket), expectedConnectionId, expectedAppId, expectedAppId],
      );
      const row = rows[0];
      if (!row) throw new AppError('ticket invalid', 401, 'INVALID_STUDIO_TICKET');
      const result = await tx.execute(
        `UPDATE studio_login_tickets SET consumed_at = UTC_TIMESTAMP(3)
          WHERE ticket_hash = ? AND consumed_at IS NULL`,
        [sha256(ticket)],
      );
      if (result.affectedRows !== 1) {
        throw new AppError('ticket invalid', 401, 'INVALID_STUDIO_TICKET');
      }
      return {
        userId: row.login_name,
        accountId: row.account_id,
        projectId: row.project_id,
        appId: row.app_id,
      };
    });
  }
}
