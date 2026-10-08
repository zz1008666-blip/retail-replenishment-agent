/**
 * IPC 投递与回执（照搬自 MiniClaw `container/agent-runner/src/ipc-delivery.ts`，
 * 载体从「文件队列」适配为「stdio 消息队列 + 工作区落盘」）。
 *
 * 保留 MiniClaw 的三个关键机制：
 *   1. 顺序恢复：回执游标（timestamp + id）是权威顺序，文件名顺序不可靠；
 *   2. 回执校验：parseIpcReceipt 严格校验 deliveryId/chatJid/cursor；
 *   3. Turn 追踪：IpcTurnDeliveryTracker 把「接受的输入 turn」与「健康结果」一一配对，
 *      错误/中断/截断不调用 completeNextTurn，消息保持可重放。
 *
 * 场景映射：本项目 Runner 每收到一个 inspect_request 就是一个「输入 turn」，
 * 只有产出健康的 decision 才 completeNextTurn；失败则 requeue 回工作区输入队列。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface IpcCursor {
  timestamp: string;
  id: string;
  sourceJid?: string;
}

export interface IpcDeliveryReceipt {
  deliveryId: string;
  chatJid: string;
  cursor: IpcCursor;
  coveredCursors?: IpcCursor[];
}

export interface IpcInputMessage {
  text: string;
  /** 精确到某次查询尝试 */
  queryRunId?: string;
  taskId?: string;
  sourceJid?: string;
  receipt?: IpcDeliveryReceipt;
}

export function orderIpcInputMessages(
  messages: IpcInputMessage[]
): IpcInputMessage[] {
  if (messages.length < 2 || messages.some((message) => !message.receipt)) {
    return [...messages];
  }
  return [...messages].sort((a, b) => {
    const aCursor = a.receipt!.cursor;
    const bCursor = b.receipt!.cursor;
    if (aCursor.timestamp !== bCursor.timestamp) {
      return aCursor.timestamp < bCursor.timestamp ? -1 : 1;
    }
    if (aCursor.id === bCursor.id) return 0;
    return aCursor.id < bCursor.id ? -1 : 1;
  });
}

export function parseIpcReceipt(value: unknown): IpcDeliveryReceipt | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const receipt = value as Record<string, unknown>;
  const cursor = receipt.cursor as Record<string, unknown> | undefined;
  if (
    typeof receipt.deliveryId !== 'string' ||
    typeof receipt.chatJid !== 'string' ||
    !cursor ||
    typeof cursor.timestamp !== 'string' ||
    typeof cursor.id !== 'string'
  ) {
    return undefined;
  }
  let coveredCursors: IpcCursor[] | undefined;
  if (Object.prototype.hasOwnProperty.call(receipt, 'coveredCursors')) {
    if (!Array.isArray(receipt.coveredCursors) || receipt.coveredCursors.length === 0) {
      return undefined;
    }
    coveredCursors = [];
    for (const value of receipt.coveredCursors) {
      if (!value || typeof value !== 'object') return undefined;
      const covered = value as Record<string, unknown>;
      if (typeof covered.timestamp !== 'string' || typeof covered.id !== 'string') {
        return undefined;
      }
      coveredCursors.push({
        timestamp: covered.timestamp,
        id: covered.id,
        ...(typeof covered.sourceJid === 'string' ? { sourceJid: covered.sourceJid } : {})
      });
    }
    const maximum = [...coveredCursors].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })[coveredCursors.length - 1];
    if (maximum.timestamp !== cursor.timestamp || maximum.id !== cursor.id) {
      return undefined;
    }
  }
  return {
    deliveryId: receipt.deliveryId,
    chatJid: receipt.chatJid,
    ...(coveredCursors && coveredCursors.length > 0 ? { coveredCursors } : {}),
    cursor: { timestamp: cursor.timestamp, id: cursor.id }
  };
}

export function isHealthyInputTurnCompletion(
  pendingBackgroundTasks: number,
  suspectTruncated: boolean
): boolean {
  return pendingBackgroundTasks === 0 && !suspectTruncated;
}

export function latestIpcDeliveryId(
  messages: IpcInputMessage[]
): string | undefined {
  return latestIpcInputMessage(messages)?.receipt?.deliveryId;
}

export function latestIpcInputMessage(
  messages: IpcInputMessage[]
): IpcInputMessage | undefined {
  let latest: IpcInputMessage | undefined;
  for (const message of messages) {
    const receipt = message.receipt;
    if (!receipt) continue;
    if (
      !latest?.receipt ||
      receipt.cursor.timestamp > latest.receipt.cursor.timestamp ||
      (receipt.cursor.timestamp === latest.receipt.cursor.timestamp &&
        receipt.cursor.id > latest.receipt.cursor.id)
    ) {
      latest = message;
    }
  }
  return latest ?? messages[messages.length - 1];
}

/**
 * 关联每个已接受的输入 batch 与恰好一个健康结果。
 * 错误/中断/截断不调用 completeNextTurn，消息保持可重放。
 */
export class IpcTurnDeliveryTracker {
  readonly unacknowledgedMessages: IpcInputMessage[];
  private readonly turns: IpcInputMessage[][];

  constructor(initialMessages: IpcInputMessage[] = []) {
    this.unacknowledgedMessages = [...initialMessages];
    this.turns = [[...initialMessages]];
  }

  acceptTurn(messages: IpcInputMessage[]): void {
    this.unacknowledgedMessages.push(...messages);
    this.turns.push([...messages]);
  }

  get pendingTurnCount(): number {
    return this.turns.length;
  }

  get hasPendingTurns(): boolean {
    return this.turns.length > 0;
  }

  get currentTurnMessages(): IpcInputMessage[] {
    return [...(this.turns[0] ?? [])];
  }

  get currentTurnDeliveryId(): string | undefined {
    return latestIpcDeliveryId(this.turns[0] ?? []);
  }

  get laterTurnMessages(): IpcInputMessage[] {
    return this.turns.slice(1).flatMap((turn) => turn);
  }

  cancelCurrentTurn(): IpcInputMessage[] {
    const cancelled = this.turns.shift() ?? [];
    for (const message of cancelled) {
      const index = this.unacknowledgedMessages.indexOf(message);
      if (index >= 0) this.unacknowledgedMessages.splice(index, 1);
    }
    return cancelled;
  }

  completeNextTurn(): IpcDeliveryReceipt[] {
    const completed = this.turns.shift() ?? [];
    for (const message of completed) {
      const index = this.unacknowledgedMessages.indexOf(message);
      if (index >= 0) this.unacknowledgedMessages.splice(index, 1);
    }
    return completed
      .map((message) => message.receipt)
      .filter((receipt): receipt is IpcDeliveryReceipt => !!receipt);
  }
}

/** 序列化一条输入消息（去 channelContext 等宿主专有字段） */
export function serializeIpcInputMessage(message: IpcInputMessage): object {
  return {
    type: 'message',
    text: message.text,
    queryRunId: message.queryRunId,
    taskId: message.taskId,
    sourceJid: message.sourceJid,
    receipt: message.receipt
  };
}

/**
 * 把未完成的输入消息重排回工作区输入队列（原子 tmp+rename，防崩溃读到半截）。
 */
export function requeueIpcInputMessages(
  inputDir: string,
  messages: IpcInputMessage[]
): string[] {
  if (messages.length === 0) return [];
  fs.mkdirSync(inputDir, { recursive: true });
  const batchId = `${Date.now()}-${randomUUID()}`;
  const written: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const filename = `${batchId}-requeue-${String(index).padStart(6, '0')}.json`;
    const filepath = path.join(inputDir, filename);
    const tempPath = `${filepath}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(serializeIpcInputMessage(messages[index])));
      fs.renameSync(tempPath, filepath);
      written.push(filepath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* 忽略缺失的半截临时文件 */
      }
      throw err;
    }
  }
  return written;
}