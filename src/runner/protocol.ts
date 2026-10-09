/**
 * Runner stdio JSON-RPC 协议（Backend ↔ Runner 的进程间契约）。
 *
 * 这是 MCP（Model Context Protocol）的最小原型：Backend 与 Runner 是两个进程，
 * 通过 stdin/stdout 用「换行分隔的 JSON 消息」通信，语义与 MCP 的
 * request/response/notification 一一对应：
 *   - request  + id  → 期待对方 response（id 回显）
 *   - event    → 单向通知（无 id，无需回执）
 *
 * 与「宿主 ↔ Runner」的 IPC 协议同构，载体采用
 * child_process.fork + stdio，保住了「HR 五分钟 npm test 单机跑通」
 * 的硬约束（不需要 Docker）。
 *
 * 进程分工：
 *   - Backend（真相源 + 授权）：不发业务数据给 Runner，只回应 Runner 的取数请求。
 *   - Runner（agent-loop）：不连 DB、不存业务数据，拿不到的就是拿不到。
 */
import type { Decision } from '../agent/decision';
import type { StreamEvent } from '../backend/protocol/stream-event.types';

/** Backend → Runner 的方法（request 方向） */
export type RunnerMethod = 'inspect' | 'shutdown' | 'ping';

/** Runner → Backend 的方法（request 方向） */
export type RunnerToolMethod = 'tool_call';

/** Runner → Backend 的单向事件 */
export type RunnerEventName = 'stream_event' | 'decision' | 'done' | 'error' | 'status';

export interface RunnerRpcRequest {
  kind: 'request';
  id: number;
  method: RunnerMethod | RunnerToolMethod;
  params: unknown;
}

export interface RunnerRpcResponse {
  kind: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface RunnerRpcEvent {
  kind: 'event';
  name: RunnerEventName;
  payload: unknown;
}

export type RunnerRpcMessage =
  | RunnerRpcRequest
  | RunnerRpcResponse
  | RunnerRpcEvent;

/** inspect 入参：只带「身份 + 授权范围」，不带任何业务数据 */
export interface InspectParams {
  runId: string;
  skuId: string;
  principal: { id: string; role: string };
  session: { id: string; skuIds: string[] };
}

export interface ToolCallParams {
  /** 关联的巡检 runId，Backend 据此还原 principal/session 以做 ACL */
  runId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolCallResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  invalidTool?: boolean;
}

export interface InspectDecision {
  runId: string;
  decision: Decision;
}

export interface StreamEventPayload {
  runId: string;
  event: StreamEvent;
}

/** 写出一条换行分隔的 JSON 帧（U+0022 直引号，JSON 合法） */
export function encodeRunnerRpc(msg: RunnerRpcMessage): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeRunnerRpc(line: string): RunnerRpcMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as RunnerRpcMessage;
    if (!value || typeof value !== 'object' || !('kind' in value)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}