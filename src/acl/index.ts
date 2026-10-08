/**
 * 审批权限 Harness：ACL 权限矩阵。
 *
 * 两维正交设计：
 *  1. 系统能力（角色）：谁能做系统级管理（配配置、管用户、看审计）
 *  2. 资源归属（授权）：谁能碰哪个资源（某个 SKU / 某个工作区）
 * 判断函数里绝不读「是不是 admin」来放行资源访问 —— admin 只有系统能力，
 * 在工作区/SKU 资源层没有旁路代码路径。
 */

export type Role = 'admin' | 'operator' | 'agent' | 'viewer';

export interface Principal {
  id: string;
  role: Role;
}

/** 补货动作集合 */
export type ActionType =
  | 'read_inventory' // 查询库存数据
  | 'generate_advice' // 生成补货建议
  | 'create_replenishment_order' // 创建补货单
  | 'adjust_price' // 调价
  | 'delist' // 下架
  | 'delete_data'; // 删除数据

/** 动作分级：自动 / 待审批 / 禁止 */
export type ActionLevel = 'AUTO' | 'APPROVAL' | 'BLOCKED';

/**
 * 动作分级矩阵：
 * - 数据查询与建议生成 = AUTO（AI 自动做）
 * - 补货单、调价、下架 = APPROVAL（有副作用可逆，需人工裁决）
 * - 删除 = BLOCKED（不可逆高危，连审批都不给）
 */
export const ACTION_LEVELS: Record<ActionType, ActionLevel> = {
  read_inventory: 'AUTO',
  generate_advice: 'AUTO',
  create_replenishment_order: 'APPROVAL',
  adjust_price: 'APPROVAL',
  delist: 'APPROVAL',
  delete_data: 'BLOCKED'
};

/** 每个动作需要的资源权限（资源归属维度） */
const ACTION_RESOURCE_PERMISSION: Record<ActionType, 'read' | 'advise' | 'execute'> = {
  read_inventory: 'read',
  generate_advice: 'advise',
  create_replenishment_order: 'execute',
  adjust_price: 'execute',
  delist: 'execute',
  delete_data: 'execute'
};

export type Permission = 'read' | 'advise' | 'approve' | 'execute' | 'delete';
export type ResourceType = 'sku' | 'workspace' | 'system';

export interface ResourceRef {
  type: ResourceType;
  id: string;
}

export interface AuthDecision {
  allowed: boolean;
  level: ActionLevel;
  reason: string;
}

/** 授权存储的抽象：提供「某主体对某资源拥有哪些权限」 */
export interface GrantStore {
  hasPermission(principalId: string, resourceType: ResourceType, resourceId: string, permission: Permission): boolean;
  /** 返回主体拥有的所有授权（用于测试审计） */
  grantsOf(principalId: string): { resourceType: ResourceType; resourceId: string; permission: Permission }[];
}

export class Acl {
  constructor(private grants: GrantStore) {}

  /** 动作分级（不涉及具体主体/资源） */
  levelOf(action: ActionType): ActionLevel {
    return ACTION_LEVELS[action];
  }

  /**
   * 判定某主体能否对某资源执行某动作。
   *
   * 关键不变量：
   *  - BLOCKED 动作永远拒绝，无任何旁路。
   *  - 资源归属检查只依据 grants（资源归属维度），不读 principal.role。
   *  - APPROVAL 动作：允许「提议/生成建议」，但「执行」必须在 authorize 之外
   *    由审批状态机 gate（见 runtime/workflow.ts），这里 execute 权限仅代表
   *    该主体有资格被批准后执行，不代表可以直接执行。
   */
  authorize(principal: Principal, action: ActionType, resource: ResourceRef): AuthDecision {
    const level = ACTION_LEVELS[action];

    if (level === 'BLOCKED') {
      return { allowed: false, level, reason: 'delete 为不可逆高危动作，BLOCKED，无审批通道' };
    }

    // 资源归属维度：主体必须持有该资源对应的权限（system 资源除外）
    if (resource.type !== 'system') {
      const needed = ACTION_RESOURCE_PERMISSION[action];
      const hasResource = this.grants.hasPermission(principal.id, resource.type, resource.id, needed);
      const hasWildcard = this.grants.hasPermission(principal.id, resource.type, '*', needed);
      if (!hasResource && !hasWildcard) {
        return {
          allowed: false,
          level,
          reason: `主体 ${principal.id} 对 ${resource.type}:${resource.id} 无 ${needed} 权限`
        };
      }
    }

    return { allowed: true, level, reason: 'ok' };
  }
}
