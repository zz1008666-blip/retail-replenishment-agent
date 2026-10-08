/**
 * 定时巡检调度器：Cron 双层数据模型。
 *
 * 定义层 scheduled_task：周期/一次性任务，next_run 字段兼任
 *   调度游标（跑到哪了）与乐观锁（谁先推进谁执行）。
 * 触发实例层 task_occurrence：occurrence_key 唯一约束，幂等物化每次触发。
 *
 * 重启语义：
 *  - 周期任务错过的轮次标记 missed 不补跑（防追债级联）；
 *  - 一次性任务错过必达（backfill 补建 occurrence）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction, lastId } from '../db/connection';
import { nextAfter, formatIso } from './cron';

export interface RegisterParams {
  name: string;
  kind: 'periodic' | 'once';
  cron?: string;
  runAt?: string; // ISO，一次性任务
  params?: Record<string, unknown>;
}

export interface Occurrence {
  id: number;
  taskId: number;
  occurrenceKey: string;
  runAt: string;
  status: string;
}

export class Scheduler {
  constructor(private db: DatabaseSync) {}

  /** 注册任务并计算初始 next_run；now 用于测试注入时钟 */
  register(p: RegisterParams, now: Date = new Date()): number {
    let nextRun: string;
    if (p.kind === 'once') {
      if (!p.runAt) throw new Error('一次性任务需要 runAt');
      nextRun = new Date(p.runAt).toISOString();
    } else {
      if (!p.cron) throw new Error('周期任务需要 cron');
      nextRun = formatIso(nextAfter(p.cron, now));
    }
    const r = this.db
      .prepare(
        `INSERT INTO scheduled_task (name, kind, cron, run_at, params, next_run)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(p.name, p.kind, p.cron ?? null, p.runAt ?? null, JSON.stringify(p.params ?? {}), nextRun);
    return lastId(r as { changes: number; lastInsertRowid: number | bigint });
  }

  /**
   * 推进调度：把到期的任务物化为 occurrence。
   * 返回本次新物化的 occurrence 列表。
   */
  tick(now: Date = new Date()): Occurrence[] {
    const nowIso = now.toISOString();
    const due = this.db
      .prepare(`SELECT * FROM scheduled_task WHERE status != 'done' AND next_run <= ?`)
      .all(nowIso) as unknown as ScheduledTaskRow[];
    const created: Occurrence[] = [];
    for (const task of due) {
      withTransaction(this.db, () => {
        const claimed = this.claim(task.id, task.next_run, now);
        if (!claimed) return;
        const occ = this.materialize(task, task.next_run);
        if (occ) created.push(occ);
      });
    }
    return created;
  }

  /**
   * 重启恢复：处理停机期间错过的任务。
   *  - 周期任务：missed 不补跑（推进 next_run 游标跳过）
   *  - 一次性任务：必达（补建 occurrence）
   */
  recover(now: Date = new Date()): { missed: number; backfilled: Occurrence[] } {
    const nowIso = now.toISOString();
    const overdue = this.db
      .prepare(`SELECT * FROM scheduled_task WHERE status != 'done' AND next_run < ?`)
      .all(nowIso) as unknown as ScheduledTaskRow[];
    let missed = 0;
    const backfilled: Occurrence[] = [];
    for (const task of overdue) {
      withTransaction(this.db, () => {
        if (task.kind === 'periodic') {
          // missed 不补跑：只推进游标到下一个未来时间，不物化 occurrence
          this.advancePeriodicPast(task, now);
          missed++;
        } else {
          // 一次性必达：补建 occurrence，任务置 done
          const occ = this.materialize(task, task.next_run);
          if (occ) backfilled.push(occ);
          this.db.prepare(`UPDATE scheduled_task SET status = 'done' WHERE id = ?`).run(task.id);
        }
      });
    }
    return { missed, backfilled };
  }

  /**
   * 乐观锁认领：仅当 next_run 仍是读取时的值才推进。
   * 返回是否认领成功（多实例竞争只有一个成功）。
   */
  private claim(taskId: number, expectedNextRun: string, now: Date): boolean {
    const task = this.db
      .prepare(`SELECT * FROM scheduled_task WHERE id = ?`)
      .get(taskId) as unknown as ScheduledTaskRow;
    if (!task) return false;
    if (task.kind === 'once') {
      // 一次性任务：推进到 done 状态
      const r = this.db
        .prepare(`UPDATE scheduled_task SET status = 'done' WHERE id = ? AND next_run = ?`)
        .run(taskId, expectedNextRun);
      return (r as { changes: number }).changes === 1;
    }
    // 周期任务：next_run 既是游标也是乐观锁
    const newNext = formatIso(nextAfter(task.cron!, new Date(expectedNextRun)));
    const r = this.db
      .prepare(`UPDATE scheduled_task SET next_run = ? WHERE id = ? AND next_run = ?`)
      .run(newNext, taskId, expectedNextRun);
    return (r as { changes: number }).changes === 1;
  }

  /** 幂等物化：occurrence_key 唯一约束保证重复物化只生效一次 */
  private materialize(task: ScheduledTaskRow, runAtIso: string): Occurrence | null {
    const key = `${task.id}@${runAtIso}`;
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO task_occurrence (task_id, occurrence_key, run_at, status)
         VALUES (?, ?, ?, 'pending')`
      )
      .run(task.id, key, runAtIso);
    const changes = (r as { changes: number }).changes;
    if (changes === 0) return null;
    const id = lastId(r as { changes: number; lastInsertRowid: number | bigint });
    return { id, taskId: task.id, occurrenceKey: key, runAt: runAtIso, status: 'pending' };
  }

  /** 周期任务 missed：跳过所有已过期轮次，把 next_run 推进到未来 */
  private advancePeriodicPast(task: ScheduledTaskRow, now: Date): void {
    let cursor = new Date(task.next_run);
    let guard = 0;
    while (cursor.getTime() < now.getTime() && guard < 100000) {
      cursor = nextAfter(task.cron!, cursor);
      guard++;
    }
    this.db.prepare(`UPDATE scheduled_task SET next_run = ? WHERE id = ?`).run(formatIso(cursor), task.id);
  }

  listOccurrences(): Occurrence[] {
    return this.db
      .prepare(`SELECT id, task_id, occurrence_key, run_at, status FROM task_occurrence ORDER BY id`)
      .all() as unknown as Occurrence[];
  }
}

interface ScheduledTaskRow {
  id: number;
  name: string;
  kind: 'periodic' | 'once';
  cron: string | null;
  run_at: string | null;
  params: string;
  next_run: string;
  status: string;
}
