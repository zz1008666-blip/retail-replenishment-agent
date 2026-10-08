/**
 * Runner 存活探针（照搬自 MiniClaw `src/runner-liveness.ts`）。
 *
 * 解释它修复的一个真实竞态：历史上「空闲回收计时器」与「外层看门狗」默认
 * 都是 30 分钟；stdout 看门狗在宿主投影完输出之前就重置，而空闲计时器在其
 * 之后才重置，导致看门狗稳定地抢先到点、把健康的会话误判为超时。
 *
 * 本项目把同一份数学关系用于 fork 子进程 Runner 的存活管理：
 *   idleCloseMs = min(执行超时, 空闲超时)      —— 温和回收二手房先到
 *   watchdogMs  = max(执行超时, 空闲超时) + 宽限 —— 外层兜底永远晚于回收
 */
export const RUNNER_SHUTDOWN_GRACE_MS = 15_000;

export interface RunnerLivenessTimeouts {
  /** 最新输出后仍保留热 runner 的时长 */
  idleCloseMs: number;
  /** 最新 stdout 活动之后的外层进程看门狗时长 */
  watchdogMs: number;
}

export function resolveRunnerLivenessTimeouts(input: {
  executionTimeoutMs: number;
  idleTimeoutMs: number;
  shutdownGraceMs?: number;
}): RunnerLivenessTimeouts {
  const executionTimeoutMs = Math.max(1, Math.floor(input.executionTimeoutMs));
  const idleTimeoutMs = Math.max(1, Math.floor(input.idleTimeoutMs));
  const shutdownGraceMs = Math.max(
    1,
    Math.floor(input.shutdownGraceMs ?? RUNNER_SHUTDOWN_GRACE_MS)
  );
  const idleCloseMs = Math.min(executionTimeoutMs, idleTimeoutMs);
  return {
    idleCloseMs,
    watchdogMs: Math.max(executionTimeoutMs, idleCloseMs) + shutdownGraceMs
  };
}