/**
 * 子进程穿透监控（SP2 spec §5，尽力检测）：轮询 ps 快照构建进程树，
 * root 及其后代命中程序黑名单 → SIGKILL 该子树并回调（shell 对末命令
 * 隐式 exec 后 root 即目标程序，故 root 自身也纳入检测）。
 * 平台：darwin/linux；win32 为 no-op（顶层拦截不受影响，spec §5 诚实声明）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { programBasename } from "./command-policy";

const execFileAsync = promisify(execFile);

export interface ProcRow {
  pid: number;
  ppid: number;
  comm: string;
}

const PS_ARGS = ["-eo", "pid,ppid,comm"];

/** 解析 `ps -eo pid,ppid,comm` 输出（首行表头；comm 取行尾余量） */
export function parsePsOutput(stdout: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of stdout.split("\n").slice(1)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (match) {
      out.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        comm: match[3],
      });
    }
  }
  return out;
}

/** rootPid 的全部后代 pid（BFS + seen 防环；孤儿行/缺父行安全） */
export function buildDescendantPids(
  rows: ProcRow[],
  rootPid: number,
): Set<number> {
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.ppid) ?? [];
    list.push(row.pid);
    childrenOf.set(row.ppid, list);
  }
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  const out = new Set<number>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenOf.get(current) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/** comm 基名 ∈ 黑名单 */
export function matchBlacklistProgram(
  comm: string,
  blacklist: string[],
): boolean {
  return blacklist.includes(programBasename(comm));
}

/** kill pid 及其后代（已退出/无权限忽略——尽力而为） */
function killTree(rows: ProcRow[], pid: number): void {
  const victims = buildDescendantPids(rows, pid);
  for (const target of [pid, ...victims]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // 已退出或权限不足：尽力而为
    }
  }
}

/** 轮询监控：命中即 kill 子树并回调；返回停止函数（root 退出/连续 3 次失败自动停） */
export function watchCommandTree(
  rootPid: number,
  blacklist: string[],
  onViolation: (v: { pid: number; program: string }) => void,
  opts: { intervalMs?: number } = {},
): () => void {
  if (process.platform === "win32") {
    return () => {};
  }
  let stopped = false;
  let failures = 0;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped) return;
    void patrol();
  }, opts.intervalMs ?? 250);
  async function patrol(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("ps", PS_ARGS);
      failures = 0;
      const rows = parsePsOutput(stdout);
      if (!rows.some((row) => row.pid === rootPid)) {
        stop();
        return;
      }
      const descendants = buildDescendantPids(rows, rootPid);
      for (const row of rows) {
        const inTree = row.pid === rootPid || descendants.has(row.pid);
        if (inTree && matchBlacklistProgram(row.comm, blacklist)) {
          killTree(rows, row.pid);
          onViolation({ pid: row.pid, program: programBasename(row.comm) });
        }
      }
    } catch {
      failures += 1;
      if (failures >= 3) stop();
    }
  }
  return stop;
}
