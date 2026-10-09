/**
 * Runner 决策环（agent-loop）：在子进程里执行 Monitor → Detect → Investigate → Decide。
 *
 * 关键约束（对应四层架构的 Runner 职责）：
 *   - 本进程不连数据库、不持有任何业务数据。
 *   - 想拿数据只能通过 invokeTool 向 Backend 发 tool_call 请求（带 ACL）。
 *   - 决策内核复用 src/agent/decision.ts（detect/decide），100% 离线可复现。
 *   - LLM 可插拔：默认 DeterministicAdapter，配了凭据可换真模型。
 *
 * 这是一个纯函数 + 依赖注入的组合：不直接依赖 stdin/stdout，方便单测。
 */
import { detect } from '../agent/decision';
import type { Decision, DetectResult } from '../agent/decision';
import type { InventorySnapshot } from '../contract/types';
import type { DataQualityWarning } from '../adapters/adapter';
import type { CaseRecord } from '../memory/case';
import { DeterministicAdapter, resolveLLMAdapter, type LLMAdapter } from '../agent/llm';
import type { StreamEvent } from '../backend/protocol/stream-event.types';
import type { InspectParams, ToolCallResult } from './protocol';

export interface AgentLoopDeps {
  /** 向 Backend 请求一个工具调用（inventory.query / memory.recall_cases） */
  invokeTool: (runId: string, tool: string, input: Record<string, unknown>) => Promise<ToolCallResult>;
  /** 向 Backend 流式推送一条 StreamEvent */
  emit?: (runId: string, event: StreamEvent) => void;
  /** 可注入的 LLM 适配器（默认离线确定性内核） */
  llm?: () => LLMAdapter;
}

export interface AgentLoopRunResult {
  decision: Decision;
  /** 本环里被拒绝（invalidTool）的工具调用，用于把 ACL 拒绝反映到 trace */
  toolCalls: { tool: string; input: Record<string, unknown>; ok: boolean }[];
}

function makeEvent(
  eventType: StreamEvent['eventType'],
  text: string,
  extra?: Partial<StreamEvent>
): StreamEvent {
  return {
    eventType,
    agentScope: 'main',
    displayLevel: 'detail',
    text,
    ...extra
  };
}

/** 把 inventory.query 的工具结果还原为内核所需的完整上下文 */
function unpackSnapshot(result: ToolCallResult): {
  snapshot?: InventorySnapshot;
  warnings: DataQualityWarning[];
  invalid: boolean;
} {
  if (!result.ok) {
    return { warnings: [], invalid: true };
  }
  const data = result.data as
    | { snapshot?: InventorySnapshot; warnings?: DataQualityWarning[] }
    | undefined;
  if (!data || !data.snapshot) {
    return { warnings: [], invalid: true };
  }
  return { snapshot: data.snapshot, warnings: data.warnings ?? [], invalid: false };
}

export async function runAgentLoop(
  params: InspectParams,
  deps: AgentLoopDeps
): Promise<AgentLoopRunResult> {
  const emit = deps.emit ?? (() => {});
  const getLlm = deps.llm ?? (() => resolveLLMAdapter());
  const llm = getLlm();
  const toolCalls: AgentLoopRunResult['toolCalls'] = [];

  const callTool = async (
    runId: string,
    tool: string,
    input: Record<string, unknown>
  ): Promise<ToolCallResult> => {
    emit(runId, makeEvent('tool_use_start', `调用工具 ${tool}`, { toolName: tool, toolInput: input }));
    const result = await deps.invokeTool(runId, tool, input);
    toolCalls.push({ tool, input, ok: result.ok && !result.invalidTool });
    if (!result.ok || result.invalidTool) {
      emit(
        runId,
        makeEvent('tool_result', `工具 ${tool} 被拒绝/未知`, {
          toolName: tool,
          permissionDenied: {
            toolName: tool,
            toolUseId: '',
            reason: result.error,
            message: result.error ?? 'invalid_tool'
          }
        })
      );
    } else {
      emit(runId, makeEvent('tool_result', `工具 ${tool} 返回`, { toolName: tool }));
    }
    return result;
  };

  // 1) 取数：归一化库存快照
  const q = await callTool(params.runId, 'inventory.query', { skuId: params.skuId });
  const { snapshot, warnings, invalid } = unpackSnapshot(q);

  if (invalid || !snapshot) {
    // 数据都取不到，只能转人工，不产出可执行建议
    const decision: Decision = {
      skuId: params.skuId,
      anomaly: { kind: 'none', severity: 'none', reason: '无法获取库存快照（工具被拒或数据缺失）' },
      advice: {
        action: 'none',
        marginCheck: { ok: false, reason: '无法获取库存快照' },
        requiresApproval: false,
        rationale: '取数失败，转人工'
      },
      evidence: [],
      dataQualityWarnings: [],
      blocked: true,
      blockReason: 'inventory.query 失败'
    };
    emit(params.runId, makeEvent('status', '取数失败，转人工', { detail: 'inventory.query failed', statusText: 'blocked' }));
    return { decision, toolCalls };
  }

  // 2) 检测异常
  const det: DetectResult = detect(snapshot, warnings);

  // 3) 异常时召回历史案例（复用历史调查路径）
  let cases: CaseRecord[] = [];
  if (!det.blocked && det.anomaly.kind !== 'none') {
    const recall = await callTool(params.runId, 'memory.recall_cases', {
      skuId: params.skuId,
      keyword: det.anomaly.kind
    });
    if (recall.ok && !recall.invalidTool) {
      cases = (recall.data as { cases?: CaseRecord[] } | undefined)?.cases ?? [];
      emit(params.runId, makeEvent('memory_recall', `召回 ${cases.length} 条相似案例`));
    }
  }

  // 4) 决策（复用内核）
  const decision = await llm.decide({ snapshot, warnings, cases });

  emit(params.runId, makeEvent('status', `决策完成：${decision.advice.rationale}`, {
    detail: JSON.stringify({ anomaly: decision.anomaly, advice: decision.advice }),
    statusText: 'completed'
  }));

  return { decision, toolCalls };
}