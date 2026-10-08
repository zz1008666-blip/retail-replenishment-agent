/**
 * Runner 子进程入口（worker）：通过 stdio 与 Backend 对等的 JSON-RPC 进程。
 *
 * 它是 fork 出来的独立进程，职责单一：
 *   - 读取 stdin 上的 RPC 帧（inspect / ping / shutdown）
 *   - 每收到一次 inspect，就跑一遍决策环（见 agent-loop.ts）
 *   - 决策环里需要数据时，向 stdout 发 tool_call 请求，等 Backend 回 response
 *   - 产出 StreamEvent / decision / done 帧
 *
 * 硬约束：本进程绝不连接数据库、绝不写业务数据——数据只能向 Backend 要。
 * 所有诊断日志走 stderr，stdout 只承载 RPC 协议帧，避免污染通信流。
 */
import readline from 'node:readline';
import {
  encodeRunnerRpc,
  decodeRunnerRpc,
  type RunnerRpcMessage,
  type RunnerRpcRequest,
  type RunnerRpcResponse,
  type InspectParams,
  type InspectDecision,
  type ToolCallResult
} from './protocol';
import { runAgentLoop } from './agent-loop';
import type { StreamEvent } from '../backend/protocol/stream-event.types';

let requestSeq = 0;
const pending = new Map<
  number,
  { resolve: (r: RunnerRpcResponse) => void; reject: (e: Error) => void }
>();

function send(msg: RunnerRpcMessage): void {
  process.stdout.write(encodeRunnerRpc(msg));
}

function sendRequest(method: RunnerRpcRequest['method'], params: unknown): Promise<RunnerRpcResponse> {
  const id = ++requestSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ kind: 'request', id, method, params });
  });
}

function log(...args: unknown[]): void {
  process.stderr.write(`[runner-worker] ${args.join(' ')}\n`);
}

async function handleRequest(req: RunnerRpcRequest): Promise<void> {
  if (req.method === 'ping') {
    send({ kind: 'response', id: req.id, ok: true, result: { pong: true } });
    return;
  }
  if (req.method === 'shutdown') {
    send({ kind: 'response', id: req.id, ok: true, result: {} });
    // 给回执一点时间刷出去，再优雅退出（对应 liveness 的 shutdownGrace）
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (req.method === 'inspect') {
    const params = req.params as InspectParams;
    const invokeTool = (
      runId: string,
      tool: string,
      input: Record<string, unknown>
    ): Promise<ToolCallResult> =>
      sendRequest('tool_call', { runId, tool, input }).then((res) => {
        if (!res.ok || !res.result) {
          return {
            ok: false,
            invalidTool: true,
            error: res.error?.message ?? 'tool_call 失败'
          };
        }
        return res.result as ToolCallResult;
      });

    const emit = (runId: string, event: StreamEvent): void => {
      send({
        kind: 'event',
        name: 'stream_event',
        payload: { runId, event: { ...event, turnId: runId } }
      });
    };

    try {
      const { decision } = await runAgentLoop(params, { invokeTool, emit });
      const result: InspectDecision = { runId: params.runId, decision };
      send({ kind: 'response', id: req.id, ok: true, result });
      send({ kind: 'event', name: 'done', payload: { runId: params.runId } });
    } catch (err) {
      log('inspect 失败:', err);
      send({
        kind: 'response',
        id: req.id,
        ok: false,
        error: { code: 'RUNNER_ERROR', message: err instanceof Error ? err.message : String(err) }
      });
    }
    return;
  }
  send({
    kind: 'response',
    id: req.id,
    ok: false,
    error: { code: 'UNKNOWN_METHOD', message: String(req.method) }
  });
}

function dispatch(line: string): void {
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
  if (msg.kind === 'request') {
    void handleRequest(msg);
  }
  // event（Backend 不应主动发 event，这里直接忽略）
}

function ready(): void {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });
  rl.on('line', (line) => dispatch(line));
  rl.on('error', (err) => log('stdin 读取错误:', err));
  send({ kind: 'event', name: 'status', payload: { status: 'ready' } });
}

ready();