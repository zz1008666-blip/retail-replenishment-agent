/**
 * 应用组装：把各模块（Adapters / Tool Hub / ACL / Scheduler / Runtime / Memory / Eval）
 * 装配成一个可用的补货决策智能体。
 */
import { DatabaseSync } from 'node:sqlite';
import { openDb } from './db/connection';
import { migrate } from './db/schema';
import { MockBackend } from './adapters/mock-backend';
import { buildAdapters } from './adapters';
import { InventoryCatalog } from './adapters/catalog';
import { Acl } from './acl';
import { SqliteGrantStore } from './acl/sqlite-grants';
import { ToolRegistry } from './tools/registry';
import { buildInventoryTools } from './tools/inventory-tools';
import { Ledger } from './runtime/ledger';
import { TurnStore } from './runtime/turn';
import { IdempotencyGuard } from './runtime/idempotency';
import { ApprovalStore } from './runtime/approval';
import { CaseStore } from './memory/case';
import { WorkflowRuntime } from './runtime/workflow';
import { TraceRecorder } from './eval/stream-event';
import type { LLMAdapter } from './agent/llm';
import { resolveLLMAdapter } from './agent/llm';
import { Scheduler } from './scheduler';

export interface AppOptions {
  /** SQLite 文件路径；默认 :memory: */
  dbPath?: string;
  /** 直接传入已打开的 db（优先于 dbPath） */
  db?: DatabaseSync;
  llm?: LLMAdapter;
}

export interface App {
  db: DatabaseSync;
  backend: MockBackend;
  catalog: InventoryCatalog;
  acl: Acl;
  grants: SqliteGrantStore;
  tools: ToolRegistry;
  ledger: Ledger;
  turnStore: TurnStore;
  idempotency: IdempotencyGuard;
  approvalStore: ApprovalStore;
  caseStore: CaseStore;
  workflow: WorkflowRuntime;
  trace: TraceRecorder;
  scheduler: Scheduler;
  /** 副作用执行记录（测试断言用） */
  sideEffects: { action: string; params: Record<string, unknown> }[];
}

export function createApp(options: AppOptions = {}): App {
  const db = options.db ?? openDb(options.dbPath ?? ':memory:');
  migrate(db);

  const backend = new MockBackend();
  const adapters = buildAdapters(backend);
  const catalog = new InventoryCatalog(adapters);

  const grants = new SqliteGrantStore(db);
  const acl = new Acl(grants);

  const tools = new ToolRegistry(acl);
  for (const t of buildInventoryTools(catalog)) tools.register(t);

  const ledger = new Ledger(db);
  const turnStore = new TurnStore(db);
  const idempotency = new IdempotencyGuard(db);
  const approvalStore = new ApprovalStore(db);
  const caseStore = new CaseStore(db);
  const trace = new TraceRecorder();
  const llm = options.llm ?? resolveLLMAdapter();

  const sideEffects: { action: string; params: Record<string, unknown> }[] = [];

  const workflow = new WorkflowRuntime({
    acl,
    tools,
    ledger,
    turnStore,
    idempotency,
    caseStore,
    approvalStore,
    llm,
    trace,
    sideEffectSink: (action, params) => sideEffects.push({ action, params })
  });

  const scheduler = new Scheduler(db);

  return {
    db,
    backend,
    catalog,
    acl,
    grants,
    tools,
    ledger,
    turnStore,
    idempotency,
    approvalStore,
    caseStore,
    workflow,
    trace,
    scheduler,
    sideEffects
  };
}
