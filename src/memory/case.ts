/**
 * 补货 Case Memory：历史处置经验的结构化记忆。
 *
 * - Case Schema：异常原因(cause) / 处置动作(action) / 结果(outcome) 三段式
 * - revision compare-and-set：并发写入冲突时显式抛 ConflictError(409)，不静默覆盖
 * - FTS5 trigram + bm25：按 SKU 与关键词召回相似案例，短查询降级 LIKE
 */
import type { DatabaseSync } from 'node:sqlite';

export type AnomalyType = 'stockout' | 'overstock' | 'promo_stack' | 'margin_conflict' | 'other';

export interface CaseRecord {
  id: number;
  skuId: string;
  anomalyType: AnomalyType;
  cause: string;
  action: string;
  outcome: string;
  outcomeOk: boolean;
  occurredAt: string;
  revision: number;
}

export class CaseConflictError extends Error {
  constructor(public currentRevision: number) {
    super(`case revision 冲突（当前 revision=${currentRevision}），请重新读取后合并`);
    this.name = 'CaseConflictError';
  }
}

export class CaseStore {
  constructor(private db: DatabaseSync) {}

  create(input: {
    skuId: string;
    anomalyType: AnomalyType;
    cause: string;
    action: string;
    outcome: string;
    outcomeOk?: boolean;
    occurredAt?: string;
  }): CaseRecord {
    const r = this.db
      .prepare(
        `INSERT INTO case_record (sku_id, anomaly_type, cause, action, outcome, outcome_ok, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.skuId,
        input.anomalyType,
        input.cause,
        input.action,
        input.outcome,
        input.outcomeOk === false ? 0 : 1,
        input.occurredAt ?? new Date().toISOString()
      );
    const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : Number(r.lastInsertRowid);
    return this.get(id)!;
  }

  get(id: number): CaseRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM case_record WHERE id = ?`).get(id) as unknown as
      | CaseRow
      | undefined;
    return row ? rowToCase(row) : undefined;
  }

  /**
   * compare-and-set 更新：只在 revision 匹配时才写入。
   * 并发冲突抛 CaseConflictError（等价 HTTP 409），显式暴露而非静默覆盖。
   */
  update(id: number, expectedRevision: number, patch: Partial<Omit<CaseRecord, 'id' | 'revision'>>): CaseRecord {
    const r = this.db
      .prepare(
        `UPDATE case_record
         SET cause = ?, action = ?, outcome = ?, outcome_ok = ?, anomaly_type = ?,
             revision = revision + 1, updated_at = datetime('now')
         WHERE id = ? AND revision = ?`
      )
      .run(
        patch.cause ?? '',
        patch.action ?? '',
        patch.outcome ?? '',
        patch.outcomeOk === false ? 0 : 1,
        patch.anomalyType ?? 'other',
        id,
        expectedRevision
      );
    if ((r as { changes: number }).changes === 0) {
      const cur = this.get(id);
      throw new CaseConflictError(cur ? cur.revision : expectedRevision);
    }
    return this.get(id)!;
  }

  list(): CaseRecord[] {
    const rows = this.db.prepare(`SELECT * FROM case_record ORDER BY id`).all() as unknown as CaseRow[];
    return rows.map(rowToCase);
  }

  /**
   * FTS5 召回：按 SKU + 关键词 + 时间窗返回相似案例。
   * - SKU 走 FTS 精确短语匹配
   * - 关键词 >= 3 字符走 FTS（cause/action/outcome 三列）
   * - 短关键词降级 LIKE 后过滤
   * - 时间窗：occurred_at >= since（近 N 天召回，旧案例自然被窗口过滤掉）
   */
  recall(
    skuId: string,
    opts: { keyword?: string; since?: string; limit?: number } = {}
  ): CaseRecord[] {
    const limit = opts.limit ?? 10;
    const kw = opts.keyword?.trim();
    const useFtsKeyword = kw && kw.length >= 3;

    let matchExpr = `sku_id:"${escapeFts(skuId)}"`;
    if (useFtsKeyword) {
      matchExpr += ` AND (cause:"${escapeFts(kw!)}" OR action:"${escapeFts(kw!)}" OR outcome:"${escapeFts(kw!)}")`;
    }

    const params: (string | number)[] = [matchExpr];
    let sql = `
      SELECT c.*, bm25(case_fts) AS rank
      FROM case_record c JOIN case_fts ON c.id = case_fts.rowid
      WHERE case_fts MATCH ?`;
    if (opts.since) {
      sql += ` AND c.occurred_at >= ?`;
      params.push(opts.since);
    }
    sql += ` ORDER BY c.occurred_at DESC LIMIT ?`;
    params.push(limit);

    let rows = this.db.prepare(sql).all(...params) as unknown as CaseRow[];

    // 短关键词降级 LIKE（trigram 无法匹配 <3 字符）
    if (kw && !useFtsKeyword) {
      const like = `%${kw}%`;
      rows = rows.filter(
        (r) => r.cause.includes(kw) || r.action.includes(kw) || r.outcome.includes(kw)
      );
    }
    return rows.map(rowToCase);
  }

  /** 按 SKU 与时间窗召回（复用历史调查路径用） */
  recallBySku(skuId: string, since?: string, limit = 10): CaseRecord[] {
    return this.recall(skuId, { since, limit });
  }
}

interface CaseRow {
  id: number;
  sku_id: string;
  anomaly_type: AnomalyType;
  cause: string;
  action: string;
  outcome: string;
  outcome_ok: number;
  occurred_at: string;
  revision: number;
}

function rowToCase(r: CaseRow): CaseRecord {
  return {
    id: r.id,
    skuId: r.sku_id,
    anomalyType: r.anomaly_type,
    cause: r.cause,
    action: r.action,
    outcome: r.outcome,
    outcomeOk: r.outcome_ok === 1,
    occurredAt: r.occurred_at,
    revision: r.revision
  };
}

/** FTS5 查询转义：把值包成短语，内部双引号翻倍 */
function escapeFts(s: string): string {
  return s.replace(/"/g, '""');
}
