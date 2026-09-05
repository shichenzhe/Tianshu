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

/** rm 带递归/强制旗标且目标含以 / 开头的词元（绝对路径目标一律拦：/ 与 /Users 等同） */
const RM_ABSOLUTE_TARGET =
  /\brm\s+(?:-\w+\s+)*-\w*[rf]\w*(?:\s+-\w+)*(?:\s+[^\s|;&]+)*\s+\/[^\s|;&]*/;
/** mkfs 系列格式化（任意形态） */
const MKFS_ANY = /\bmkfs/;
/** dd 写入设备（of=/dev/...） */
const DD_TO_DEVICE = /\bdd\b[^;|&]*\bof=\/dev\//;
/** fork 炸弹字面（含空格变体，判 :(){ 前缀即可） */
const FORK_BOMB = /:\(\)\{/;
/** chmod 递归 777 到 / 根 */
const CHMOD_ROOT = /\bchmod\s+(?:-\w+\s+)*\d{3,4}\s+\/(?:\s|$)/;

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
  killed: boolean;
  stdout: string;
  stderr: string;
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

/** callback 风格 exec → Promise：超时 killed 与数值退出码归一，其余异常走启动失败 */
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
          resolve({ code: 0, killed: false, stdout, stderr });
        } else if (error.killed) {
          resolve({ code: null, killed: true, stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, killed: false, stdout, stderr });
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
      const { code, killed, stdout, stderr } = await runExec(
        args.command,
        resolveCwd(ctx, args.cwd),
      );
      const out = mergeOutput(stdout, stderr);
      if (code === 0) return `退出码 0\n${out}`;
      return `错误: 命令失败（退出码 ${code ?? "-"}${killed ? "/超时" : ""}）\n${out}`;
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
