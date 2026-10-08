/**
 * Turn：可恢复任务。把补货决策链 Monitor → Detect → Investigate → Decide → Act → Review
 * 建模为六阶段状态机，支持断点（checkpoint）恢复，不重跑已完成阶段。
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type Phase = 'monitor' | 'detect' | 'investigate' | 'decide' | 'act' | 'review';

export type TurnStatus =
  | 'pending'
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'done'
  | 'failed'
  | 'blocked';

export const PHASE_ORDER: Phase[] = ['monitor', 'detect', 'investigate', 'decide', 'act', 'review'];

export interface Turn {
  runId: string;
  skuId: string;
  phase: Phase;
  status: TurnStatus;
  checkpoint: Record<string, unknown> | null;
  params: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** 幂等执行 ID：由逻辑键派生，同一条消息无论重放多少次只产生同一 runId */
export function deriveRunId(logicalKey: string): string {
  return createHash('sha256').update(logicalKey).digest('hex');
}

export class TurnStore {
  constructor(private db: DatabaseSync) {}

  create(skuId: string, logicalKey: string, params: Record<string, unknown> = {}): Turn {
    const runId = deriveRunId(logicalKey);
    const existing = this.get(runId);
    if (existing) return existing; // 幂等：同逻辑键复用同一 Turn
    this.db
      .prepare(
        `INSERT INTO turn (run_id, sku_id, phase, status, params)
         VALUES (?, ?, 'monitor', 'pending', ?)`
      )
      .run(runId, skuId, JSON.stringify(params));
    return this.get(runId)!;
  }

  get(runId: string): Turn | undefined {
    const r = this.db.prepare(`SELECT * FROM turn WHERE run_id = ?`).get(runId) as unknown as
      | TurnRow
      | undefined;
    return r ? rowToTurn(r) : undefined;
  }

  /** 推进阶段与状态（状态机跃迁记录） */
  transition(runId: string, phase: Phase, status: TurnStatus): void {
    this.db
      .prepare(`UPDATE turn SET phase = ?, status = ?, updated_at = datetime('now') WHERE run_id = ?`)
      .run(phase, status, runId);
  }

  /** 写断点：保存当前阶段已完成的证据/参数，供审批后恢复 */
  saveCheckpoint(runId: string, checkpoint: Record<string, unknown>): void {
    this.db
      .prepare(`UPDATE turn SET checkpoint = ?, updated_at = datetime('now') WHERE run_id = ?`)
      .run(JSON.stringify(checkpoint), runId);
  }

  /** 更新动作参数（补货量/供应商/到货时间等），version 递增 */
  updateParams(runId: string, params: Record<string, unknown>): void {
    this.db
      .prepare(`UPDATE turn SET params = ?, version = version + 1, updated_at = datetime('now') WHERE run_id = ?`)
      .run(JSON.stringify(params), runId);
  }

  listBySku(skuId: string): Turn[] {
    const rows = this.db
      .prepare(`SELECT * FROM turn WHERE sku_id = ? ORDER BY created_at`)
      .all(skuId) as unknown as TurnRow[];
    return rows.map(rowToTurn);
  }
}

interface TurnRow {
  run_id: string;
  sku_id: string;
  phase: Phase;
  status: TurnStatus;
  checkpoint: string | null;
  params: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function rowToTurn(r: TurnRow): Turn {
  return {
    runId: r.run_id,
    skuId: r.sku_id,
    phase: r.phase,
    status: r.status,
    checkpoint: r.checkpoint ? JSON.parse(r.checkpoint) : null,
    params: JSON.parse(r.params),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}
