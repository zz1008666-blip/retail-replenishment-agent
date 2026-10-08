import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app';
import { ACTION_LEVELS } from '../../src/acl';

test('动作分级矩阵：查询/建议 AUTO，补货单/调价/下架 APPROVAL，删除 BLOCKED', () => {
  assert.equal(ACTION_LEVELS['read_inventory'], 'AUTO');
  assert.equal(ACTION_LEVELS['generate_advice'], 'AUTO');
  assert.equal(ACTION_LEVELS['create_replenishment_order'], 'APPROVAL');
  assert.equal(ACTION_LEVELS['adjust_price'], 'APPROVAL');
  assert.equal(ACTION_LEVELS['delist'], 'APPROVAL');
  assert.equal(ACTION_LEVELS['delete_data'], 'BLOCKED');
});

test('BLOCKED 动作永远拒绝，无旁路', () => {
  const app = createApp();
  app.grants.grant('admin-1', 'sku', '*', 'delete');
  const d = app.acl.authorize({ id: 'admin-1', role: 'admin' }, 'delete_data', { type: 'sku', id: 'SKU-X' });
  assert.equal(d.allowed, false);
});

test('admin 在工作区资源层无旁路：判断函数不读 role', () => {
  const app = createApp();
  // admin 只有系统能力，无 SKU 资源授权
  app.grants.grant('admin-1', 'system', '*', 'approve');
  const d = app.acl.authorize({ id: 'admin-1', role: 'admin' }, 'read_inventory', { type: 'sku', id: 'SKU-X' });
  assert.equal(d.allowed, false, 'admin 不应因角色而越过资源归属检查');
});

test('有 SKU 资源授权才可读取', () => {
  const app = createApp();
  app.grants.grant('op-1', 'sku', 'SKU-X', 'read');
  const d = app.acl.authorize({ id: 'op-1', role: 'operator' }, 'read_inventory', { type: 'sku', id: 'SKU-X' });
  assert.equal(d.allowed, true);
});
