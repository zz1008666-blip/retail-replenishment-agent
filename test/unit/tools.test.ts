import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app';

const PRINCIPAL = { id: 'op-1', role: 'operator' as const };

function seedGood(app: ReturnType<typeof createApp>, skuId: string): void {
  app.backend.seed(skuId, {
    BI: { sku: skuId, avg_daily_sales: 20, sales_window_days: 7 },
    ERP: { item_code: skuId, on_hand_qty: 30, reserved_qty: 5, lead_time_days: 7, unit_cost: 50, unit_price: 80 },
    INVENTORY: { sku_id: skuId, available: 25, in_transit: 0, safety_stock: 30, reorder_point: 100 },
    SALES: { sku: skuId, daily_units: 20, window_days: 7, as_of: new Date().toISOString() },
    PROMOTION: { sku: skuId, active: false, promo_type: 'NONE', multiplier: 1, promo_price: null, stacked: false }
  });
}

test('未知工具返回 invalidTool（fail-closed）', async () => {
  const app = createApp();
  const r = await app.tools.invoke('inventory.hack', {}, { principal: PRINCIPAL, session: { id: 's', skuIds: ['SKU-A'] } });
  assert.equal(r.invalidTool, true);
});

test('未授权 SKU 调用返回 invalidTool', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  const r = await app.tools.invoke('inventory.query', { skuId: 'SKU-A' }, { principal: PRINCIPAL, session: { id: 's', skuIds: ['SKU-A'] } });
  assert.equal(r.invalidTool, true, '无 read 授权应被拒');
});

test('session 范围外 SKU 调用被拒', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  app.grants.grant('op-1', 'sku', 'SKU-A', 'read');
  const r = await app.tools.invoke('inventory.query', { skuId: 'SKU-A' }, { principal: PRINCIPAL, session: { id: 's', skuIds: ['SKU-B'] } });
  assert.equal(r.invalidTool, true, 'SKU 不在 session 授权范围内应被拒');
});

test('授权 + session 范围内调用成功', async () => {
  const app = createApp();
  seedGood(app, 'SKU-A');
  app.grants.grant('op-1', 'sku', 'SKU-A', 'read');
  const r = await app.tools.invoke('inventory.query', { skuId: 'SKU-A' }, { principal: PRINCIPAL, session: { id: 's', skuIds: ['SKU-A'] } });
  assert.equal(r.ok, true);
});

test('session 工具面裁剪：只披露有授权的数据入口', () => {
  const app = createApp();
  const tools = app.tools.listForSession({ principal: PRINCIPAL, session: { id: 's', skuIds: [] } });
  assert.equal(tools.length, 0, '无 SKU 授权的 session 不应看到任何 SKU 数据工具');
});
