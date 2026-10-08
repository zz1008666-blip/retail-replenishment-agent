import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/app';
import { nextAfter } from '../../src/scheduler/cron';

test('cron：每小时的 nextAfter 正确', () => {
  const from = new Date(Date.UTC(2026, 0, 1, 0, 30, 0));
  const next = nextAfter('0 * * * *', from);
  assert.equal(next.toISOString(), '2026-01-01T01:00:00.000Z');
});

test('调度：tick 物化 occurrence，重复 tick 不重复（occurrence_key 幂等）', () => {
  const app = createApp();
  const base = new Date(Date.UTC(2026, 0, 1, 0, 30, 0));
  app.scheduler.register({ name: 't', kind: 'periodic', cron: '0 * * * *' }, base);
  const t1 = app.scheduler.tick(new Date(Date.UTC(2026, 0, 1, 1, 0, 0)));
  assert.equal(t1.length, 1);
  // 同一时刻再次 tick，游标已推进，不应再物化
  const t2 = app.scheduler.tick(new Date(Date.UTC(2026, 0, 1, 1, 0, 0)));
  assert.equal(t2.length, 0);
  assert.equal(app.scheduler.listOccurrences().length, 1);
});

test('调度：next_run 兼任乐观锁，认领后游标推进', () => {
  const app = createApp();
  const base = new Date(Date.UTC(2026, 0, 1, 0, 30, 0));
  app.scheduler.register({ name: 't', kind: 'periodic', cron: '0 * * * *' }, base);
  const rows0 = app.db.prepare(`SELECT next_run FROM scheduled_task`).all() as unknown as { next_run: string }[];
  assert.equal(rows0[0].next_run, '2026-01-01T01:00:00.000Z');
  app.scheduler.tick(new Date(Date.UTC(2026, 0, 1, 1, 0, 0)));
  const rows1 = app.db.prepare(`SELECT next_run FROM scheduled_task`).all() as unknown as { next_run: string }[];
  assert.equal(rows1[0].next_run, '2026-01-01T02:00:00.000Z');
});

test('一次性任务 tick 后标记 done，不再重复触发', () => {
  const app = createApp();
  app.scheduler.register({ name: 'once', kind: 'once', runAt: '2026-01-01T00:30:00.000Z' });
  const occ1 = app.scheduler.tick(new Date(Date.UTC(2026, 0, 1, 1, 0, 0)));
  assert.equal(occ1.length, 1);
  const occ2 = app.scheduler.tick(new Date(Date.UTC(2026, 0, 1, 2, 0, 0)));
  assert.equal(occ2.length, 0);
});
