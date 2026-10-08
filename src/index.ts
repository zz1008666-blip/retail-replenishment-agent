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
