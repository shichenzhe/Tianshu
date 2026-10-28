/**
 * GUI 进程 PATH 补齐：macOS/Linux 打包应用由 launchd（或桌面启动器）拉起，
 * PATH 仅有系统默认目录，不加载 ~/.zprofile 等用户 shell 配置——Homebrew/
 * nvm 安装的命令对 run_command / 代码节点全部不可见（spawn ENOENT）。
 * 以登录交互 shell 取回用户 PATH 前置合并；任何失败保留原值（fail-safe）
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const SHELL_PROBE_TIMEOUT_MS = 5_000;

/** 合法 PATH 值：由绝对路径段组成（允许空段）——防 shell 启动杂音混入 */
export function isValidPathValue(value: string): boolean {
  if (!value) return false;
  return value
    .split(path.delimiter)
    .every((seg) => seg === "" || seg.startsWith("/"));
}

/** 去重合并：探测量在前、原 PATH 兜底，保持首次出现顺序 */
export function mergePathEntries(probed: string, original: string): string {
  const segments = [
    ...probed.split(path.delimiter),
    ...original.split(path.delimiter),
  ];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const seg of segments) {
    if (seg && !seen.has(seg)) {
      seen.add(seg);
      merged.push(seg);
    }
  }
  return merged.join(path.delimiter);
}

/** 登录交互 shell 探测用户 PATH（-il 加载 .zprofile/.zshrc，nvm 等在此注入） */
function probeShellPath(shell: string): string | undefined {
  // fish 的 $PATH 是空格分隔列表，echo 输出非冒号形态，须用 string join
  const args =
    path.basename(shell) === "fish"
      ? ["-l", "-c", "string join : $PATH"]
      : ["-ilc", "echo $PATH"];
  try {
    const out = execFileSync(shell, args, {
      encoding: "utf-8",
      timeout: SHELL_PROBE_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return isValidPathValue(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 入口：win32 的 GUI 进程继承系统注册表 PATH，无此问题，跳过 */
export function fixPathForGuiProcess(): void {
  if (process.platform === "win32") return;
  const shell = process.env.SHELL;
  if (!shell) return;
  const probed = probeShellPath(shell);
  if (!probed) return;
  process.env.PATH = mergePathEntries(probed, process.env.PATH ?? "");
}
