/**
 * IPC 下发去重（参考 MiniClaw 协议层设计）。
 *
 * 场景映射：MiniClaw 用它对跨群组/渠道的告警消息做「重试去重」，避免同一个
 * 补货告警在同一轮重试里刷屏。本项目用它去重「补货告警/审批通知」的下发：
 * 同 sourceGroup + 目标 + 相同正文（md5）在 TTL 内视为同一条重试。
 *
 * 核心算法完全保留：md5 正文摘要 + TTL 过期 + 最多 500 条驱逐。
 */
import crypto from 'crypto';

const IPC_SEND_DEDUP_TTL_MS = 10 * 60_000;
const IPC_SEND_DEDUP_MAX = 500;

export interface IpcSendDedupDeps {
  getRetryCount(target: string): number;
  getTargetsByFolder(folder: string): string[];
  now?: () => number;
}

export function createIpcSendDeduplicator(deps: IpcSendDedupDeps): {
  isRetryDuplicate(sourceGroup: string, target: string, text: string): boolean;
  recordSuccessfulSend(sourceGroup: string, target: string, text: string): void;
} {
  const recentSends = new Map<string, number>(); // key -> expireAt
  const now = deps.now ?? Date.now;

  return {
    isRetryDuplicate(sourceGroup: string, target: string, text: string): boolean {
      const key = `${sourceGroup}|${target}|${crypto
        .createHash('md5')
        .update(text)
        .digest('hex')}`;
      const currentTime = now();
      const exp = recentSends.get(key);
      // retryCount 存活在原 enqueue 目标上：优先直接目标，再回退到同 folder 下枚举
      let inRetry =
        deps.getRetryCount(`${sourceGroup}:${target}`) > 0 ||
        deps.getRetryCount(sourceGroup) > 0;
      if (!inRetry) {
        for (const t of deps.getTargetsByFolder(sourceGroup)) {
          if (deps.getRetryCount(t) > 0) {
            inRetry = true;
            break;
          }
        }
      }
      return !!(exp && exp > currentTime) && inRetry;
    },
    recordSuccessfulSend(sourceGroup: string, target: string, text: string): void {
      const key = `${sourceGroup}|${target}|${crypto
        .createHash('md5')
        .update(text)
        .digest('hex')}`;
      recentSends.set(key, now() + IPC_SEND_DEDUP_TTL_MS);
      for (const k of recentSends.keys()) {
        if (recentSends.size <= IPC_SEND_DEDUP_MAX) break;
        recentSends.delete(k);
      }
    }
  };
}