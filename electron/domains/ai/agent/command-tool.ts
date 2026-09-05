/**
 * run_command 终端工具（P3）：在工作空间内执行 shell 命令
 * - 危险命令硬拦截（与权限模式无关常开，spec §3）
 * - 默认态 cwd 限定工作空间内（越界回退工作空间根）；完全访问态不限定
 * 纯 Node 实现（node:child_process + node:path），可被 vitest 直接测试
 */
import { exec } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./file-tools";

export interface CommandContext {
  workspacePath: string;
  sessionId: number;
  fullAccess?: boolean;
}

const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 1024 * 1024;
const OUTPUT_LIMIT = 8192;

// ---------- 危险命令拦截（spec §3 五类形态，常开） ----------

/**
 * 绝对路径词元：`/` 开头（可带引号/反斜杠转义）、`~`、`$HOME`、`${HOME}` 前缀——
 * shell 展开后均可能指向工作空间外，统一视为界外目标（fail-closed）
 */
const ABSOLUTE_PATH_TOKEN = /["']?(?:\\?\/|\$\{?HOME\}?|~)[^\s|;&]*/.source;

/** 递归/强制旗标：短旗标（-rf）或长旗标（--recursive/--force） */
const RF_FLAGS = /(?:-\w*[rf]\w*|--recursive|--force)/.source;

/** rm 带递归/强制旗标且目标含绝对路径词元（含引号/波浪号/环境变量形态） */
const RM_ABSOLUTE_TARGET = new RegExp(
  /\brm\s+(?:-\w+\s+|--\w+\s+)*/.source +
    RF_FLAGS +
    /(?:\s+(?:-\w+|--\w+))*(?:\s+[^\s|;&]+)*\s+/.source +
    ABSOLUTE_PATH_TOKEN,
);
/** mkfs 系列格式化（任意形态） */
const MKFS_ANY = /\bmkfs/;
/** dd 写入设备（of=/dev/...） */
const DD_TO_DEVICE = /\bdd\b[^;|&]*\bof=\/dev\//;
/** fork 炸弹字面（含空格变体，判 :(){ 前缀即可） */
const FORK_BOMB = /:\(\)\{/;
/** chmod 递归改权限到绝对路径（旗标与词元类与 rm 对齐） */
const CHMOD_ROOT = new RegExp(
  /\bchmod\s+(?:(?:-\w+|--\w+|--recursive)\s+)*\d{3,4}\s+/.source +
    ABSOLUTE_PATH_TOKEN,
);

/** 高危破坏性命令拦截：命中即拒（与权限无关常开，spec §3） */
export function isDangerousCommand(command: string): boolean {
  return (
    RM_ABSOLUTE_TARGET.test(command) ||
    MKFS_ANY.test(command) ||
    DD_TO_DEVICE.test(command) ||
    FORK_BOMB.test(command) ||
    CHMOD_ROOT.test(command)
  );
}

// ---------- run_command 工具 ----------

const runCommandSchema = z.object({
  command: z.string().describe("要执行的 shell 命令"),
  cwd: z
    .string()
    .optional()
    .describe("工作目录（默认工作空间根；完全访问时可用任意路径）"),
});

interface ExecOutcome {
  code: number | null;
  /** 失败原因标签（空串=普通退出码失败）：超时 / 输出超限 */
  label: "" | "超时" | "输出超限";
  stdout: string;
  stderr: string;
}

/** maxBuffer 溢出（输出超 1MB）：新版 Node 有专用错误码，旧版仅在 message 提及 */
function isMaxBufferError(error: Error & { code?: unknown }): boolean {
  return (
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxBuffer/i.test(error.message)
  );
}

/** cwd 解析：完全访问态直传不限定；默认态限定工作空间内，越界回退工作空间根 */
function resolveCwd(ctx: CommandContext, rel?: string): string | undefined {
  if (ctx.fullAccess) return rel ?? undefined;
  const resolved = path.resolve(ctx.workspacePath, rel ?? ".");
  const inBounds =
    resolved === ctx.workspacePath ||
    resolved.startsWith(ctx.workspacePath + path.sep);
  return inBounds ? resolved : ctx.workspacePath;
}

/**
 * callback 风格 exec → Promise：输出溢出/超时/数值退出码归一为带标签结果
 * （溢出时回调仍带回已捕获的 stdout/stderr，不丢弃）；其余异常走启动失败
 */
function runExec(
  command: string,
  cwd: string | undefined,
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      { cwd, timeout: EXEC_TIMEOUT_MS, maxBuffer: EXEC_MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, label: "", stdout, stderr });
        } else if (isMaxBufferError(error)) {
          // 溢出错误 killed 亦为 true，须先于超时判定
          resolve({ code: null, label: "输出超限", stdout, stderr });
        } else if (error.killed) {
          resolve({ code: null, label: "超时", stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, label: "", stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
}

/** 合并 stdout/stderr 并截断至 8KB（尾部加截断标记） */
function mergeOutput(stdout: string, stderr: string): string {
  const merged = [stdout, stderr].filter((part) => part.length > 0).join("\n");
  return merged.length > OUTPUT_LIMIT
    ? merged.slice(0, OUTPUT_LIMIT) + "\n…（已截断）"
    : merged;
}

const runCommandTool: ToolDefinition<z.infer<typeof runCommandSchema>> = {
  name: "run_command",
  description:
    "在工作空间内执行 shell 命令（默认需用户批准；完全访问时免确认）。返回退出码与输出。",
  parameters: runCommandSchema,
  kind: "write",
  execute: async (ctx: CommandContext, args) => {
    if (isDangerousCommand(args.command)) {
      return "错误: 该命令被安全策略拦截（高风险破坏性操作）";
    }
    try {
      const { code, label, stdout, stderr } = await runExec(
        args.command,
        resolveCwd(ctx, args.cwd),
      );
      const out = mergeOutput(stdout, stderr);
      if (code === 0) return `退出码 0\n${out}`;
      const suffix = label ? `/${label}` : "";
      return `错误: 命令失败（退出码 ${code ?? "-"}${suffix}）\n${out}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `错误: 命令启动失败（${msg}）`;
    }
  },
};

export function makeRunCommandTool(): ToolDefinition<{
  command: string;
  cwd?: string;
}> {
  return runCommandTool;
}
