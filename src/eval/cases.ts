/**
 * 20 条本地 case：单机、离线、确定性可复现。
 * 覆盖六类故障样例（缺货误报 / SKU 错配 / 促销叠加 / 毛利约束冲突 / 审批拒绝 / 工具重试）
 * 与关键机制（Cron 双层模型 / CAS / FTS5 / 审批恢复 / 幂等 / ACL 无旁路）。
 */
import type { App } from '../app';
import type { Principal } from '../acl';
import type { SessionScope } from '../tools/registry';
import type { BackendData } from '../adapters/mock-backend';
import type { CaseRecord } from '../memory/case';
import type { RunReport, Expectations } from './assertions';
import { evaluate } from './assertions';
import { CaseConflictError } from '../memory/case';
import type { WorkflowResult } from '../runtime/workflow';

export interface ScenarioCase {
  kind: 'scenario';
  id: string;
  name: string;
  category: string;
  description: string;
  expectation: Expectations;
  run(app: App): Promise<RunReport>;
  customCheck?: (report: RunReport) => { pass: boolean; detail: string };
}

export interface MechanismCase {
  kind: 'mechanism';
  id: string;
  name: string;
  category: string;
  description: string;
  run(app: App): Promise<void>; // 抛错即失败
}

export type TestCase = ScenarioCase | MechanismCase;

// ---------- 通用构造 ----------

const OPERATOR: Principal = { id: 'operator-1', role: 'operator' };
const ADMIN: Principal = { id: 'admin-1', role: 'admin' };

function sessionFor(skuIds: string[]): SessionScope {
  return { id: 'sess-1', skuIds };
}

function grantSku(app: App, principalId: string, skuId: string): void {
  for (const p of ['read', 'advise', 'execute'] as const) {
    app.grants.grant(principalId, 'sku', skuId, p);
  }
}

/** 标准缺货 SKU 的种子数据（可售 25 < ROP 100，日常缺货） */
function baseSeed(skuId: string): BackendData {
  return {
    BI: { sku: skuId, avg_daily_sales: 20, sales_window_days: 7 },
    ERP: { item_code: skuId, on_hand_qty: 30, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 },
    INVENTORY: { sku_id: skuId, available: 25, in_transit: 0, safety_stock: 30, reorder_point: 100 },
    SALES: { sku: skuId, daily_units: 20, window_days: 7, as_of: new Date().toISOString() },
    PROMOTION: { sku: skuId, active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
  };
}

/** 正常水位 SKU（可售 500 > ROP，库销比 25 < 60，无异常） */
function normalSeed(skuId: string): BackendData {
  const s = baseSeed(skuId);
  s.ERP = { item_code: skuId, on_hand_qty: 500, reserved_qty: 0, lead_time_days: 7, unit_cost: 50, unit_price: 80 };
  s.INVENTORY = { sku_id: skuId, available: 500, in_transit: 0, safety_stock: 30, reorder_point: 100 };
  return s;
}

/** 积压 SKU（可售 2000，库销比 200 天） */
function overstockSeed(skuId: string): BackendData {
  const s = baseSeed(skuId);
  s.BI = { sku: skuId, avg_daily_sales: 10, sales_window_days: 7 };
  s.ERP = { item_code: skuId, on_hand_qty: 2000, reserved_qty: 0, lead_time_days: 7, unit_cost: 50, unit_price: 80 };
  s.INVENTORY = { sku_id: skuId, available: 2000, in_transit: 0, safety_stock: 30, reorder_point: 100 };
  s.SALES = { sku: skuId, daily_units: 10, window_days: 7, as_of: new Date().toISOString() };
  return s;
}

function reportFrom(app: App, wf: WorkflowResult): RunReport {
  const approvalEv = app.trace.byType('approval').at(-1);
  return {
    skuId: wf.skuId,
    status: wf.status,
    decision: wf.decision,
    trace: app.trace.all(),
    executedActions: app.sideEffects.map((s) => s.action),
    approvalStatus: approvalEv ? (approvalEv.data['status'] as string) : undefined
  };
}

/** 跑巡检，可随后批准/拒绝，返回 RunReport */
async function runInspect(
  app: App,
  skuId: string,
  principal: Principal,
  opts: { approve?: boolean; reject?: boolean; doubleApprove?: boolean } = {}
): Promise<RunReport> {
  grantSku(app, principal.id, skuId);
  const inspectWf = await app.workflow.inspect(skuId, principal, sessionFor([skuId]));
  let finalWf = inspectWf;
  if (opts.approve) {
    finalWf = await app.workflow.approve(inspectWf.turnRunId, 'approver-1', '同意');
  } else if (opts.reject) {
    finalWf = await app.workflow.reject(inspectWf.turnRunId, 'approver-1', '库存预算不足，拒绝');
  } else if (opts.doubleApprove) {
    finalWf = await app.workflow.approve(inspectWf.turnRunId, 'approver-1', '同意');
    let threw = false;
    try {
      await app.workflow.approve(inspectWf.turnRunId, 'approver-1', '重复审批');
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('二次审批应被拒绝（非待审批状态），但未抛错');
  }
  const report = reportFrom(app, finalWf);
  // 审批/拒绝后的结果不含 decision，保留巡检阶段的决策结论
  report.decision = inspectWf.decision;
  return report;
}

// ---------- 20 条 case ----------

export const CASES: TestCase[] = [
  // 1 · 正常缺货 → 补货建议 + 审批执行
  {
    kind: 'scenario',
    id: 'case-01',
    name: '正常缺货生成补货单',
    category: '正常路径',
    description: '可售低于再订货点，生成补货建议，人工批准后执行',
    expectation: {
      skuId: 'SKU-1001',
      expectedAnomaly: 'stockout',
      expectedAction: 'create_replenishment_order',
      expectedStatus: 'done'
    },
    run: async (app) => {
      app.backend.seed('SKU-1001', baseSeed('SKU-1001'));
      return runInspect(app, 'SKU-1001', OPERATOR, { approve: true });
    }
  },

  // 2 · 积压 → 调价建议 + 审批执行
  {
    kind: 'scenario',
    id: 'case-02',
    name: '积压调价清库存',
    category: '正常路径',
    description: '可售天数超阈值，建议调价清库存，批准后执行',
    expectation: {
      skuId: 'SKU-1002',
      expectedAnomaly: 'overstock',
      expectedAction: 'adjust_price',
      expectedStatus: 'done'
    },
    run: async (app) => {
      app.backend.seed('SKU-1002', overstockSeed('SKU-1002'));
      return runInspect(app, 'SKU-1002', OPERATOR, { approve: true });
    }
  },

  // 3 · 正常水位 → 无动作
  {
    kind: 'scenario',
    id: 'case-03',
    name: '库存正常无动作',
    category: '正常路径',
    description: '库存水位正常，不产生任何动作',
    expectation: {
      skuId: 'SKU-1003',
      expectedAnomaly: 'none',
      expectedAction: 'none',
      expectedStatus: 'done',
      mustNotExecute: true
    },
    run: async (app) => {
      app.backend.seed('SKU-1003', normalSeed('SKU-1003'));
      return runInspect(app, 'SKU-1003', OPERATOR);
    }
  },

  // 4 · 缺货误报（促销中库存正常）
  {
    kind: 'scenario',
    id: 'case-04',
    name: '促销中库存正常不误报',
    category: '缺货误报',
    description: '促销会制造需求，可售低于平日 ROP 但高于安全库存，不作为缺货',
    expectation: {
      skuId: 'SKU-1004',
      expectedAnomaly: 'none',
      expectedAction: 'none',
      mustNotExecute: true
    },
    run: async (app) => {
      const s = baseSeed('SKU-1004');
      s.ERP = { item_code: 'SKU-1004', on_hand_qty: 60, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 };
      s.INVENTORY = { sku_id: 'SKU-1004', available: 55, in_transit: 0, safety_stock: 30, reorder_point: 100 };
      s.PROMOTION = { sku: 'SKU-1004', active: true, promo_type: 'FULL_REDUCTION', multiplier: 3, promo_price: 70, stacked: false };
      app.backend.seed('SKU-1004', s);
      return runInspect(app, 'SKU-1004', OPERATOR);
    }
  },

  // 5 · 促销跌破安全库存硬底线 → 报缺货
  {
    kind: 'scenario',
    id: 'case-05',
    name: '促销跌破安全库存仍报警',
    category: '缺货检测',
    description: '促销中可售跌破安全库存硬底线，仍触发缺货预警',
    expectation: {
      skuId: 'SKU-1005',
      expectedAnomaly: 'stockout',
      expectedAction: 'create_replenishment_order',
      expectedStatus: 'done'
    },
    run: async (app) => {
      const s = baseSeed('SKU-1005');
      s.ERP = { item_code: 'SKU-1005', on_hand_qty: 20, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 };
      s.INVENTORY = { sku_id: 'SKU-1005', available: 15, in_transit: 0, safety_stock: 30, reorder_point: 100 };
      s.PROMOTION = { sku: 'SKU-1005', active: true, promo_type: 'FLASH_SALE', multiplier: 4, promo_price: 65, stacked: false };
      app.backend.seed('SKU-1005', s);
      return runInspect(app, 'SKU-1005', OPERATOR, { approve: true });
    }
  },

  // 6 · SKU 错配 → 阻断
  {
    kind: 'scenario',
    id: 'case-06',
    name: 'SKU 错配阻断处置',
    category: 'SKU 错配',
    description: 'ERP 返回的 item_code 与查询 SKU 不一致，阻断处置',
    expectation: {
      skuId: 'SKU-1006',
      expectedStatus: 'blocked',
      mustBlock: true,
      mustNotExecute: true
    },
    run: async (app) => {
      const s = baseSeed('SKU-1006');
      s.ERP = { item_code: 'SKU-OTHER', on_hand_qty: 30, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 };
      app.backend.seed('SKU-1006', s);
      return runInspect(app, 'SKU-1006', OPERATOR);
    }
  },

  // 7 · 多系统口径冲突 → 阻断
  {
    kind: 'scenario',
    id: 'case-07',
    name: '销量口径冲突阻断',
    category: '数据契约',
    description: 'BI 与 SALES 对日均销量口径不一致，先排除差异再处置',
    expectation: {
      skuId: 'SKU-1007',
      expectedStatus: 'blocked',
      mustBlock: true,
      mustNotExecute: true
    },
    run: async (app) => {
      const s = baseSeed('SKU-1007');
      s.SALES = { sku: 'SKU-1007', daily_units: 50, window_days: 7, as_of: new Date().toISOString() };
      app.backend.seed('SKU-1007', s);
      return runInspect(app, 'SKU-1007', OPERATOR);
    }
  },

  // 8 · 促销叠加（毛利仍可接受）→ 正常补货
  {
    kind: 'scenario',
    id: 'case-08',
    name: '促销叠加毛利计算不误伤',
    category: '促销叠加',
    description: '满减+秒杀叠加，折算后毛利仍达标，正常生成补货建议',
    expectation: {
      skuId: 'SKU-1008',
      expectedAnomaly: 'stockout',
      expectedAction: 'create_replenishment_order',
      expectedMarginOk: true,
      expectedStatus: 'done'
    },
    run: async (app) => {
      const s = baseSeed('SKU-1008');
      s.PROMOTION = { sku: 'SKU-1008', active: true, promo_type: 'FULL_REDUCTION', multiplier: 3, promo_price: 70, stacked: true };
      app.backend.seed('SKU-1008', s);
      return runInspect(app, 'SKU-1008', OPERATOR, { approve: true });
    }
  },

  // 9 · 毛利约束冲突 → 建议被拦
  {
    kind: 'scenario',
    id: 'case-09',
    name: '毛利为负拦截补货建议',
    category: '毛利约束冲突',
    description: '促销价低于成本，补货建议毛利为负，被拦（不执行）',
    expectation: {
      skuId: 'SKU-1009',
      expectedAnomaly: 'stockout',
      expectedAction: 'none',
      expectedMarginOk: false,
      mustNotExecute: true
    },
    run: async (app) => {
      const s = baseSeed('SKU-1009');
      s.PROMOTION = { sku: 'SKU-1009', active: true, promo_type: 'FLASH_SALE', multiplier: 4, promo_price: 40, stacked: false };
      app.backend.seed('SKU-1009', s);
      return runInspect(app, 'SKU-1009', OPERATOR);
    }
  },

  // 10 · 审批拒绝 → 不自动重试
  {
    kind: 'scenario',
    id: 'case-10',
    name: '审批拒绝不自动重试',
    category: '审批拒绝',
    description: '审批人拒绝后进入 rejected，不自动重试、不执行副作用',
    expectation: {
      skuId: 'SKU-1010',
      expectedStatus: 'rejected',
      mustNotExecute: true
    },
    run: async (app) => {
      app.backend.seed('SKU-1010', baseSeed('SKU-1010'));
      return runInspect(app, 'SKU-1010', OPERATOR, { reject: true });
    }
  },

  // 11 · 审批通过从断点恢复（不重跑调查）
  {
    kind: 'scenario',
    id: 'case-11',
    name: '审批后从断点恢复不重跑调查',
    category: '审批恢复',
    description: '批准后从 Checkpoint 读动作参数执行，不重跑 monitor~decide',
    expectation: {
      skuId: 'SKU-1011',
      expectedStatus: 'done',
      expectedAction: 'create_replenishment_order'
    },
    run: async (app) => {
      app.backend.seed('SKU-1011', baseSeed('SKU-1011'));
      return runInspect(app, 'SKU-1011', OPERATOR, { approve: true });
    },
    customCheck: (report) => {
      const investigate = report.trace.filter((e) => e.type === 'phase_enter' && e.data['phase'] === 'investigate');
      const ok = investigate.length === 1;
      return {
        pass: ok,
        detail: ok ? 'investigate 阶段仅执行一次（未重跑调查）' : `investigate 执行了 ${investigate.length} 次`
      };
    }
  },

  // 12 · 工具重试 → 副作用只执行一次
  {
    kind: 'scenario',
    id: 'case-12',
    name: '工具重试不重复副作用',
    category: '工具重试',
    description: '源系统首次读取失败，重试成功；审批执行副作用仅一次',
    expectation: {
      skuId: 'SKU-1012',
      expectedStatus: 'done',
      expectedAction: 'create_replenishment_order'
    },
    run: async (app) => {
      app.backend.seed('SKU-1012', baseSeed('SKU-1012'));
      app.backend.failNext('INVENTORY', 1); // 首次读取抛错
      return runInspect(app, 'SKU-1012', OPERATOR, { approve: true });
    },
    customCheck: (report) => {
      const calls = report.trace.filter((e) => e.type === 'tool_call' && e.data['tool'] === 'inventory.query');
      const ok = calls.length === 2 && report.executedActions.length === 1;
      return {
        pass: ok,
        detail: ok
          ? `工具调用 ${calls.length} 次（含重试），副作用执行 ${report.executedActions.length} 次`
          : `工具调用 ${calls.length} 次，副作用执行 ${report.executedActions.length} 次`
      };
    }
  },

  // 13 · 幂等：重复审批不重复下单
  {
    kind: 'scenario',
    id: 'case-13',
    name: '重复审批幂等不重复下单',
    category: '幂等控制',
    description: '对同一 Turn 二次批准，副作用动作只执行一次',
    expectation: {
      skuId: 'SKU-1013',
      expectedStatus: 'done',
      expectedAction: 'create_replenishment_order'
    },
    run: async (app) => {
      app.backend.seed('SKU-1013', baseSeed('SKU-1013'));
      return runInspect(app, 'SKU-1013', OPERATOR, { doubleApprove: true });
    },
    customCheck: (report) => {
      const ok = report.executedActions.length === 1;
      return { pass: ok, detail: ok ? '副作用仅执行一次' : `副作用执行了 ${report.executedActions.length} 次` };
    }
  },

  // 14 · 周期任务重启 missed 不补跑
  {
    kind: 'mechanism',
    id: 'case-14',
    name: '周期巡检重启 missed 不补跑',
    category: '定时调度',
    description: '停机期间错过的周期轮次标记 missed，不补跑、游标推进到未来',
    run: async (app) => {
      const base = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)); // 注册于 00:00，首次触发 01:00
      app.scheduler.register(
        {
          name: 'inventory-inspect-hourly',
          kind: 'periodic',
          cron: '0 * * * *',
          params: { scope: 'all' }
        },
        base
      );
      // 模拟停机至 06:00，期间错过 01:00~05:00 多个轮次
      const now = new Date(Date.UTC(2026, 0, 1, 6, 0, 0));
      const { missed, backfilled } = app.scheduler.recover(now);
      if (missed === 0) throw new Error('期望有 missed 轮次，实际为 0');
      if (backfilled.length !== 0) throw new Error('周期任务不应补跑 occurrence');
      if (app.scheduler.listOccurrences().length !== 0) throw new Error('不应物化任何 occurrence');
      // 游标已推进到 06:00 之后
      const rows = app.db.prepare(`SELECT next_run FROM scheduled_task`).all() as unknown as { next_run: string }[];
      for (const row of rows) {
        if (new Date(row.next_run).getTime() < now.getTime()) throw new Error(`游标未推进到未来：${row.next_run}`);
      }
    }
  },

  // 15 · 一次性任务重启必达
  {
    kind: 'mechanism',
    id: 'case-15',
    name: '一次性任务重启必达补跑',
    category: '定时调度',
    description: '停机期间错过的一次性任务，重启后补建 occurrence 必达',
    run: async (app) => {
      app.scheduler.register({
        name: 'one-shot-replenish',
        kind: 'once',
        runAt: new Date(Date.UTC(2025, 11, 31, 23, 0, 0)).toISOString(),
        params: { skuId: 'SKU-1001' }
      });
      const { backfilled } = app.scheduler.recover(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));
      if (backfilled.length !== 1) throw new Error(`一次性任务应补跑 1 条，实际 ${backfilled.length}`);
    }
  },

  // 16 · CAS 冲突 409
  {
    kind: 'mechanism',
    id: 'case-16',
    name: '案例并发写入 CAS 冲突',
    category: 'Case Memory',
    description: '并发更新同一案例，revision 不匹配抛 CaseConflictError（409），不静默覆盖',
    run: async (app) => {
      const c = app.caseStore.create({
        skuId: 'SKU-1001',
        anomalyType: 'stockout',
        cause: '供应商断供',
        action: 'create_replenishment_order',
        outcome: '已补货',
        outcomeOk: true
      });
      app.caseStore.update(c.id, c.revision, { cause: '供应商断供（修订）' }); // 成功，rev→2
      let threw = false;
      try {
        app.caseStore.update(c.id, c.revision, { cause: '并发旧版本写入' }); // 用旧 rev，应冲突
      } catch (e) {
        threw = e instanceof CaseConflictError;
      }
      if (!threw) throw new Error('期望 CAS 冲突抛 CaseConflictError');
    }
  },

  // 17 · FTS5 按 SKU 召回
  {
    kind: 'mechanism',
    id: 'case-17',
    name: 'FTS5 按 SKU 召回相似案例',
    category: 'Case Memory',
    description: '按 SKU 精确召回历史案例，排除其他 SKU',
    run: async (app) => {
      app.caseStore.create({ skuId: 'SKU-1001', anomalyType: 'stockout', cause: '供应商断供', action: 'create_replenishment_order', outcome: 'ok' });
      app.caseStore.create({ skuId: 'SKU-1001', anomalyType: 'overstock', cause: '促销结束库存积压', action: 'adjust_price', outcome: 'ok' });
      app.caseStore.create({ skuId: 'SKU-9999', anomalyType: 'stockout', cause: '无关 SKU', action: 'none', outcome: 'ok' });
      const got = app.caseStore.recallBySku('SKU-1001');
      if (got.length !== 2) throw new Error(`期望召回 2 条，实际 ${got.length}`);
      if (got.some((c) => c.skuId !== 'SKU-1001')) throw new Error('召回了非目标 SKU 案例');
    }
  },

  // 18 · 复用历史调查路径
  {
    kind: 'scenario',
    id: 'case-18',
    name: '复用历史调查路径',
    category: 'Case Memory',
    description: '同类缺货直接复用历史有效案例的处置经验',
    expectation: {
      skuId: 'SKU-1018',
      expectedAnomaly: 'stockout',
      expectedAction: 'create_replenishment_order'
    },
    run: async (app) => {
      app.caseStore.create({
        skuId: 'SKU-1018',
        anomalyType: 'stockout',
        cause: '供应商断供',
        action: 'create_replenishment_order',
        outcome: '补货后恢复',
        outcomeOk: true
      });
      app.backend.seed('SKU-1018', baseSeed('SKU-1018'));
      return runInspect(app, 'SKU-1018', OPERATOR);
    },
    customCheck: (report) => {
      const reused = report.decision?.advice.reusedCaseId;
      const ok = typeof reused === 'number';
      return { pass: ok, detail: ok ? `复用了历史案例 case#${reused}` : '未复用历史案例' };
    }
  },

  // 19 · 未授权 SKU 工具调用被拒（fail-closed）
  {
    kind: 'scenario',
    id: 'case-19',
    name: '未授权 SKU 工具被拒',
    category: 'ACL 权限',
    description: '主体对 SKU 无 read 授权，取数工具返回 invalid_tool，流程失败',
    expectation: {
      skuId: 'SKU-1019',
      expectedStatus: 'failed',
      mustNotExecute: true
    },
    run: async (app) => {
      app.backend.seed('SKU-1019', baseSeed('SKU-1019'));
      // 注意：不 grant，模拟未授权
      const wf = await app.workflow.inspect('SKU-1019', OPERATOR, sessionFor(['SKU-1019']));
      return reportFrom(app, wf);
    }
  },

  // 20 · admin 工作区层无旁路
  {
    kind: 'scenario',
    id: 'case-20',
    name: 'admin 工作区资源层无旁路',
    category: 'ACL 权限',
    description: 'admin 只有系统能力，对具体 SKU 资源仍无访问权（判断不读 role）',
    expectation: {
      skuId: 'SKU-1020',
      expectedStatus: 'failed',
      mustNotExecute: true
    },
    run: async (app) => {
      app.backend.seed('SKU-1020', baseSeed('SKU-1020'));
      // admin 只有系统级授权，无 SKU 授权
      app.grants.grant(ADMIN.id, 'system', '*', 'approve');
      // 即便 role=admin，authorize 仍拒绝（判断函数不读 role，无旁路）
      const d = app.acl.authorize(ADMIN, 'read_inventory', { type: 'sku', id: 'SKU-1020' });
      if (d.allowed) throw new Error('admin 对 SKU 资源存在旁路！');
      const wf = await app.workflow.inspect('SKU-1020', ADMIN, sessionFor(['SKU-1020']));
      return reportFrom(app, wf);
    }
  }
];

/**
 * 执行单条 case：scenario 返回 gate 指标 + 行为校验；mechanism 抛错即失败。
 */
export interface CaseResult {
  id: string;
  name: string;
  kind: 'scenario' | 'mechanism';
  passed: boolean;
  metrics?: { skuMatching: boolean; evidenceCoverage: boolean; actionSafety: boolean };
  details?: string[];
}

export async function runCase(app: App, tc: TestCase): Promise<CaseResult> {
  if (tc.kind === 'mechanism') {
    await tc.run(app);
    return { id: tc.id, name: tc.name, kind: 'mechanism', passed: true };
  }

  const report = await tc.run(app);
  const metrics = evaluate(report, tc.expectation);

  const checks: { pass: boolean; detail: string }[] = [];
  if (tc.expectation.expectedAnomaly && report.decision) {
    checks.push({
      pass: report.decision.anomaly.kind === tc.expectation.expectedAnomaly,
      detail: `异常类型=${report.decision.anomaly.kind}（期望 ${tc.expectation.expectedAnomaly}）`
    });
  }
  if (tc.expectation.expectedAction && report.decision) {
    checks.push({
      pass: report.decision.advice.action === tc.expectation.expectedAction,
      detail: `动作=${report.decision.advice.action}（期望 ${tc.expectation.expectedAction}）`
    });
  }
  if (tc.expectation.expectedStatus) {
    checks.push({
      pass: report.status === tc.expectation.expectedStatus,
      detail: `状态=${report.status}（期望 ${tc.expectation.expectedStatus}）`
    });
  }
  if (tc.expectation.expectedMarginOk !== undefined && report.decision) {
    checks.push({
      pass: report.decision.advice.marginCheck.ok === tc.expectation.expectedMarginOk,
      detail: `毛利检查=${report.decision.advice.marginCheck.ok}（期望 ${tc.expectation.expectedMarginOk}）`
    });
  }
  if (tc.customCheck) checks.push(tc.customCheck(report));

  const behaviorPass = checks.every((c) => c.pass);
  const details = [...metrics.details, ...checks.map((c) => c.detail)];
  return {
    id: tc.id,
    name: tc.name,
    kind: 'scenario',
    passed: metrics.allPass && behaviorPass,
    metrics: { skuMatching: metrics.skuMatching, evidenceCoverage: metrics.evidenceCoverage, actionSafety: metrics.actionSafety },
    details
  };
}
