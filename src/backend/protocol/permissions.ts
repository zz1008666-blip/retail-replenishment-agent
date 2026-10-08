/**
 * 平台级系统能力权限（照搬自 MiniClaw `src/permissions.ts`，替换为补货平台语义）。
 *
 * 注意与 `src/acl/index.ts` 的分工（两维正交，MiniClaw 同款思想）：
 *   - 这一维 = 系统能力（角色）：谁能做平台级管理（配规则、管用户、看审计、管计费）。
 *     `hasPermission` 里 `role === 'admin'` 对系统能力放行 —— 这是 admin 的「系统能力」。
 *   - 另一维 = 资源归属（授权）：谁能碰某个 SKU / 工作区。
 *     见 `src/acl/index.ts` 的 `Acl.authorize()`，它绝不读 `principal.role`（无 admin 旁路）。
 *
 * MiniClaw 原文中的 `Permission` 就是系统能力清单，这里为避免与资源动作
 * `acl.Permission`（read/advise/execute…）重名，改名为 `SystemPermission`。
 */

export type SystemPermission =
  | 'manage_sku_catalog' // 管理 SKU 目录（增删改商品主数据）
  | 'manage_replenishment_rules' // 管理补货规则与参数（阈值、目标覆盖天数等）
  | 'manage_schedule' // 管理巡检/补货调度（cron 任务）
  | 'manage_users' // 管理用户与角色
  | 'view_audit_log' // 查看审计日志
  | 'manage_billing'; // 计费配置

export type PlatformRole = 'admin' | 'member';

export type PermissionTemplateKey =
  | 'admin_full'
  | 'member_basic'
  | 'warehouse_manager'
  | 'approver';

export const ALL_SYSTEM_PERMISSIONS: SystemPermission[] = [
  'manage_sku_catalog',
  'manage_replenishment_rules',
  'manage_schedule',
  'manage_users',
  'view_audit_log',
  'manage_billing'
];

export const PERMISSION_TEMPLATES: Record<
  PermissionTemplateKey,
  {
    key: PermissionTemplateKey;
    label: string;
    role: PlatformRole;
    permissions: SystemPermission[];
  }
> = {
  admin_full: {
    key: 'admin_full',
    label: '管理员（全权限）',
    role: 'admin',
    permissions: [...ALL_SYSTEM_PERMISSIONS]
  },
  member_basic: {
    key: 'member_basic',
    label: '运营人员（基础权限，资源访问走授权）',
    role: 'member',
    permissions: []
  },
  warehouse_manager: {
    key: 'warehouse_manager',
    label: '仓配管理（商品目录 + 调度）',
    role: 'member',
    permissions: ['manage_sku_catalog', 'manage_schedule']
  },
  approver: {
    key: 'approver',
    label: '审批员（可查看审计日志）',
    role: 'member',
    permissions: ['view_audit_log']
  }
};

export const ROLE_DEFAULT_PERMISSIONS: Record<PlatformRole, SystemPermission[]> = {
  admin: [...ALL_SYSTEM_PERMISSIONS],
  member: []
};

export function normalizeSystemPermissions(input: unknown): SystemPermission[] {
  if (!Array.isArray(input)) return [];
  const set = new Set<SystemPermission>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    if ((ALL_SYSTEM_PERMISSIONS as string[]).includes(value)) {
      set.add(value as SystemPermission);
    }
  }
  return Array.from(set);
}

export function getDefaultPermissions(role: PlatformRole): SystemPermission[] {
  return [...(ROLE_DEFAULT_PERMISSIONS[role] || [])];
}

export function resolveTemplate(
  template: PermissionTemplateKey | undefined
): { role: PlatformRole; permissions: SystemPermission[] } | null {
  if (!template) return null;
  const item = PERMISSION_TEMPLATES[template];
  if (!item) return null;
  return { role: item.role, permissions: [...item.permissions] };
}

/**
 * 系统能力判定：admin 放行（这是 admin 的「系统能力」维度，与资源维度无关）。
 * 资源级授权（能否碰某 SKU）不经过这里 —— 见 src/acl/index.ts。
 */
export function hasSystemPermission(
  user: { role: PlatformRole; permissions: SystemPermission[] },
  permission: SystemPermission
): boolean {
  if (user.role === 'admin') return true;
  return user.permissions.includes(permission);
}