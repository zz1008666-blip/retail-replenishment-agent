/**
 * CLI 入口：rra eval / rra run
 */
import { createApp } from './app';
import { runGate } from './eval/gate';
import type { Principal } from './acl';

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function cmdEval(): Promise<void> {
  console.log('零售库存补货决策智能体 · Trace Eval（20 条 case + 回归门禁）\n');
  const gate = await runGate();
  console.log(' id         结果  分类        名称');
  console.log('------------------------------------------------------');
  for (const r of gate.results) {
    const mark = r.passed ? 'PASS' : 'FAIL';
    console.log(` ${pad(r.id, 10)} ${mark}   ${pad(r.name, 12)} ${r.id}`);
    if (!r.passed && r.details) {
      for (const d of r.details) console.log(`              ↳ ${d}`);
    }
  }
  console.log('------------------------------------------------------');
  console.log(` 通过 ${gate.passed}/${gate.total}`);
  console.log(` SKU Matching      ${gate.metrics.skuMatching}`);
  console.log(` Evidence Coverage ${gate.metrics.evidenceCoverage}`);
  console.log(` Action Safety     ${gate.metrics.actionSafety}`);
  console.log('');
  if (gate.gatePass) {
    console.log('✅ Regression Gate 通过：三项指标全量达标，允许发布');
  } else {
    console.log('❌ Regression Gate 阻断：存在断言失败或指标低于基线');
    process.exitCode = 1;
  }
}

async function cmdRun(): Promise<void> {
  const fs = await import('node:fs');
  fs.mkdirSync('data', { recursive: true });
  const app = createApp({ dbPath: 'data/app.db' });

  const skuId = 'SKU-DEMO-1';
  app.backend.seed(skuId, {
    BI: { sku: skuId, avg_daily_sales: 25, sales_window_days: 7 },
    ERP: { item_code: skuId, on_hand_qty: 40, reserved_qty: 8, lead_time_days: 5, unit_cost: 30, unit_price: 59 },
    INVENTORY: { sku_id: skuId, available: 32, in_transit: 10, safety_stock: 40, reorder_point: 120 },
    SALES: { sku: skuId, daily_units: 25, window_days: 7, as_of: new Date().toISOString() },
    PROMOTION: { sku: skuId, active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
  });

  const operator: Principal = { id: 'operator-1', role: 'operator' };
  for (const p of ['read', 'advise', 'execute'] as const) {
    app.grants.grant(operator.id, 'sku', skuId, p);
  }

  const taskId = app.scheduler.register({
    name: 'inventory-inspect-demo',
    kind: 'periodic',
    cron: '0 * * * *',
    params: { scope: skuId }
  });

  const wf = await app.workflow.inspect(skuId, operator, { id: 'sess-demo', skuIds: [skuId] });
  console.log('=== 巡检结果 ===');
  console.log(JSON.stringify({ turnRunId: wf.turnRunId, status: wf.status, anomaly: wf.decision?.anomaly, advice: wf.decision?.advice }, null, 2));

  if (wf.status === 'awaiting_approval' && wf.turnRunId) {
    const done = await app.workflow.approve(wf.turnRunId, 'approver-1', '演示审批同意');
    console.log('=== 审批执行 ===');
    console.log(JSON.stringify({ status: done.status, phase: done.phase, sideEffects: app.sideEffects }, null, 2));
  }

  console.log(`\n已注册巡检任务 #${taskId}；证据账本条数=${app.ledger.list(wf.turnRunId).length}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'eval';
  if (cmd === 'eval') return cmdEval();
  if (cmd === 'run') return cmdRun();
  console.log('用法：node dist/src/cli.js <eval|run>');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
