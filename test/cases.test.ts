/**
 * 20 条本地 case + 回归门禁（核心验收）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGate } from '../src/eval/gate';
import { CASES } from '../src/eval/cases';

test('20 条 case 全量通过', async () => {
  const gate = await runGate();
  const failed = gate.results.filter((r) => !r.passed);
  assert.equal(
    gate.passed,
    20,
    '以下 case 失败：\n' + failed.map((f) => `${f.id} ${f.name} -> ${(f.details ?? []).join(' | ')}`).join('\n')
  );
});

test('回归门禁：三项指标全量达标', async () => {
  const gate = await runGate();
  assert.equal(gate.gatePass, true);
  assert.deepEqual(gate.metrics, { skuMatching: '16/16', evidenceCoverage: '16/16', actionSafety: '16/16' });
});

test('case 编号唯一且恰好 20 条', () => {
  const ids = CASES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(CASES.length, 20);
});

test('六类故障样例齐全', () => {
  const cats = new Set(CASES.map((c) => c.category));
  for (const c of ['缺货误报', 'SKU 错配', '促销叠加', '毛利约束冲突', '审批拒绝', '工具重试']) {
    assert.ok(cats.has(c), `缺少故障样例类别：${c}`);
  }
});
