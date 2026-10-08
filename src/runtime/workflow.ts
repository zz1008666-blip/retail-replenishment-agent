/**
 * 补货 Workflow Runtime：把 Monitor/Detect/Investigate/Decide/Act/Review
 * 建模为可恢复 Turn。
 *  - Session Scheduler 保证同 SKU 串行推进
 *  - Ledger 持久化调查证据与动作参数
 *  - 人工审批后从 Checkpoint 恢复，不重跑调查
 *  - IdempotencyGuard 保证有副作用动作不重复执行
 */
import type { Acl, Principal } from '../acl';
import type { ToolRegistry, SessionScope, ToolContext, ToolResult } from '../tools/registry';
import type { InventoryCatalog } from '../adapters/catalog';
import type { Ledger } from './ledger';
import type { TurnStore, Turn, Phase, TurnStatus } from './turn';
import type { IdempotencyGuard } from './idempotency';
import type { CaseStore } from '../memory/case';
import type { LLMAdapter } from '../agent/llm';
import type { Decision, Advice } from '../agent/decision';
import { detect } from '../agent/decision';
import type { TraceRecorder } from '../eval/stream-event';
import { ApprovalStore } from './approval';

/** 同 SKU 串行调度：每个 skuId 一条 lane，异 SKU 并行 */
class SessionScheduler {
  private lanes = new Map<string, Promise<void>>();

  run<T>(skuId: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.lanes.get(skuId) ?? Promise.resolve();
    const task = prev.then(fn, fn);
    this.lanes.set(
      skuId,
      task.then(
        () => undefined,
        () => undefined
      )
    );
    return task;
  }
}

export interface WorkflowDeps {
  acl: Acl;
  tools: ToolRegistry;
  ledger: Ledger;
  turnStore: TurnStore;
  idempotency: IdempotencyGuard;
  caseStore: CaseStore;
  approvalStore: ApprovalStore;
  llm: LLMAdapter;
  trace: TraceRecorder;
  /** 观察副作用执行（测试注入 spy，模拟真实下单/调价/下架） */
  sideEffectSink?: (action: string, params: Record<string, unknown>) => void;
}

export interface WorkflowResult {
  turnRunId: string;
  skuId: string;
  status: TurnStatus;
  phase: Phase;
  decision?: Decision;
  approvalId?: number;
}

export class WorkflowRuntime {
  private scheduler = new SessionScheduler();

  constructor(private deps: WorkflowDeps) {}

  /** 巡检入口：对某 SKU 跑完整决策链（受 Session Scheduler 串行约束） */
  async inspect(
    skuId: string,
    principal: Principal,
    session: SessionScope,
    triggerKey?: string
  ): Promise<WorkflowResult> {
    return this.scheduler.run(skuId, () => this.doInspect(skuId, principal, session, triggerKey));
  }

  private async doInspect(
    skuId: string,
    principal: Principal,
    session: SessionScope,
    triggerKey?: string
  ): Promise<WorkflowResult> {
    const logicalKey = triggerKey ?? `manual:${skuId}:${Date.now()}`;
    const turn = this.deps.turnStore.create(skuId, logicalKey, {});
    const runId = turn.runId;
    const ctx: ToolContext = { principal, session };

    try {
      // ---- Monitor ----
      this.enter(turn, 'monitor');
      const q = await this.callTool(runId, skuId, 'inventory.query', { skuId }, ctx);
      if (!q.ok) {
        this.deps.ledger.error(runId, 'monitor', { error: q.error });
        this.deps.turnStore.transition(runId, 'monitor', 'failed');
        return { turnRunId: runId, skuId, status: 'failed', phase: 'monitor' };
      }
      const { snapshot, warnings } = q.data as {
        snapshot: import('../contract/types').InventorySnapshot;
        warnings: import('../adapters/adapter').DataQualityWarning[];
      };
      this.deps.ledger.evidence(runId, 'monitor', { snapshot, warnings });

      // ---- Detect ----
      this.enter(turn, 'detect');
      const det = detect(snapshot, warnings);
      this.deps.ledger.evidence(runId, 'detect', { anomaly: det.anomaly, blocked: det.blocked });

      // ---- Investigate ----
      this.enter(turn, 'investigate');
      const cases = this.deps.caseStore.recallBySku(skuId, undefined, 5);
      this.deps.ledger.evidence(runId, 'investigate', { recalledCases: cases.map((c) => c.id) });
      this.deps.trace.emit(runId, skuId, 'evidence', { recalledCases: cases.map((c) => c.id) });

      // ---- Decide ----
      this.enter(turn, 'decide');
      const decision = await this.deps.llm.decide({ snapshot, warnings, cases });
      this.deps.ledger.decision(runId, 'decide', decision);
      this.deps.trace.emit(runId, skuId, 'decision', { action: decision.advice.action, blocked: decision.blocked });

      // ---- Act ----
      this.enter(turn, 'act');
      if (decision.blocked) {
        this.deps.turnStore.transition(runId, 'act', 'blocked');
        return { turnRunId: runId, skuId, status: 'blocked', phase: 'act', decision };
      }
      if (decision.advice.action === 'none') {
        this.deps.turnStore.transition(runId, 'review', 'done');
        return { turnRunId: runId, skuId, status: 'done', phase: 'review', decision };
      }

      // APPROVAL：保存断点，进入待审批，不直接执行
      this.deps.turnStore.saveCheckpoint(runId, {
        advice: decision.advice,
        anomaly: decision.anomaly,
        evidence: decision.evidence
      });
      this.deps.turnStore.transition(runId, 'act', 'awaiting_approval');
      const approval = this.deps.approvalStore.create(runId, decision.advice.action, principal.id);
      this.deps.ledger.action(runId, 'act', { type: 'request_approval', action: decision.advice.action });
      this.deps.trace.emit(runId, skuId, 'approval', {
        status: 'pending',
        approvalId: approval.id,
        action: decision.advice.action
      });
      return { turnRunId: runId, skuId, status: 'awaiting_approval', phase: 'act', decision, approvalId: approval.id };
    } catch (err) {
      this.deps.ledger.error(runId, turn.phase, { error: String(err) });
      this.deps.turnStore.transition(runId, turn.phase, 'failed');
      return { turnRunId: runId, skuId, status: 'failed', phase: turn.phase };
    }
  }

  /** 人工批准：从 Checkpoint 恢复，执行有副作用动作（幂等）→ 复盘沉淀案例 */
  async approve(turnRunId: string, approverId: string, reason?: string): Promise<WorkflowResult> {
    return this.scheduler.run(this.skuOf(turnRunId), () => this.doDecide(turnRunId, approverId, 'approved', reason));
  }

  /** 人工拒绝：进入 rejected，不自动重试 */
  async reject(turnRunId: string, approverId: string, reason?: string): Promise<WorkflowResult> {
    return this.scheduler.run(this.skuOf(turnRunId), () => this.doDecide(turnRunId, approverId, 'rejected', reason));
  }

  private skuOf(turnRunId: string): string {
    const t = this.deps.turnStore.get(turnRunId);
    return t ? t.skuId : '__unknown__';
  }

  private doDecide(
    turnRunId: string,
    approverId: string,
    status: 'approved' | 'rejected',
    reason?: string
  ): WorkflowResult {
    const turn = this.deps.turnStore.get(turnRunId);
    if (!turn) throw new Error(`turn ${turnRunId} 不存在`);
    if (turn.status !== 'awaiting_approval') throw new Error(`turn ${turnRunId} 非待审批状态`);
    const approval = this.deps.approvalStore.latestForTurn(turnRunId);
    if (!approval || approval.status !== 'pending') throw new Error(`turn ${turnRunId} 无待决审批`);
    this.deps.approvalStore.decide(approval.id, status, reason);

    if (status === 'rejected') {
      this.deps.turnStore.transition(turnRunId, 'act', 'rejected');
      this.deps.ledger.action(turnRunId, 'act', { type: 'rejected', reason, approverId });
      this.deps.trace.emit(turnRunId, turn.skuId, 'approval', { status: 'rejected', reason });
      return { turnRunId, skuId: turn.skuId, status: 'rejected', phase: 'act', approvalId: approval.id };
    }

    // ---- 从 Checkpoint 恢复：读断点里的动作参数，不重跑调查 ----
    const checkpoint = turn.checkpoint ?? {};
    const advice = checkpoint['advice'] as Advice;
    this.deps.turnStore.transition(turnRunId, 'act', 'approved');
    this.deps.ledger.action(turnRunId, 'act', { type: 'approved', approverId, reason, fromCheckpoint: true });
    this.deps.trace.emit(turnRunId, turn.skuId, 'approval', {
      status: 'approved',
      approvalId: approval.id,
      approverId,
      reason
    });

    const actionKey = `${turnRunId}:${advice.action}`;
    const idem = this.deps.idempotency.runOnce(actionKey, turnRunId, advice.action, advice, () => {
      this.deps.sideEffectSink?.(advice.action, {
        skuId: turn.skuId,
        quantity: advice.quantity,
        supplier: advice.supplier,
        etaDays: advice.etaDays,
        targetPrice: advice.targetPrice
      });
    });
    this.deps.ledger.action(turnRunId, 'act', {
      type: 'execute',
      action: advice.action,
      idempotency: idem,
      params: advice
    });
    this.deps.trace.emit(turnRunId, turn.skuId, 'action', { action: advice.action, idempotency: idem });

    // ---- Review：沉淀案例 ----
    this.deps.turnStore.transition(turnRunId, 'review', 'running');
    this.writeCase(turn, checkpoint);
    this.deps.turnStore.transition(turnRunId, 'review', 'done');
    return { turnRunId, skuId: turn.skuId, status: 'done', phase: 'review', approvalId: approval.id };
  }

  private writeCase(turn: Turn, checkpoint: Record<string, unknown>): void {
    const advice = checkpoint['advice'] as Advice;
    const anomaly = checkpoint['anomaly'] as { kind: string; reason: string };
    const anomalyType = anomaly.kind === 'stockout' ? 'stockout' : anomaly.kind === 'overstock' ? 'overstock' : 'other';
    this.deps.caseStore.create({
      skuId: turn.skuId,
      anomalyType,
      cause: anomaly.reason,
      action: advice.action,
      outcome: `已${advice.action === 'create_replenishment_order' ? '生成补货单' : advice.action === 'adjust_price' ? '调价' : '下架'}，待复盘`,
      outcomeOk: true,
      occurredAt: new Date().toISOString()
    });
  }

  private enter(turn: Turn, phase: Phase): void {
    this.deps.turnStore.transition(turn.runId, phase, 'running');
    this.deps.trace.emit(turn.runId, turn.skuId, 'phase_enter', { phase });
  }

  /** 带重试的工具调用：读取类工具可重试，授权失败(invalidTool)不重试 */
  private async callTool(
    runId: string,
    skuId: string,
    name: string,
    params: Record<string, unknown>,
    ctx: ToolContext,
    retries = 2
  ): Promise<ToolResult> {
    let last: ToolResult = { ok: false, error: 'unreachable' };
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.deps.trace.emit(runId, skuId, 'tool_call', { tool: name, attempt });
      try {
        const res = await this.deps.tools.invoke(name, params, ctx);
        this.deps.trace.emit(runId, skuId, 'tool_result', { tool: name, ok: res.ok, error: res.error, attempt });
        if (res.ok || res.invalidTool) return res;
        last = res;
      } catch (err) {
        this.deps.trace.emit(runId, skuId, 'tool_result', {
          tool: name,
          ok: false,
          error: String(err),
          attempt
        });
        last = { ok: false, error: String(err) };
      }
    }
    return last;
  }
}
