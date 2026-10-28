/**
 * 工作树变更查询（DetailPanel 查看变更 tab）：git 只读三命令白名单
 * （rev-parse/status/diff），execFile 注入可测（照 child-monitor 先例，
 * 纯 Node 零 electron）。changes = 工作树 vs HEAD（staged+unstaged），
 * untracked 只列名（无内容 diff）；spec R11-R15。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveSafePath } from "../agent/file-tools";

const execFileAsync = promisify(execFile);

export type GitExec = (args: string[], cwd: string) => Promise<string>;

/** 生产 exec：10s 超时 / 4MB 上限 / utf8 */
export const defaultGitExec: GitExec = async (args, cwd) => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
};

export interface GitChangeFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
}

export type GitWorkingChanges =
  | { kind: "not-git" }
  | { kind: "ok"; files: GitChangeFile[]; truncated: boolean };

export type GitFileDiffResult =
  { kind: "untracked" } | { kind: "diff"; text: string; truncated: boolean };

export const LIST_LIMIT = 500;
export const DIFF_LIMIT = 64 * 1024;

/** XY 状态码 → 单文件结论（X=staged，Y=unstaged；展示取 X 优先） */
function toFile(x: string, y: string, path: string): GitChangeFile | null {
  const c = x !== " " ? x : y;
  switch (c) {
    case "M":
      return { path, status: "modified", staged: x !== " " };
    case "A":
      return { path, status: "added", staged: true };
    case "D":
      return { path, status: "deleted", staged: x !== " " };
    case "R":
      return { path, status: "renamed", staged: true };
    case "?":
      return { path, status: "untracked", staged: false };
    default:
      return null; // 冲突态等罕见码不列（YAGNI）
  }
}

export async function gitWorkingChanges(
  cwd: string,
  exec: GitExec = defaultGitExec,
): Promise<GitWorkingChanges> {
  try {
    const inside = (
      await exec(["rev-parse", "--is-inside-work-tree"], cwd)
    ).trim();
    if (inside !== "true") return { kind: "not-git" };
  } catch {
    return { kind: "not-git" };
  }
  const z = await exec(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    cwd,
  );
  const files: GitChangeFile[] = [];
  // -z：每条目 NUL 结尾；R/C 条目 path 后跟 \0oldPath\0
  const parts = z.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const x = entry[0] ?? " ";
    const y = entry[1] ?? " ";
    const path = entry.slice(3);
    if (x === "R" || x === "C") i++; // 跳过旧路径段
    const file = toFile(x, y, path);
    if (file) files.push(file);
    if (files.length >= LIST_LIMIT) {
      return { kind: "ok", files, truncated: true };
    }
  }
  return { kind: "ok", files, truncated: false };
}

export async function gitFileDiff(
  cwd: string,
  path: string,
  exec: GitExec = defaultGitExec,
): Promise<GitFileDiffResult> {
  const safe = resolveSafePath(cwd, path, false);
  const rel = safe.slice(cwd.length + 1) || path;
  const text = await exec(["diff", "--no-color", "HEAD", "--", rel], cwd);
  if (!text.trim()) return { kind: "untracked" };
  if (text.length > DIFF_LIMIT) {
    return { kind: "diff", text: text.slice(0, DIFF_LIMIT), truncated: true };
  }
  return { kind: "diff", text, truncated: false };
}
