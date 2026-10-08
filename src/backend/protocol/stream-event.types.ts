/**
 * 规范 StreamEvent 类型定义（照搬自 MiniClaw 的
 * `container/agent-runner/src/stream-event.types.ts`，并按零售补货场景裁剪）。
 *
 * MiniClaw 把「流式事件」当作单一事实来源（single source of truth），
 * 同一份类型文件被编译进 Backend / Agent Runner / Web 三端，保证三方
 * 对同一份 trace 的理解一致。本项目沿用这一思路：
 *   - Backend（真相源）记录 trace 并对外提供
 *   - Runner（fork 子进程）产生事件
 *   - Client（CLI / Web 面板）消费渲染
 *
 * 类型面完整保留 MiniClaw 的 24 种事件（用于协议对齐与可插拔扩展），
 * 而零售补货场景的确定性内核实际只用到其中少量（见 src/runner/protocol.ts）。
 */

export type StreamEventType =
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use_start'
  | 'tool_use_end'
  | 'tool_progress'
  | 'tool_result'
  | 'hook_started'
  | 'hook_progress'
  | 'hook_response'
  | 'task_start'
  | 'task_progress'
  | 'task_updated'
  | 'task_notification'
  | 'permission_denied'
  | 'memory_recall'
  | 'compact_boundary'
  | 'notification'
  | 'prompt_suggestion'
  | 'raw_sdk_event'
  | 'context_audit'
  | 'todo_update'
  | 'usage'
  | 'status'
  | 'init';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

/** 决策工作流的阶段快照（Monitor → Detect → Investigate → Decide → Act → Review） */
export interface WorkflowPhaseSnapshot {
  index: number;
  title: string;
  detail?: string;
}

/** 单个执行体（agent / runner / 子代理）的运行快照 */
export interface WorkflowAgentSnapshot {
  index: number;
  label: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  fallbackModel?: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
  queuedAt?: number;
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
}

/** 一次补货巡检（workflow run）的可持久化、面向用户投影 */
export interface WorkflowRunSnapshot {
  taskId: string;
  runId?: string;
  workflowName?: string;
  summary: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
  startTime?: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases: WorkflowPhaseSnapshot[];
  agents: WorkflowAgentSnapshot[];
}

/**
 * 零售场景的证据覆盖审计（对 MiniClaw ClaudeContextAudit 的场景化裁剪）。
 * 复用同一「审计」语义：决策前核对关键字段是否齐备、取证是否完整。
 */
export interface EvidenceCoverageAudit {
  requiredFields: string[];
  presentFields: string[];
  missingFields: string[];
  coverage: number;
  dataQualityWarnings: string[];
}

/**
 * 规范 StreamEvent：Runner 产生的每一条轨迹事件。
 * 字段面与 MiniClaw 保持一致（agentScope / turnId / toolName / permissionDenied …），
 * 未用到的字段保留以维持跨端协议稳定。
 */
export interface StreamEvent {
  eventType: StreamEventType;
  /** 哪个运行时执行单元产生此事件 */
  agentScope?: StreamAgentScope;
  /** 精确到某次 GroupQueue 查询尝试 */
  queryRunId?: string;
  /** 关联同一次用户 turn 的所有事件 */
  turnId?: string;
  sessionId?: string;
  messageUuid?: string;
  /** 是否本地合成（而非 SDK 直接抛出） */
  isSynthetic?: boolean;
  /** UI 优先级：primary 内联 / detail 轨迹面板 / debug 开发者轨迹 */
  displayLevel?: StreamDisplayLevel;
  text?: string;
  title?: string;
  summary?: string;
  detail?: string;
  rawType?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  /** 工具执行结果文本（截断 + 脱敏），挂在 tool_result 上供 Web 面板展示 */
  toolResult?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskType?: string;
  workflowName?: string;
  workflowRun?: WorkflowRunSnapshot;
  taskPatch?: Record<string, unknown>;
  permissionDenied?: {
    toolName: string;
    toolUseId: string;
    agentId?: string;
    reasonType?: string;
    reason?: string;
    message: string;
  };
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  rawEvent?: Record<string, unknown>;
  /** 零售场景：决策证据覆盖审计（替代 MiniClaw 的 Claude 上下文审计） */
  evidenceCoverage?: EvidenceCoverageAudit;
  todos?: Array<{
    id: string;
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    numTurns: number;
  };
}