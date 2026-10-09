/**
 * Workspace 层：每次调查的隔离目录。
 *
 * 对应分层架构的 Workspace 文件隔离——每个巡检 run 一个独立目录，
 * Runner 子进程只能在自己的工作区里读写，不共享全局状态，避免不同租户/
 * 不同 SKU 的调查交叉污染。
 *
 * 隔离边界：
 *   - 目录隔离：每个 runId 一个 <root>/<runId> 目录，证据/trace/决策各就各位；
 *   - 路径守卫：任何写出都强制 resolve 后确认落在工作区根内，防目录穿越；
 *   - 配额：Runner 落盘仅限 evidence / trace / decision / input，不暴露 DB。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Workspace {
  runId: string;
  /** 工作区根目录（共享） */
  root: string;
  /** 本次调查的隔离目录 */
  dir: string;
  /** requeue 落盘的输入队列目录（见 protocol/ipc-delivery.ts） */
  inputDir: string;
  writeEvidence(payload: Record<string, unknown>): void;
  writeDecision(payload: Record<string, unknown>): void;
  appendTrace(event: unknown): void;
}

/** runId 白名单化：只留安全字符，杜绝路径穿越 */
export function safeRunId(runId: string): string {
  const clean = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!clean) throw new Error('runId 为空或非法');
  return clean;
}

/** 把若干段拼到工作区根内，任何一段试图逃逸（.. 或绝对路径）都抛错 */
function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...segments);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`路径越界：${resolved} 不在工作区 ${resolvedRoot} 内`);
  }
  return resolved;
}

export function createWorkspace(root: string, runId: string): Workspace {
  const safeId = safeRunId(runId);
  const rootAbs = path.resolve(root);
  const dir = resolveWithin(rootAbs, safeId);
  const inputDir = resolveWithin(dir, 'input');

  fs.mkdirSync(inputDir, { recursive: true });

  const writeJson = (filename: string, payload: Record<string, unknown>): void => {
    const file = resolveWithin(dir, filename);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  };

  return {
    runId: safeId,
    root: rootAbs,
    dir,
    inputDir,
    writeEvidence: (payload) => writeJson('evidence.json', payload),
    writeDecision: (payload) => writeJson('decision.json', payload),
    appendTrace: (event) => {
      const file = resolveWithin(dir, 'trace.ndjson');
      fs.appendFileSync(file, JSON.stringify(event) + '\n');
    }
  };
}

export function workspaceExists(root: string, runId: string): boolean {
  const safeId = safeRunId(runId);
  return fs.existsSync(path.resolve(root, safeId));
}

/** 列出给定根下所有已创建的工作区 runId */
export function listWorkspaces(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/** 回收某个工作区（默认走系统回收站语义由调用方决定；这里只做目录删除封装） */
export function removeWorkspace(root: string, runId: string): void {
  const safeId = safeRunId(runId);
  const dir = resolveWithin(path.resolve(root), safeId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}