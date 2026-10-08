import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { InventorySnapshot } from '../../src/contract/types';
import { detect, decide, replenishQty, DEFAULT_CONFIG } from '../../src/agent/decision';

function snap(over: Partial<InventorySnapshot>): InventorySnapshot {
  return {
    skuId: 'SKU-A',
    window: { start: '2026-01-01', end: '2026-01-07' },
    asOf: new Date().toISOString(),
    onHand: 30,
    inTransit: 0,
    reserved: 5,
    dailyDemand: 20,
    leadTimeDays: 7,
    safetyStock: 30,
    reorderPoint: 100,
    promotion: { active: false, type: 'NONE', demandFactor: 1, stacked: false },
    cost: 50,
    price: 80,
    provenance: { onHand: 'ERP', reserved: 'ERP', dailyDemand: 'BI', cost: 'ERP', price: 'ERP' },
    ...over
  };
}

test('detect：可售低于 ROP 判缺货', () => {
  const d = detect(snap({}), []);
  assert.equal(d.anomaly.kind, 'stockout');
});

test('detect：促销中可售高于安全库存不误报', () => {
  const d = detect(snap({ onHand: 60, reserved: 5, promotion: { active: true, type: 'FLASH_SALE', demandFactor: 3, stacked: false } }), []);
  assert.equal(d.anomaly.kind, 'none');
});

test('detect：可售天数超阈值判积压', () => {
  const d = detect(snap({ onHand: 2000, reserved: 0, dailyDemand: 10 }), []);
  assert.equal(d.anomaly.kind, 'overstock');
});

test('detect：销量口径冲突阻断', () => {
  const d = detect(snap({}), [
    { field: 'dailyDemand', kind: 'CONFLICT', message: 'x', sources: ['BI', 'SALES'] }
  ]);
  assert.equal(d.blocked, true);
});

test('decide：毛利为负时拦截补货建议', () => {
  const d = decide(
    snap({ promotion: { active: true, type: 'FLASH_SALE', demandFactor: 4, promoPrice: 40, stacked: false } }),
    { anomaly: { kind: 'stockout', severity: 'high', reason: 'x' }, blocked: false },
    []
  );
  assert.equal(d.advice.action, 'none');
  assert.equal(d.advice.marginCheck.ok, false);
});

test('decide：促销叠加但毛利达标时正常补货', () => {
  const d = decide(
    snap({ promotion: { active: true, type: 'FULL_REDUCTION', demandFactor: 3, promoPrice: 70, stacked: true } }),
    { anomaly: { kind: 'stockout', severity: 'high', reason: 'x' }, blocked: false },
    []
  );
  assert.equal(d.advice.action, 'create_replenishment_order');
  assert.equal(d.advice.marginCheck.ok, true);
});

test('replenishQty：补货量 = 目标覆盖需求 - 现有可售', () => {
  // 20*30=600 覆盖需求；现有可售=30+0-5=25 → 575
  assert.equal(replenishQty(snap({}), DEFAULT_CONFIG), 575);
});

test('decide：复用历史有效案例', () => {
  const d = decide(
    snap({}),
    { anomaly: { kind: 'stockout', severity: 'high', reason: 'x' }, blocked: false },
    [{ id: 7, skuId: 'SKU-A', anomalyType: 'stockout', cause: '供应商断供', action: 'create_replenishment_order', outcome: 'ok', outcomeOk: true, occurredAt: '', revision: 1 }]
  );
  assert.equal(d.advice.reusedCaseId, 7);
});
