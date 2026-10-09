/**
 * Backend 侧的 Runner 客户端（spawn / fork 管理）。
 *
 * 它扮演「宿主」的角色：
 *   - fork 一个 runner worker 子进程
 *   - 向子进程发 inspect 请求，收取 decision 与 StreamEvent
 *   - 子进程发来 tool_call 请求时，转交 resolveTool（走 ToolRegistry 的 ACL）
 *   - 用 liveness 的时间预算做看门狗：空闲回收停掉 warm runner、超时杀掉进程
 *
 * 「载体」：用 fork 子进程隔离 Runner，
 * 隔离边界为「进程 + 无 DB 引用」，满足单机零依赖。
 */
import { fork, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import {
  encodeRunnerRpc,
  decodeRunnerRpc,
  type RunnerRpcMessage,
  type RunnerRpcResponse,
  type RunnerRpcRequest,
  type InspectParams,
  type InspectDecision,
  type ToolCallParams,
  type ToolCallResult
} from './protocol';
import type { StreamEvent } from '../backend/protocol/stream-event.types';
import { resolveRunnerLivenessTimeouts } from '../backend/protocol/liveness';

export interface RunnerClientOptions {
  /** 已编译的 worker 入口绝对路径（默认取本文件同目录 worker.js） */
  workerPath?: string;
  /** 自定义 fork 的 child_process.fork（测试用） */
  forkFn?: typeof fork;
  /** Backend 侧工具解析：带 ACL，把 tool_call 转成 ToolCallResult */
  resolveTool: (ctx: InspectParams, tool: string, input: Record<string, unknown>) => Promise<ToolCallResult>;
  /** 收到 StreamEvent 的回调（用于持久化 trace） */
  onEvent?: (runId: string, event: StreamEvent) => void;
  /** 收到 stderr 日志的回调 */
  onLog?: (line: string) => void;
  executionTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export interface RunnerClient {
  inspect(params: InspectParams): Promise<InspectDecision>;
  close(): Promise<void>;
}

export function spawnRunner(opts: RunnerClientOptions): Promise<RunnerClient> {
  const workerPath =
    opts.workerPath ?? path.join(__dirname, 'worker.js');
  const forkFn = opts.forkFn ?? fork;
  const timeouts = resolveRunnerLivenessTimeouts({
    executionTimeoutMs: opts.executionTimeoutMs ?? 60_000,
    idleTimeoutMs: opts.idleTimeoutMs ?? 30_000
  });
  const onEvent = opts.onEvent ?? (() => {});
  const onLog = opts.onLog ?? (() => {});

  return new Promise((resolve, reject) => {
    const child: ChildProcess = forkFn(workerPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    let requestSeq = 0;
    const pending = new Map<
      number,
      { resolve: (r: RunnerRpcResponse) => void; reject: (e: Error) => void }
    >();
    const contexts = new Map<string, InspectParams>();
    let idleTimer: NodeJS.Timeout | undefined;
    let watchdogTimer: NodeJS.Timeout | undefined;
    let closed = false;

    const fail = (e: Error): void => {
      for (const [, waiter] of pending) waiter.reject(e);
      pending.clear();
      reject(e);
    };

    const resetTimers = (): void => {
      if (closed) return;
      if (idleTimer) clearTimeout(idleTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      // 温和回收（空闲）永远先于外层看门狗（见 liveness.ts 竞态修复）
      idleTimer = setTimeout(() => {
        onLog('[runner] idle close');
        void doClose();
      }, timeouts.idleCloseMs);
      watchdogTimer = setTimeout(() => {
        onLog('[runner] watchdog kill');
        child.kill('SIGKILL');
      }, timeouts.watchdogMs);
    };

    function send(msg: RunnerRpcMessage): void {
      resetTimers();
      child.stdin?.write(encodeRunnerRpc(msg));
    }

    function sendRequest(method: RunnerRpcRequest['method'], params: unknown): Promise<RunnerRpcResponse> {
      const id = ++requestSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ kind: 'request', id, method, params });
      });
    }

    const dispatch = (line: string): void => {
      const msg = decodeRunnerRpc(line);
      if (!msg) return;
      if (msg.kind === 'response') {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter.resolve(msg);
        }
        return;
      }
      if (msg.kind === 'event') {
        if (msg.name === 'stream_event') {
          const p = msg.payload as { runId: string; event: StreamEvent };
          onEvent(p.runId, p.event);
        } else if (msg.name === 'done' || msg.name === 'error') {
          onLog(`[runner] ${msg.name}`);
        }
        return;
      }
      if (msg.kind === 'request' && msg.method === 'tool_call') {
        void (async () => {
          const tp = msg.params as ToolCallParams;
          const ctx = contexts.get(tp.runId);
          let result: ToolCallResult;
          if (!ctx) {
            result = { ok: false, invalidTool: true, error: '运行上下文不存在，拒绝取数' };
          } else {
            result = await opts.resolveTool(ctx, tp.tool, tp.input);
          }
          send({ kind: 'response', id: msg.id, ok: result.ok, result });
        })();
        return;
      }
    };

    const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', dispatch);
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) onLog(line.trim());
      }
    });
    child.on('error', (err) => fail(err));
    child.on('exit', (code) => {
      if (!closed) fail(new Error(`runner 退出 code=${code}`));
    });

    if (!child.stdout || !child.stdin) {
      fail(new Error('无法建立 stdio 管道'));
      return;
    }

    const client: RunnerClient = {
      async inspect(params: InspectParams): Promise<InspectDecision> {
        contexts.set(params.runId, params);
        resetTimers();
        const res = await sendRequest('inspect', params);
        if (!res.ok || !res.result) {
          throw new Error(res.error?.message ?? 'inspect 失败');
        }
        return res.result as InspectDecision;
      },
      async close(): Promise<void> {
        await doClose();
      }
    };

    async function doClose(): Promise<void> {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try {
        await sendRequest('shutdown', {});
      } catch {
        /* 忽略：worker 可能已退出 */
      }
      if (!child.killed) {
        child.kill('SIGTERM');
      }
    }

    resolve(client);
    resetTimers();
  });
}