/**
 * 幂等控制：有副作用的动作只执行一次。
 * 通过 executed_action 表（action_key 唯一约束）+ INSERT 抢占实现，
 * 崩溃重试 / 重复恢复都不会把同一动作执行两遍。
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/connection';

export class IdempotencyGuard {
  constructor(private db: DatabaseSync) {}

  /**
   * 以幂等键执行副作用动作：同 key 只执行一次。
   * 返回 'executed'（本次执行）或 'skipped'（已存在，跳过）。
   */
  runOnce(actionKey: string, turnRunId: string, actionType: string, payload: unknown, fn: () => void): 'executed' | 'skipped' {
    return withTransaction(this.db, () => {
      const existing = this.db
        .prepare(`SELECT 1 FROM executed_action WHERE action_key = ?`)
        .get(actionKey);
      if (existing) return 'skipped';
      fn();
      this.db
        .prepare(
          `INSERT INTO executed_action (action_key, turn_run_id, action_type, payload) VALUES (?, ?, ?, ?)`
        )
        .run(actionKey, turnRunId, actionType, JSON.stringify(payload));
      return 'executed';
    });
  }

  has(actionKey: string): boolean {
    return this.db.prepare(`SELECT 1 FROM executed_action WHERE action_key = ?`).get(actionKey) !== undefined;
  }

  list(): { actionKey: string; actionType: string }[] {
    return this.db
      .prepare(`SELECT action_key, action_type FROM executed_action ORDER BY created_at`)
      .all() as unknown as { actionKey: string; actionType: string }[];
  }
}
