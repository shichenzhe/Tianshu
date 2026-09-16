/**
 * run_command 终端工具（P3）：在工作空间内执行 shell 命令
 * - 危险命令硬拦截（与权限模式无关常开，spec §3）
 * - 默认态 cwd 限定工作空间内（越界回退工作空间根）；完全访问态不限定
 * 纯 Node 实现（node:child_process + node:path），可被 vitest 直接测试
 */
import { exec, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./file-tools";
import { watchCommandTree } from "../../security/child-monitor";
import { getNetworkGate } from "../../security/network-gate";
import type { SecurityEventSink } from "../../../../src-react/domains/security/model/types";

export interface CommandContext {
  workspacePath: string;
  sessionId: number;
  fullAccess?: boolean;
  /** 安全事件上报（SP1 审计接入）：由 ChatService 装配注入，保持本模块纯函数可测 */
  onSecurityEvent?: SecurityEventSink;
  /** 子进程程序黑名单（SP2）：非空时挂载子进程树监控；缺省不监控 */
  commandWatchBlacklist?: string[];
}

const EXEC_TIMEOUT_MS = 60_000;
const EXEC_MAX_BUFFER = 1024 * 1024;
const OUTPUT_LIMIT = 8192;

// ---------- 危险命令拦截（spec §3 五类形态，常开） ----------

/**
 * 绝对路径词元：`/` 开头（可带引号/反斜杠转义）、`~`、`$HOME`、`${HOME}` 前缀——
 * shell 展开后均可能指向工作空间外，统一视为界外目标（fail-closed）。
 * 命令替换混淆（$(pwd) 等）是静态正则的固有极限，由审批层兜底
 */
const ABSOLUTE_PATH_TOKEN = /["']?(?:\\?\/|\$\{?HOME\}?|~)[^\s|;&]*/.source;

/** 递归/强制旗标：短旗标（-rf/-R）或长旗标（--recursive/--force） */
const RF_FLAGS = /(?:-\w*[rfRF]\w*|--recursive|--force)/.source;

/** rm 前导旗标（含 --no-preserve-root 等带连字符长旗标） */
const RM_LEADING_FLAGS = /(?:-\w+\s+|--[\w-]+\s+)*/.source;

/** rm 带递归/强制旗标且目标含绝对路径词元（含引号/波浪号/环境变量形态） */
const RM_ABSOLUTE_TARGET = new RegExp(
  /\brm\s+/.source +
    RM_LEADING_FLAGS +
    RF_FLAGS +
    /(?:\s+(?:-\w+|--[\w-]+))*(?:\s+[^\s|;&]+)*\s+/.source +
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
  /\bchmod\s+(?:(?:-\w+|--[\w-]+)\s+)*\d{3,4}\s+/.source + ABSOLUTE_PATH_TOKEN,
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

/** 命令指纹（SP1 审计）：sha256 hex——脱敏留痕（preview 截断 + hash 可对账） */
function commandSha256(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

/** 子进程 env（SP5）：网络安全门装且本地代理启动时注入 proxy 指向，缺省继承 */
function buildChildEnv(): NodeJS.ProcessEnv | undefined {
  const proxyEnv = getNetworkGate()?.childProxyEnv();
  return proxyEnv ? { ...process.env, ...proxyEnv } : undefined;
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
  if (!inBounds) {
    ctx.onSecurityEvent?.({
      eventType: "command-safety.cwd-fallback",
      decision: "info",
      detail: { requested: resolved, fallback: ctx.workspacePath },
      sessionId: ctx.sessionId,
    });
  }
  return inBounds ? resolved : ctx.workspacePath;
}

/**
 * callback 风格 exec → Promise（同时透出 child 供子进程监控挂载）：
 * 输出溢出/超时/数值退出码归一为带标签结果（溢出时回调仍带回已捕获的
 * stdout/stderr，不丢弃）；其余异常走启动失败
 */
function runExec(
  command: string,
  cwd: string | undefined,
): { promise: Promise<ExecOutcome>; child: ChildProcess } {
  let child!: ChildProcess;
  const promise = new Promise<ExecOutcome>((resolve, reject) => {
    child = exec(
      command,
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
        env: buildChildEnv(),
      },
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
  return { promise, child };
}

/**
 * 子进程黑名单监控挂载（SP2 spec §5.1）；无条件时不挂返回 undefined。
 * 同一 pid 可能跨轮询重复命中（kill 未及生效），按 pid 去重只审计一次；
 * 回调只入队审计事件、绝不抛（抛会计入 child-monitor 失败计数致误停）
 */
function startChildWatch(
  ctx: CommandContext,
  command: string,
  pid: number | undefined,
): (() => void) | undefined {
  const blacklist = ctx.commandWatchBlacklist ?? [];
  if (!pid || blacklist.length === 0 || process.platform === "win32") {
    return undefined;
  }
  const seen = new Set<number>();
  return watchCommandTree(pid, blacklist, (v) => {
    if (seen.has(v.pid)) return;
    seen.add(v.pid);
    ctx.onSecurityEvent?.({
      eventType: "command-safety.child-blocked",
      decision: "blocked",
      detail: {
        program: v.program,
        pid: v.pid,
        rootCommand: command.slice(0, 200),
      },
      sessionId: ctx.sessionId,
    });
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
      ctx.onSecurityEvent?.({
        eventType: "command-safety.blocked",
        decision: "blocked",
        detail: { command: args.command.slice(0, 200), source: "dangerous" },
        commandPreview: args.command.slice(0, 100),
        commandHash: commandSha256(args.command),
        sessionId: ctx.sessionId,
      });
      return "错误: 该命令被安全策略拦截（高风险破坏性操作）";
    }
    try {
      const { promise, child } = runExec(
        args.command,
        resolveCwd(ctx, args.cwd),
      );
      const stopWatch = startChildWatch(ctx, args.command, child.pid);
      try {
        const { code, label, stdout, stderr } = await promise;
        const out = mergeOutput(stdout, stderr);
        if (code === 0) return `退出码 0\n${out}`;
        const suffix = label ? `/${label}` : "";
        return `错误: 命令失败（退出码 ${code ?? "-"}${suffix}）\n${out}`;
      } finally {
        stopWatch?.();
      }
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
