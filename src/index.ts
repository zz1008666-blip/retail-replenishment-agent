/**
 * 零售库存补货决策智能体 —— 公开 API 入口。
 */
export { createApp } from './app';
export type { App, AppOptions } from './app';
export { migrate } from './db/schema';
export { openDb, withTransaction } from './db/connection';

// 数据契约
export * from './contract/types';
export { INVENTORY_SNAPSHOT_SCHEMA } from './contract/schema';

// Adapters
export { materialize } from './adapters/adapter';
export type { Adapter, NormalizedFields } from './adapters/adapter';
export { MockBackend } from './adapters/mock-backend';
export type { BackendData } from './adapters/mock-backend';
export { InventoryCatalog } from './adapters/catalog';

// Tool Hub
export { ToolRegistry } from './tools/registry';
export { buildInventoryTools } from './tools/inventory-tools';

// ACL
export { Acl, ACTION_LEVELS } from './acl';
export type { Principal, ActionType, ActionLevel, Permission } from './acl';

// Scheduler
export { Scheduler } from './scheduler';
export { parseCron, nextAfter } from './scheduler/cron';

// Runtime
export { Ledger } from './runtime/ledger';
export { TurnStore, deriveRunId } from './runtime/turn';
export { IdempotencyGuard } from './runtime/idempotency';
export { ApprovalStore } from './runtime/approval';
export { WorkflowRuntime } from './runtime/workflow';

// Memory
export { CaseStore, CaseConflictError } from './memory/case';
export type { CaseRecord } from './memory/case';

// Agent
export { detect, decide, replenishQty } from './agent/decision';
export type { Decision, Advice, Anomaly } from './agent/decision';
export { DeterministicAdapter, OpenAICompatibleAdapter, resolveLLMAdapter } from './agent/llm';

// Eval
export { TraceRecorder } from './eval/stream-event';
export { evaluate } from './eval/assertions';
export { CASES, runCase } from './eval/cases';
export { runGate, BASELINE } from './eval/gate';

// ============================================================================
// 四层架构（Client / Backend / Runner / Workspace）
// ============================================================================

// Backend 层：真相源 + HTTP + Runner 管理
export { createBackend } from './backend';
export type { Backend, BackendRecord, BackendOptions } from './backend';
export { buildRunnerTools } from './backend/runner-tools';
export { startHttpServer } from './backend/server';
export type { HttpServerHandle, HttpServerOptions } from './backend/server';

// Runner 层：fork 子进程 agent-loop + stdio JSON-RPC
export { spawnRunner } from './runner/spawn';
export type { RunnerClient, RunnerClientOptions } from './runner/spawn';
export { runAgentLoop } from './runner/agent-loop';
export type { AgentLoopDeps, AgentLoopRunResult } from './runner/agent-loop';
export { encodeRunnerRpc, decodeRunnerRpc } from './runner/protocol';
export type {
  RunnerRpcRequest,
  RunnerRpcResponse,
  RunnerRpcEvent,
  RunnerRpcMessage,
  RunnerMethod,
  RunnerToolMethod,
  RunnerEventName,
  InspectParams,
  ToolCallParams,
  ToolCallResult,
  InspectDecision,
  StreamEventPayload
} from './runner/protocol';

// Workspace 层：调查目录隔离 + 路径守卫
export { createWorkspace, safeRunId, workspaceExists, listWorkspaces, removeWorkspace } from './workspace';
export type { Workspace } from './workspace';

// Client 层：Web 面板 + serve 命令
export { WEB_PANEL_HTML } from './client/web-panel';
export { cmdServe } from './client/serve';

// 协议层（参考事件驱动协议设计，场景化裁剪）
export type {
  StreamEvent,
  StreamEventType,
  StreamAgentScope,
  StreamDisplayLevel,
  WorkflowPhaseSnapshot,
  WorkflowAgentSnapshot,
  WorkflowRunSnapshot,
  EvidenceCoverageAudit
} from './backend/protocol/stream-event.types';
export {
  ALL_SYSTEM_PERMISSIONS,
  PERMISSION_TEMPLATES,
  ROLE_DEFAULT_PERMISSIONS,
  normalizeSystemPermissions,
  getDefaultPermissions,
  resolveTemplate,
  hasSystemPermission
} from './backend/protocol/permissions';
export type {
  SystemPermission,
  PlatformRole,
  PermissionTemplateKey
} from './backend/protocol/permissions';
export { createIpcSendDeduplicator } from './backend/protocol/ipc-send-dedup';
export type { IpcSendDedupDeps } from './backend/protocol/ipc-send-dedup';
export { RUNNER_SHUTDOWN_GRACE_MS, resolveRunnerLivenessTimeouts } from './backend/protocol/liveness';
export type { RunnerLivenessTimeouts } from './backend/protocol/liveness';
export {
  orderIpcInputMessages,
  parseIpcReceipt,
  isHealthyInputTurnCompletion,
  latestIpcDeliveryId,
  latestIpcInputMessage,
  IpcTurnDeliveryTracker,
  serializeIpcInputMessage,
  requeueIpcInputMessages
} from './backend/protocol/ipc-delivery';
export type {
  IpcCursor,
  IpcDeliveryReceipt,
  IpcInputMessage
} from './backend/protocol/ipc-delivery';
