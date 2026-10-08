/**
 * 审批状态机：APPROVAL 动作的人工裁决通道。
 * 状态：pending → approved / rejected / timeout（超时转人工接管）。
 */
import type { DatabaseSync } from 'node:sqlite';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface Approval {
  id: number;
  turnRunId: string;
  actionType: string;
  requestedBy: string;
  status: ApprovalStatus;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export class ApprovalStore {
  constructor(private db: DatabaseSync) {}

  create(turnRunId: string, actionType: string, requestedBy: string): Approval {
    const r = this.db
      .prepare(`INSERT INTO approval (turn_run_id, action_type, requested_by) VALUES (?, ?, ?)`)
      .run(turnRunId, actionType, requestedBy);
    const id = typeof r.lastInsertRowid === 'bigint' ? Number(r.lastInsertRowid) : Number(r.lastInsertRowid);
    return this.get(id)!;
  }

  get(id: number): Approval | undefined {
    const row = this.db.prepare(`SELECT * FROM approval WHERE id = ?`).get(id) as unknown as
      | ApprovalRow
      | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  latestForTurn(turnRunId: string): Approval | undefined {
    const row = this.db
      .prepare(`SELECT * FROM approval WHERE turn_run_id = ? ORDER BY id DESC LIMIT 1`)
      .get(turnRunId) as unknown as ApprovalRow | undefined;
    return row ? rowToApproval(row) : undefined;
  }

  decide(id: number, status: 'approved' | 'rejected' | 'timeout', reason?: string): void {
    this.db
      .prepare(`UPDATE approval SET status = ?, reason = ?, decided_at = datetime('now') WHERE id = ?`)
      .run(status, reason ?? null, id);
  }
}

interface ApprovalRow {
  id: number;
  turn_run_id: string;
  action_type: string;
  requested_by: string;
  status: ApprovalStatus;
  reason: string | null;
  decided_at: string | null;
  created_at: string;
}

function rowToApproval(r: ApprovalRow): Approval {
  return {
    id: r.id,
    turnRunId: r.turn_run_id,
    actionType: r.action_type,
    requestedBy: r.requested_by,
    status: r.status,
    reason: r.reason,
    decidedAt: r.decided_at,
    createdAt: r.created_at
  };
}
