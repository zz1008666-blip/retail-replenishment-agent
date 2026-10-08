/**
 * Ledger：append-only 账本，持久化调查证据与动作参数。
 * 每个 Turn 的每一步都先落账再动手（「先落库再动手」），
 * 使每条补货建议保留完整决策链，而非一次性结论。
 */
import type { DatabaseSync } from 'node:sqlite';

export type LedgerKind = 'evidence' | 'action' | 'decision' | 'error';

export interface LedgerEntry {
  id: number;
  turnRunId: string;
  step: string;
  kind: LedgerKind;
  payload: unknown;
  createdAt: string;
}

export class Ledger {
  constructor(private db: DatabaseSync) {}

  append(turnRunId: string, step: string, kind: LedgerKind, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO ledger (turn_run_id, step, kind, payload) VALUES (?, ?, ?, ?)`)
      .run(turnRunId, step, kind, JSON.stringify(payload));
  }

  evidence(turnRunId: string, step: string, data: unknown): void {
    this.append(turnRunId, step, 'evidence', data);
  }

  action(turnRunId: string, step: string, data: unknown): void {
    this.append(turnRunId, step, 'action', data);
  }

  decision(turnRunId: string, step: string, data: unknown): void {
    this.append(turnRunId, step, 'decision', data);
  }

  error(turnRunId: string, step: string, data: unknown): void {
    this.append(turnRunId, step, 'error', data);
  }

  list(turnRunId: string): LedgerEntry[] {
    const rows = this.db
      .prepare(`SELECT * FROM ledger WHERE turn_run_id = ? ORDER BY id`)
      .all(turnRunId) as unknown as {
      id: number;
      turn_run_id: string;
      step: string;
      kind: LedgerKind;
      payload: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      turnRunId: r.turn_run_id,
      step: r.step,
      kind: r.kind,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at
    }));
  }
}
