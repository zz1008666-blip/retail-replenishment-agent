/**
 * 四层架构（Client / Backend / Runner / Workspace）单元 + 集成测试。
 *
 * 覆盖：
 *   - Runner stdio JSON-RPC 协议（encode/decode 往返）
 *   - Runner 存活探针（liveness 竞态修复的数学关系）
 *   - IPC 投递与回执（顺序恢复 / 回执校验 / Turn 追踪）
 *   - Workspace 路径守卫（runId 白名单 + 目录隔离）
 *   - 平台级系统能力权限（admin 只对系统能力放行）
 *   - runAgentLoop（注入桩的纯函数：缺货处置 + 取数失败转人工）
 *   - 端到端 fork 子进程决策（真实 spawnRunner + createBackend）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createApp } from '../../src/app';
import { createBackend } from '../../src/backend';
import {
  encodeRunnerRpc,
  decodeRunnerRpc,
  type RunnerRpcMessage
} from '../../src/runner/protocol';
import { runAgentLoop } from '../../src/runner/agent-loop';
import { resolveRunnerLivenessTimeouts, RUNNER_SHUTDOWN_GRACE_MS } from '../../src/backend/protocol/liveness';
import {
  orderIpcInputMessages,
  parseIpcReceipt,
  isHealthyInputTurnCompletion,
  IpcTurnDeliveryTracker,
  type IpcInputMessage
} from '../../src/backend/protocol/ipc-delivery';
import { createWorkspace, safeRunId, workspaceExists, listWorkspaces, removeWorkspace } from '../../src/workspace';
import { hasSystemPermission } from '../../src/backend/protocol/permissions';
import type { InventorySnapshot } from '../../src/contract/types';
import type { ToolCallResult } from '../../src/runner/protocol';

// ---------------------------------------------------------------------------
// 1. stdio JSON-RPC 协议
// ---------------------------------------------------------------------------

test('runner 协议：request/response/event 编解码往返一致', () => {
  const frames: RunnerRpcMessage[] = [
    { kind: 'request', id: 1, method: 'inspect', params: { runId: 'r1' } },
    { kind: 'response', id: 1, ok: true, result: { pong: true } },
    { kind: 'event', name: 'status', payload: { status: 'ready' } }
  ];
  for (const frame of frames) {
    const decoded = decodeRunnerRpc(encodeRunnerRpc(frame).trim());
    assert.deepEqual(decoded, frame);
  }
});

test('runner 协议：非法 JSON / 空行回 undefined（fail-closed）', () => {
  assert.equal(decodeRunnerRpc(''), undefined);
  assert.equal(decodeRunnerRpc('   '), undefined);
  assert.equal(decodeRunnerRpc('不是 JSON'), undefined);
  assert.equal(decodeRunnerRpc('{"no":"kind"}'), undefined);
});

// ---------------------------------------------------------------------------
// 2. Runner 存活探针
// ---------------------------------------------------------------------------

test('liveness：温和回收先到（idleCloseMs=min），看门狗兜底晚到（watchdog=max+grace）', () => {
  const t = resolveRunnerLivenessTimeouts({
    executionTimeoutMs: 60_000,
    idleTimeoutMs: 30_000
  });
  assert.equal(t.idleCloseMs, 30_000, 'idleClose = min(60s, 30s)');
  assert.equal(t.watchdogMs, 60_000 + RUNNER_SHUTDOWN_GRACE_MS, 'watchdog = max(60s, 30s) + grace');
  assert.ok(t.idleCloseMs < t.watchdogMs, '温和回收必须先于外层看门狗');
});

// ---------------------------------------------------------------------------
// 3. IPC 投递与回执
// ---------------------------------------------------------------------------

function msg(receipt: { timestamp: string; id: string }): IpcInputMessage {
  return {
    text: 'x',
    receipt: {
      deliveryId: `d-${receipt.id}`,
      chatJid: 'sku:SKU-1',
      cursor: { timestamp: receipt.timestamp, id: receipt.id }
    }
  };
}

test('ipc-delivery：回执游标是权威顺序（非文件名顺序）', () => {
  const a = msg({ timestamp: '2026-10-08T10:00:00Z', id: 'b' });
  const b = msg({ timestamp: '2026-10-08T10:00:00Z', id: 'a' });
  const ordered = orderIpcInputMessages([a, b]);
  assert.equal(ordered[0], b, '同时间戳时 id 小的排前');
});

test('ipc-delivery：回执严格校验，缺字段回 undefined', () => {
  assert.ok(parseIpcReceipt(msg({ timestamp: '2026-10-08T10:00:00Z', id: 'a' }).receipt));
  assert.equal(parseIpcReceipt({ deliveryId: 'd', chatJid: 'c' }), undefined, '缺 cursor 必须拒绝');
});

test('ipc-delivery：Turn 追踪只在健康完成时推进', () => {
  const first = msg({ timestamp: 't0', id: '0' });
  const tracker = new IpcTurnDeliveryTracker([first]);
  assert.equal(tracker.pendingTurnCount, 1);
  tracker.acceptTurn([msg({ timestamp: 't1', id: '1' })]);
  assert.equal(tracker.pendingTurnCount, 2);
  // 后台任务未清空 => 不健康，不应 completeNextTurn
  assert.equal(isHealthyInputTurnCompletion(1, false), false);
  tracker.cancelCurrentTurn();
  assert.equal(tracker.pendingTurnCount, 1, '取消当前 turn 后剩一个待处理 turn');
});

// ---------------------------------------------------------------------------
// 4. Workspace 隔离与路径守卫
// ---------------------------------------------------------------------------

test('workspace：runId 白名单化，恶意路径无法穿越', () => {
  assert.equal(safeRunId('a/b c'), 'a_b_c');
  assert.equal(safeRunId('../evil'), '___evil', '两个点 + 一个斜杠 => 三个下划线');
  assert.equal(safeRunId('///'), '___', '非法字符全部替换，绝不抛异常导致崩溃');
});

test('workspace：创建 / 存在 / 列举 / 回收全链路', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rra-ws-'));
  try {
    const ws = createWorkspace(root, 'run-1');
    assert.ok(fs.existsSync(ws.dir));
    ws.writeDecision({ skuId: 'SKU-1', decision: { skuId: 'SKU-1' } });
    ws.appendTrace({ eventType: 'status', text: 'ok' });
    assert.ok(fs.existsSync(path.join(ws.dir, 'decision.json')));
    assert.ok(fs.existsSync(path.join(ws.dir, 'trace.ndjson')));

    assert.equal(workspaceExists(root, 'run-1'), true);
    assert.ok(listWorkspaces(root).includes('run-1'));

    removeWorkspace(root, 'run-1');
    assert.equal(workspaceExists(root, 'run-1'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. 平台级系统能力权限
// ---------------------------------------------------------------------------

test('permissions：admin 对系统能力放行，member 须显式授权', () => {
  assert.equal(hasSystemPermission({ role: 'admin', permissions: [] }, 'manage_users'), true);
  assert.equal(hasSystemPermission({ role: 'member', permissions: [] }, 'manage_users'), false);
  assert.equal(
    hasSystemPermission({ role: 'member', permissions: ['manage_users'] }, 'manage_users'),
    true
  );
});

// ---------------------------------------------------------------------------
// 6. runAgentLoop（注入桩，纯函数，无 fork）
// ---------------------------------------------------------------------------

function stockoutSnapshot(): InventorySnapshot {
  return {
    skuId: 'SKU-TEST',
    window: { start: '2026-10-01', end: '2026-10-08' },
    asOf: '2026-10-08T10:00:00Z',
    onHand: 40,
    inTransit: 10,
    reserved: 8,
    dailyDemand: 25,
    leadTimeDays: 5,
    safetyStock: 40,
    reorderPoint: 120,
    promotion: { active: false, type: 'NONE', demandFactor: 1, stacked: false },
    cost: 30,
    price: 59,
    provenance: { onHand: 'ERP', cost: 'ERP', price: 'ERP', dailyDemand: 'SALES' }
  };
}

const PARAMS = {
  runId: 'run-test',
  skuId: 'SKU-TEST',
  principal: { id: 'op-1', role: 'operator' },
  session: { id: 's', skuIds: ['SKU-TEST'] }
};

test('runAgentLoop：缺货快照产出可执行补货建议', async () => {
  const res = await runAgentLoop(PARAMS, {
    invokeTool: async (_runId, tool): Promise<ToolCallResult> => {
      if (tool === 'inventory.query') return { ok: true, data: { snapshot: stockoutSnapshot(), warnings: [] } };
      if (tool === 'memory.recall_cases') return { ok: true, data: { cases: [] } };
      return { ok: false, invalidTool: true, error: `unknown:${tool}` };
    }
  });
  assert.equal(res.decision.anomaly.kind, 'stockout');
  assert.equal(res.decision.advice.action, 'create_replenishment_order');
  assert.equal(res.decision.blocked, false);
});

test('runAgentLoop：取数失败（invalidTool）转人工并阻断', async () => {
  const res = await runAgentLoop(PARAMS, {
    invokeTool: async (): Promise<ToolCallResult> => ({
      ok: false,
      invalidTool: true,
      error: '未授权读取该 SKU'
    })
  });
  assert.equal(res.decision.blocked, true);
  assert.equal(res.decision.advice.action, 'none');
  assert.equal(res.decision.advice.rationale, '取数失败，转人工');
});

// ---------------------------------------------------------------------------
// 7. 端到端 fork 子进程决策（真实进程隔离）
// ---------------------------------------------------------------------------

test('四层 fork 路径：Backend fork Runner 子进程完成一次巡检', { timeout: 20_000 }, async () => {
  const app = createApp({ dbPath: ':memory:' });
  const skuId = 'SKU-DEMO-1';
  app.backend.seed(skuId, {
    BI: { sku: skuId, avg_daily_sales: 25, sales_window_days: 7 },
    ERP: { item_code: skuId, on_hand_qty: 40, reserved_qty: 8, lead_time_days: 5, unit_cost: 30, unit_price: 59 },
    INVENTORY: { sku_id: skuId, available: 32, in_transit: 10, safety_stock: 40, reorder_point: 120 },
    SALES: { sku: skuId, daily_units: 25, window_days: 7, as_of: new Date().toISOString() },
    PROMOTION: { sku: skuId, active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
  });
  for (const p of ['read', 'advise', 'execute'] as const) {
    app.grants.grant('demo-operator', 'sku', skuId, p);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rra-fork-'));
  const backend = await createBackend(app, { workspaceRoot: root });
  try {
    const rec = await backend.inspect(skuId, { id: 'demo-operator', role: 'operator' }, { id: 's', skuIds: [skuId] });
    assert.equal(rec.skuId, skuId);
    assert.equal(rec.decision.anomaly.kind, 'stockout');
    assert.equal(rec.decision.advice.action, 'create_replenishment_order');
    assert.ok(rec.events.length > 0, '应产出 StreamEvent 轨迹');
    assert.ok(rec.events.some((e) => e.eventType === 'memory_recall'), '应包含案例召回事件');
    assert.ok(fs.existsSync(rec.workspaceDir), '工作区目录应被创建');
  } finally {
    await backend.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});