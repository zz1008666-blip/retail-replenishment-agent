/**
 * Regression Gate：跑全部 20 条 case，聚合 SKU Matching / Evidence Coverage /
 * Action Safety 三项指标，任一低于基线即阻断（退出码非 0）。
 */
import { createApp } from '../app';
import { CASES, runCase } from './cases';
import type { CaseResult } from './cases';

export interface GateResult {
  total: number;
  passed: number;
  results: CaseResult[];
  scenarioTotal: number;
  metrics: { skuMatching: string; evidenceCoverage: string; actionSafety: string };
  gatePass: boolean;
}

/** 基线：三项指标必须全量通过（确定性内核，允许 100% 断言） */
export const BASELINE = {
  skuMatching: 1.0,
  evidenceCoverage: 1.0,
  actionSafety: 1.0
};

export async function runGate(): Promise<GateResult> {
  const results: CaseResult[] = [];
  for (const tc of CASES) {
    const app = createApp(); // 每条 case 独立 app，隔离
    try {
      results.push(await runCase(app, tc));
    } catch (err) {
      results.push({ id: tc.id, name: tc.name, kind: tc.kind, passed: false, details: [String(err)] });
    }
  }

  const passed = results.filter((r) => r.passed).length;
  const scenarios = results.filter((r) => r.kind === 'scenario' && r.metrics);
  const n = scenarios.length;
  const count = (k: 'skuMatching' | 'evidenceCoverage' | 'actionSafety'): number =>
    scenarios.filter((s) => s.metrics![k]).length;

  const sku = count('skuMatching');
  const ev = count('evidenceCoverage');
  const saf = count('actionSafety');

  const gatePass =
    passed === CASES.length &&
    sku === n &&
    ev === n &&
    saf === n;

  return {
    total: CASES.length,
    passed,
    results,
    scenarioTotal: n,
    metrics: {
      skuMatching: `${sku}/${n}`,
      evidenceCoverage: `${ev}/${n}`,
      actionSafety: `${saf}/${n}`
    },
    gatePass
  };
}
