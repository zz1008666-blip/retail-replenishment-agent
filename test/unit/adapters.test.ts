import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app';

function seedGood(app: ReturnType<typeof createApp>, skuId: string): void {
  app.backend.seed(skuId, {
    BI: { sku: skuId, avg_daily_sales: 20, sales_window_days: 7 },
    ERP: { item_code: skuId, on_hand_qty: 30, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 },
    INVENTORY: { sku_id: skuId, available: 25, in_transit: 0, safety_stock: 30, reorder_point: 100 },
    SALES: { sku: skuId, daily_units: 20, window_days: 7, as_of: new Date().toISOString() },
    PROMOTION: { sku: skuId, active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
  });
}

test('归一化：无冲突时字段带 provenance', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  const { snapshot, warnings } = await app.catalog.query('SKU-A', { start: '2026-01-01', end: '2026-01-07' });
  assert.equal(warnings.length, 0);
  assert.equal(snapshot.onHand, 30);
  assert.equal(snapshot.reserved, 5);
  assert.equal(snapshot.dailyDemand, 20);
  assert.equal(snapshot.provenance['onHand'], 'ERP');
  assert.equal(snapshot.provenance['dailyDemand'], 'BI');
});

test('归一化：BI 与 SALES 销量口径冲突产生 CONFLICT 告警', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  app.backend.put('SKU-A', 'SALES', { sku: 'SKU-A', daily_units: 50, window_days: 7, as_of: new Date().toISOString() });
  const { warnings } = await app.catalog.query('SKU-A', { start: '2026-01-01', end: '2026-01-07' });
  const conflict = warnings.find((w) => w.kind === 'CONFLICT' && w.field === 'dailyDemand');
  assert.ok(conflict, '应产生 dailyDemand 口径冲突');
});

test('归一化：SKU 错配产生 MISMATCH 告警', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  app.backend.put('SKU-A', 'ERP', {
    item_code: 'SKU-B',
    on_hand_qty: 30,
    reserved_qty: 5,
    lead_time_days: 7,
    unit_cost: 50,
    unit_price: 80
  });
  const { warnings } = await app.catalog.query('SKU-A', { start: '2026-01-01', end: '2026-01-07' });
  assert.ok(warnings.some((w) => w.kind === 'MISMATCH'), '应产生 SKU 错配告警');
});

test('可售 = 在库 - 预留，可售天数计算正确', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  const { snapshot } = await app.catalog.query('SKU-A', { start: '2026-01-01', end: '2026-01-07' });
  assert.equal(snapshot.onHand - snapshot.reserved, 25);
  assert.equal(25 / snapshot.dailyDemand, 1.25);
});
