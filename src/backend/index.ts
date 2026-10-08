/**
 * Backend 层：真相源 + Runner 管理 + 对外接口。
 *
 * 对应 MiniClaw 的 Backend（Hono）：
 *   - 持有 SQLite 真相源（经 App 装配的 db / catalog / caseStore / acl / tools）
 *   - 不做「解读 prompt」「跑工具」——这些在 Runner 子进程里做
 *   - 只负责：派生/管理工作区 → fork Runner → 回应 Runner 的取数请求（带 ACL）→
 *     落盘 decision + trace → 供 Client 查询
 *
 * 与进程内路径（src/app.ts 的 workflow.inspect）并存：
 *   - 进程内：eval 套件用，链路最短、最快、100% 确定。
 *   - 本层：四层架构的标准路径，Runner 在独立进程跑，隔离边界真实存在。
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { App } from '../app';
import type { Principal } from '../acl';
import type { SessionScope } from '../tools/registry';
import type { Decision } from '../agent/decision';
import type { StreamEvent } from './protocol/stream-event.types';
import type { InspectParams, ToolCallResult } from '../runner/protocol';
import { buildRunnerTools } from './runner-tools';
import { spawnRunner, type RunnerClient } from '../runner/spawn';
import { createWorkspace, type Workspace } from '../workspace';

export interface BackendRecord {
  runId: string;
  skuId: string;
  decision: Decision;
  events: StreamEvent[];
  workspaceDir: string;
}

export interface BackendOptions {
  /** 工作区根目录（默认 cwd/workspaces） */
  workspaceRoot?: string;
  /** 已编译 runner worker 入口路径（测试注入用） */
  runnerWorkerPath?: string;
  onLog?: (line: string) => void;
}

export interface Backend {
  inspect(skuId: string, principal: Principal, session?: SessionScope): Promise<BackendRecord>;
  trace(runId: string): StreamEvent[];
  decision(runId: string): Decision | undefined;
  records(): BackendRecord[];
  close(): Promise<void>;
}

interface RunStore {
  skuId: string;
  workspace: Workspace;
  decision?: Decision;
  events: StreamEvent[];
}

export async function createBackend(app: App, opts: BackendOptions = {}): Promise<Backend> {
  const stores = new Map<string, RunStore>();
  const workspaceRoot = opts.workspaceRoot ?? path.join(process.cwd(), 'workspaces');
  const runnerTools = buildRunnerTools(app.acl, app.catalog, app.caseStore);
  const onLog = opts.onLog ?? (() => {});

  const client: RunnerClient = await spawnRunner({
    workerPath: opts.runnerWorkerPath,
    resolveTool: async (
      ctx: InspectParams,
      tool: string,
      input: Record<string, unknown>
    ): Promise<ToolCallResult> => {
      // 关键：所有取数都回到 ToolRegistry，走 ACL（资源归属）+ session 范围检查。
      // Principal 从 inspect 上下文还原，Runner 无法伪造授权。
      const result = await runnerTools.invoke(tool, input, {
        principal: ctx.principal as Principal,
        session: ctx.session
      });
      return result;
    },
    onEvent: (runId, event) => {
      const store = stores.get(runId);
      if (store) {
        store.events.push(event);
        store.workspace.appendTrace(event);
      }
    },
    onLog
  });

  const toRecord = (runId: string, store: RunStore): BackendRecord => ({
    runId,
    skuId: store.skuId,
    decision: store.decision!,
    events: store.events.slice(),
    workspaceDir: store.workspace.dir
  });

  return {
    async inspect(skuId, principal, session = { id: 'default', skuIds: [skuId] }) {
      const runId = randomUUID();
      const workspace = createWorkspace(workspaceRoot, runId);
      const store: RunStore = { skuId, workspace, events: [] };
      stores.set(runId, store);

      const params: InspectParams = {
        runId,
        skuId,
        principal: { id: principal.id, role: principal.role },
        session
      };
      const { decision } = await client.inspect(params);
      store.decision = decision;
      workspace.writeDecision({ skuId, decision });
      return toRecord(runId, store);
    },
    trace(runId) {
      return stores.get(runId)?.events.slice() ?? [];
    },
    decision(runId) {
      return stores.get(runId)?.decision;
    },
    records() {
      return Array.from(stores.entries())
        .filter(([, s]) => s.decision)
        .map(([runId, s]) => toRecord(runId, s));
    },
    async close() {
      await client.close();
    }
  };
}