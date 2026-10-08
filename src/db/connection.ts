/**
 * SQLite 连接封装（基于 Node 内置 node:sqlite，零 native 依赖）。
 * 提供带事务的辅助函数，供 Ledger / Memory / Scheduler / Runtime 共用。
 */
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** 打开（或创建）一个 SQLite 数据库 */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** 在事务中执行 fn；fn 抛错则整体回滚 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

/** 把 lastInsertRowid 归一化为 number */
export function lastId(r: RunResult): number {
  return typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : r.lastInsertRowid;
}
