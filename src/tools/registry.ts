/**
 * Tool Registry：MCP 风格的工具登记簿。
 *
 * 关键能力：
 *  - 注册：把取数能力登记成标准化工具（含 inputSchema）。
 *  - 按 SKU 授权：每次调用都经过 ACL，只允许主体碰它被授权资源的工具。
 *  - Session 工具面裁剪：只向当前调查 Session 披露允许的数据入口。
 *  - fail-closed：未知工具 / 未授权调用返回 invalid_tool 错误，绝不默认放行。
 */
import type { ActionType, Acl, Principal } from '../acl';
import type { ResourceRef } from '../acl';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /** 是否被判定为 invalid_tool（未授权 / 未知工具） */
  invalidTool?: boolean;
}

export interface ToolContext {
  principal: Principal;
  /** 当前调查 Session 被授权触碰的 SKU 集合 */
  session: SessionScope;
}

export interface SessionScope {
  id: string;
  skuIds: string[];
}

export interface ToolDef<P = Record<string, unknown>> {
  name: string;
  description: string;
  /** JSON Schema：入参契约 */
  inputSchema: Record<string, unknown>;
  /** 该工具要读取的资源类型 */
  resourceType: 'sku' | 'system';
  /** 该工具对应的 ACL 动作 */
  requiredAction: ActionType;
  execute(params: P, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef<any>>();

  constructor(private acl: Acl) {}

  register(tool: ToolDef<any>): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDef<any> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef<any>[] {
    return Array.from(this.tools.values());
  }

  /** Session 工具面裁剪：只返回当前 session 可见（已授权资源）的工具 */
  listForSession(ctx: ToolContext): ToolDef<any>[] {
    return this.list().filter((tool) => this.visibleInSession(tool, ctx));
  }

  private visibleInSession(tool: ToolDef<any>, ctx: ToolContext): boolean {
    if (tool.resourceType === 'system') return true;
    // 工具要读 SKU 数据，session 必须被授权了至少一个 SKU
    return ctx.session.skuIds.length > 0;
  }

  /**
   * 调用工具：三层检查（授权 -> session 范围 -> 执行），fail-closed。
   * 返回 invalidTool=true 表示「看不到 / 调不了」，而非炸掉整个 Run。
   */
  async invoke(name: string, params: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `unknown tool: ${name}`, invalidTool: true };
    }

    // 1) ACL 授权（资源归属维度）
    const resource: ResourceRef = this.resourceOf(tool, params);
    const decision = this.acl.authorize(ctx.principal, tool.requiredAction, resource);
    if (!decision.allowed) {
      return { ok: false, error: decision.reason, invalidTool: true };
    }

    // 2) Session 范围：只允许触碰当前 session 被授权的 SKU
    if (tool.resourceType === 'sku') {
      const skuId = params['skuId'] as string | undefined;
      if (!skuId || !ctx.session.skuIds.includes(skuId)) {
        return { ok: false, error: `sku ${skuId} 不在当前 session 授权范围内`, invalidTool: true };
      }
    }

    // 3) 执行
    return tool.execute(params, ctx);
  }

  private resourceOf(tool: ToolDef<any>, params: Record<string, unknown>): ResourceRef {
    if (tool.resourceType === 'system') return { type: 'system', id: '*' };
    return { type: 'sku', id: (params['skuId'] as string) ?? '*' };
  }
}
