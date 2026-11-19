/**
 * bash 终端工具（P3）：在工作空间内执行 shell 命令
 * - 危险命令硬拦截（与权限模式无关常开，spec §3）
 * - 默认态 cwd 限定工作空间内（越界回退工作空间根）；完全访问态不限定
 * - OS 级沙箱（OS 沙箱 spec §5）：执行前最后一刻经 ctx.osSandbox 包装，
 *   判定链零改动，沙箱纯做越界写硬网（fail-open 透传）
 * 纯 Node 实现（node:child_process + node:path），可被 vitest 直接测试
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "./file-tools";
import { watchCommandTree } from "../../security/child-monitor";
import { getNetworkGate } from "../../security/network-gate";
import type { SandboxRunner } from "../../security/sandbox/runner";
import type { SecurityEventSink } from "../../../../src-react/domains/security/model/types";

export interface CommandContext {
  /** 工作空间根；空串=未绑定目录（默认态锚点落家目录，见 resolveCwd） */
  workspacePath: string;
  /** 图执行无会话传 null（2026-10-28 去会话化，ToolContext 同款） */
  sessionId: number | null;
  fullAccess?: boolean;
  /** 安全事件上报（SP1 审计接入）：由 ChatService 装配注入，保持本模块纯函数可测 */
  onSecurityEvent?: SecurityEventSink;
  /** 子进程程序黑名单（SP2）：非空时挂载子进程树监控；缺省不监控 */
  commandWatchBlacklist?: string[];
  /** OS 级沙箱包装（OS 沙箱 spec §5）：执行前最后一刻包一层；缺席零开销透传 */
  osSandbox?: Pick<SandboxRunner, "wrap">;
  /** 流中止信号（OS 沙箱 spec §4.5）：中止时收割进程组；缺席无收割 */
  abortSignal?: AbortSignal;
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

/** rm 带递归/强制旗标且目标含绝对路径词元（含引号/波浪号/环境变量形态）；
 * i 旗标大小写不敏感（RM -RF 穿透，与 command-risk 同向量，终审 Critical 2026-10-24） */
const RM_ABSOLUTE_TARGET = new RegExp(
  /\brm\s+/.source +
    RM_LEADING_FLAGS +
    RF_FLAGS +
    /(?:\s+(?:-\w+|--[\w-]+))*(?:\s+[^\s|;&]+)*\s+/.source +
    ABSOLUTE_PATH_TOKEN,
  "i",
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
/** Windows 递归删除（rd/rmdir/del/erase 带 /s 旗标，cmd 旗标不分大小写） */
const WIN_RM_RECURSIVE = /\b(?:rd|rmdir|del|erase)\b[^&|;]*\/[a-z]*s[a-z]*/i;
/** Windows 格式化/磁盘分区（format 指向盘符、diskpart 任意形态） */
const WIN_FORMAT = /\bformat\s[^&|;]*\b[a-z]:|\bdiskpart\b/i;

/** 高危破坏性命令拦截：命中即拒（与权限无关常开，spec §3） */
export function isDangerousCommand(command: string): boolean {
  return (
    RM_ABSOLUTE_TARGET.test(command) ||
    MKFS_ANY.test(command) ||
    DD_TO_DEVICE.test(command) ||
    FORK_BOMB.test(command) ||
    CHMOD_ROOT.test(command) ||
    WIN_RM_RECURSIVE.test(command) ||
    WIN_FORMAT.test(command)
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

// ---------- bash 工具 ----------

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

/** maxBuffer 溢出（输出超 1MB）已由 runExec 聚合层手工判定（spawn 无
 * exec 的 maxBuffer 语义）；保留常量供各流独立封顶 */

/** cwd 解析：完全访问态直传不限定；默认态限定工作空间内，越界回退工作空间根。
 *  未绑定目录（workspacePath 空串）以家目录为锚——与终端 tab 无工作空间
 *  cwd 落家目录同构（terminal-ipc），钳制/回退/审计语义不变 */
function resolveCwd(ctx: CommandContext, rel?: string): string | undefined {
  if (ctx.fullAccess) return rel ?? undefined;
  const anchor = ctx.workspacePath || os.homedir();
  const resolved = path.resolve(anchor, rel ?? ".");
  const inBounds =
    resolved === anchor || resolved.startsWith(anchor + path.sep);
  if (!inBounds) {
    ctx.onSecurityEvent?.({
      eventType: "command-safety.cwd-fallback",
      decision: "info",
      detail: { requested: resolved, fallback: anchor },
      sessionId: ctx.sessionId,
    });
  }
  return inBounds ? resolved : anchor;
}

/**
 * 进程组收割（OS 沙箱 spec §4.5）：detached 使子进程自成组长，对 -pid
 * 补 SIGKILL 可杀透全组（编译器/测试器等孙进程）；win32 无进程组语义
 * 诚实保持旧语义。已退出（ESRCH）静默。仅超时/输出超限/启动异常/中止
 * 四种结算收割——正常退出不收割（`npm run dev &` 等后台任务存活语义）。
 * 挂在 exit 而非 close：孙进程持有 stdio 管道会推迟 close，先收割组
 * 才能加速 close 结算
 */
function reapProcessGroup(child: ChildProcess): void {
  if (process.platform === "win32" || !child.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // ESRCH=组已退出；其余收割失败由 child-monitor ps 轮询兜底
  }
}

/** 沙箱包装留痕（OS 沙箱 spec §8）：每条沙箱执行一条 info 级事件 */
function emitSandboxEvent(ctx: CommandContext, command: string): void {
  ctx.onSecurityEvent?.({
    eventType: "command-safety.sandbox",
    decision: "info",
    detail: {
      mode: "workspace-write",
      workspace: ctx.workspacePath || os.homedir(),
    },
    commandPreview: command.slice(0, 100),
    commandHash: commandSha256(command),
    sessionId: ctx.sessionId,
  });
}

/**
 * shell 执行适配层（对齐 exec 回调语义）+ 进程组语义：
 * 不用 exec——Node 26 实测 exec 丢弃 detached 选项，组长不成立则组收割
 * 无从谈起；spawn("/bin/sh", ["-c", cmd]) 同语义且 detached 生效。
 * 归一规则沿用 exec 形态：溢出/超时/中止/数值退出码 → 带标签结果
 * （溢出保留已捕获输出），启动失败 reject；OS 沙箱（spec §5）在执行前
 * 最后一刻 wrap（判定链/危险拦截/resolveCwd 全部在前、全部保留）
 */
function runExec(
  ctx: CommandContext,
  command: string,
  cwd: string | undefined,
): { promise: Promise<ExecOutcome>; child: ChildProcess } {
  const wrapped = ctx.osSandbox?.wrap(command, {
    workspacePath: ctx.workspacePath,
    fullAccess: !!ctx.fullAccess,
  });
  const effectiveCommand = wrapped?.command ?? command;
  if (wrapped?.sandboxed) {
    emitSandboxEvent(ctx, command);
  }
  const child = spawn("/bin/sh", ["-c", effectiveCommand], {
    cwd,
    timeout: EXEC_TIMEOUT_MS,
    env: buildChildEnv(),
    detached: process.platform !== "win32",
  });
  // maxBuffer 语义手工重建（spawn 不聚合）：各流独立封顶，溢出即杀
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  let outLen = 0;
  let errLen = 0;
  let overflow = false;
  let settled = false;
  const collect = (
    chunks: Buffer[],
    stream: NodeJS.ReadableStream | null,
    onLen: (n: number) => number,
  ) => {
    stream?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (onLen(chunk.length) > EXEC_MAX_BUFFER) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });
  };
  collect(outChunks, child.stdout, (n) => (outLen += n));
  collect(errChunks, child.stderr, (n) => (errLen += n));
  // 信号/溢出/中止结算 → 组收割（正常退出不收割，见 reapProcessGroup 注释）
  child.on("exit", (_code, signal) => {
    if (signal || overflow || ctx.abortSignal?.aborted) {
      reapProcessGroup(child);
    }
  });
  const promise = new Promise<ExecOutcome>((resolve, reject) => {
    // 用户中止收割（spec §4.5）：结算/中止双向解绑防泄漏
    const onAbort = () => reapProcessGroup(child);
    ctx.abortSignal?.addEventListener("abort", onAbort, { once: true });
    const detach = () => ctx.abortSignal?.removeEventListener("abort", onAbort);
    child.on("error", (error) => {
      detach();
      reapProcessGroup(child);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      detach();
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(outChunks).toString("utf8");
      const stderr = Buffer.concat(errChunks).toString("utf8");
      if (overflow) {
        resolve({ code: null, label: "输出超限", stdout, stderr });
      } else if (signal) {
        // 超时（spawn SIGTERM）/ 中止与收割（SIGKILL）统一归超时标签
        resolve({ code: null, label: "超时", stdout, stderr });
      } else {
        resolve({ code: code ?? null, label: "", stdout, stderr });
      }
    });
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
  name: "bash",
  description: "执行工作空间内 shell 命令，返回退出码与输出；高危命令需批准",
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
      // 拦截文案按命令形态分流指引（T35 渐进披露）：删文件类指向
      // rm（原在 rm 描述里的「优先于 rm」教学挪此）
      const deleteHint = /\b(?:rm|rd|rmdir|del|erase)\b/i.test(args.command)
        ? "；删除文件请改用 rm 工具"
        : "";
      return `错误: 该命令被安全策略拦截（高风险破坏性操作）${deleteHint}`;
    }
    try {
      const { promise, child } = runExec(
        ctx,
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
