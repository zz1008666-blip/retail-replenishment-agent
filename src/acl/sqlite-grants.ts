/**
 * 基于 SQLite acl_grant 表的授权存储实现。
 */
import type { DatabaseSync } from 'node:sqlite';
import type { GrantStore, Permission, ResourceType } from './index';

export class SqliteGrantStore implements GrantStore {
  constructor(private db: DatabaseSync) {}

  hasPermission(
    principalId: string,
    resourceType: ResourceType,
    resourceId: string,
    permission: Permission
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM acl_grant
         WHERE principal = ? AND resource_type = ? AND resource_id = ? AND permission = ?`
      )
      .get(principalId, resourceType, resourceId, permission);
    return row !== undefined;
  }

  grantsOf(principalId: string): { resourceType: ResourceType; resourceId: string; permission: Permission }[] {
    const rows = this.db
      .prepare(`SELECT resource_type, resource_id, permission FROM acl_grant WHERE principal = ?`)
      .all(principalId) as unknown as { resource_type: ResourceType; resource_id: string; permission: Permission }[];
    return rows.map((r) => ({
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      permission: r.permission
    }));
  }

  grant(principalId: string, resourceType: ResourceType, resourceId: string, permission: Permission): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO acl_grant (principal, resource_type, resource_id, permission)
         VALUES (?, ?, ?, ?)`
      )
      .run(principalId, resourceType, resourceId, permission);
  }

  revoke(principalId: string, resourceType: ResourceType, resourceId: string, permission: Permission): void {
    this.db
      .prepare(
        `DELETE FROM acl_grant WHERE principal = ? AND resource_type = ? AND resource_id = ? AND permission = ?`
      )
      .run(principalId, resourceType, resourceId, permission);
  }
}
