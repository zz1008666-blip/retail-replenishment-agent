import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app';
import { CaseConflictError } from '../../src/memory/case';

test('CAS：stale revision 更新抛 CaseConflictError', () => {
  const app = createApp();
  const c = app.caseStore.create({ skuId: 'SKU-A', anomalyType: 'stockout', cause: '供应商断供', action: 'create_replenishment_order', outcome: 'ok' });
  app.caseStore.update(c.id, c.revision, { cause: '修订1' }); // rev -> 2
  assert.throws(() => app.caseStore.update(c.id, c.revision, { cause: '旧版本' }), CaseConflictError);
});

test('CAS：revision 匹配则写入并递增', () => {
  const app = createApp();
  const c = app.caseStore.create({ skuId: 'SKU-A', anomalyType: 'stockout', cause: 'a', action: 'b', outcome: 'c' });
  const u = app.caseStore.update(c.id, c.revision, { cause: '改' });
  assert.equal(u.revision, 2);
  assert.equal(u.cause, '改');
});

test('FTS5：按 SKU 与关键词召回，短关键词降级 LIKE', () => {
  const app = createApp();
  app.caseStore.create({ skuId: 'SKU-A', anomalyType: 'stockout', cause: '供应商断供', action: '加急补货', outcome: '恢复' });
  app.caseStore.create({ skuId: 'SKU-A', anomalyType: 'overstock', cause: '促销结束积压', action: '调价', outcome: '清完' });
  app.caseStore.create({ skuId: 'SKU-B', anomalyType: 'stockout', cause: '供应商断供', action: '加急补货', outcome: '恢复' });

  const bySku = app.caseStore.recallBySku('SKU-A');
  assert.equal(bySku.length, 2);

  // 关键词（长）走 FTS
  const kw = app.caseStore.recall('SKU-A', { keyword: '供应商断供' });
  assert.ok(kw.length >= 1);

  // 短关键词（<3）降级 LIKE
  const short = app.caseStore.recall('SKU-A', { keyword: '断供' });
  assert.ok(short.some((c) => c.cause.includes('断供')));
});
