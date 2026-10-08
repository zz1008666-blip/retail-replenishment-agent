/**
 * StreamEvent：Agent 执行轨迹的流式事件。
 * 复盘与回归门禁只看 Trace 不看最终输出（防「过程错、结果碰对」）。
 */
export type StreamEventType =
  | 'phase_enter'
  | 'phase_exit'
  | 'tool_call'
  | 'tool_result'
  | 'decision'
  | 'evidence'
  | 'approval'
  | 'action'
  | 'error';

export interface StreamEvent {
  seq: number;
  ts: string;
  turnRunId: string;
  skuId: string;
  type: StreamEventType;
  data: Record<string, unknown>;
}

export class TraceRecorder {
  private events: StreamEvent[] = [];
  private seq = 0;

  emit(turnRunId: string, skuId: string, type: StreamEventType, data: Record<string, unknown>): void {
    this.events.push({
      seq: this.seq++,
      ts: new Date().toISOString(),
      turnRunId,
      skuId,
      type,
      data
    });
  }

  all(): StreamEvent[] {
    return this.events.slice();
  }

  byType(type: StreamEventType): StreamEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  toolCalls(): StreamEvent[] {
    return this.byType('tool_call');
  }

  clear(): void {
    this.events = [];
    this.seq = 0;
  }
}
