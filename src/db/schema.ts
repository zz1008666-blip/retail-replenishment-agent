/**
 * 数据库 Schema：把领域不变量下沉到 SQLite 约束（CHECK / UNIQUE）。
 * 迁移采用幂等 DDL（CREATE TABLE IF NOT EXISTS），可重复执行。
 */
import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync): void {
  // ---------- 定时任务（定义层 + 触发实例层 = 双层模型） ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_task (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      kind          TEXT    NOT NULL CHECK (kind IN ('periodic','once')),
      cron          TEXT,                         -- 周期表达式（周期任务）
      run_at        TEXT,                         -- 一次性任务触发时间
      params        TEXT    NOT NULL DEFAULT '{}',-- 任务参数（如 sku_id、巡检范围）
      next_run      TEXT    NOT NULL,             -- 下次运行时间：游标 + 乐观锁
      status        TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','paused','done','missed')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- occurrence_key 唯一约束：同一个触发实例只允许落库一次（幂等物化）
    CREATE TABLE IF NOT EXISTS task_occurrence (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id         INTEGER NOT NULL REFERENCES scheduled_task(id),
      occurrence_key  TEXT    NOT NULL UNIQUE,
      run_at          TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','running','done','missed')),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---------- 工作流 Turn（可恢复任务） ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn (
      run_id       TEXT PRIMARY KEY,              -- 幂等执行 ID：sha256(logicalKey)
      sku_id       TEXT NOT NULL,
      phase        TEXT NOT NULL
                     CHECK (phase IN ('monitor','detect','investigate','decide','act','review')),
      status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','awaiting_approval','approved',
                                       'rejected','done','failed','blocked')),
      checkpoint   TEXT,                          -- 断点：当前阶段已完成的证据/参数
      params       TEXT NOT NULL DEFAULT '{}',    -- 动作参数（补货量/供应商/到货时间）
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_turn_sku ON turn(sku_id, created_at);
  `);

  // ---------- Ledger：调查证据与动作参数（append-only 账本） ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_run_id TEXT    NOT NULL REFERENCES turn(run_id),
      step        TEXT    NOT NULL,               -- 阶段步骤名
      kind        TEXT    NOT NULL CHECK (kind IN ('evidence','action','decision','error')),
      payload     TEXT    NOT NULL,               -- JSON：证据或动作参数
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_turn ON ledger(turn_run_id, id);
  `);

  // ---------- 幂等副作用记录：有副作用动作只执行一次 ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS executed_action (
      action_key  TEXT PRIMARY KEY,               -- 幂等键：run_id:ordinal
      turn_run_id TEXT NOT NULL,
      action_type TEXT NOT NULL,                  -- create_replenishment_order / adjust_price / delist
      payload     TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---------- 审批 ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_run_id TEXT    NOT NULL REFERENCES turn(run_id),
      action_type TEXT    NOT NULL,
      requested_by TEXT   NOT NULL,
      status      TEXT    NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','approved','rejected','timeout')),
      reason      TEXT,
      decided_at  TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ---------- Case Memory：案例库（revision 做 CAS） ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_record (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      sku_id      TEXT NOT NULL,
      anomaly_type TEXT NOT NULL
                     CHECK (anomaly_type IN ('stockout','overstock','promo_stack','margin_conflict','other')),
      cause       TEXT NOT NULL,                  -- 异常原因
      action      TEXT NOT NULL,                  -- 处置动作
      outcome     TEXT NOT NULL,                  -- 处置结果
      outcome_ok  INTEGER NOT NULL DEFAULT 1 CHECK (outcome_ok IN (0,1)),
      occurred_at TEXT NOT NULL,                  -- 时间窗
      revision    INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // FTS5 trigram 索引：按 SKU 与关键词召回相似案例；触发器保持与主表同步
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS case_fts USING fts5(
      sku_id, cause, action, outcome, content='case_record', content_rowid='id',
      tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS case_ai AFTER INSERT ON case_record BEGIN
      INSERT INTO case_fts(rowid, sku_id, cause, action, outcome)
      VALUES (new.id, new.sku_id, new.cause, new.action, new.outcome);
    END;
    CREATE TRIGGER IF NOT EXISTS case_ad AFTER DELETE ON case_record BEGIN
      INSERT INTO case_fts(case_fts, rowid, sku_id, cause, action, outcome)
      VALUES ('delete', old.id, old.sku_id, old.cause, old.action, old.outcome);
    END;
    CREATE TRIGGER IF NOT EXISTS case_au AFTER UPDATE ON case_record BEGIN
      INSERT INTO case_fts(case_fts, rowid, sku_id, cause, action, outcome)
      VALUES ('delete', old.id, old.sku_id, old.cause, old.action, old.outcome);
      INSERT INTO case_fts(rowid, sku_id, cause, action, outcome)
      VALUES (new.id, new.sku_id, new.cause, new.action, new.outcome);
    END;
  `);

  // ---------- ACL 资源归属授权（两维正交：系统能力 vs 资源归属） ----------
  db.exec(`
    CREATE TABLE IF NOT EXISTS acl_grant (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      principal   TEXT NOT NULL,                  -- 角色/身份
      resource_type TEXT NOT NULL CHECK (resource_type IN ('sku','workspace','system')),
      resource_id TEXT NOT NULL,                  -- sku_id / workspace_id / '*'
      permission  TEXT NOT NULL CHECK (permission IN ('read','advise','approve','execute','delete')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (principal, resource_type, resource_id, permission)
    );
  `);
}
