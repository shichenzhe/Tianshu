/**
 * bash 终端工具（自 mirror electron/domains/ai/agent/command-tool.ts
 * 移植）：在工作空间内执行 shell 命令。
 * - 危险命令硬拦截（与权限模式无关常开）
 * - 默认态 cwd 限定工作空间内（越界回退工作空间根）；完全访问态不限定
 * 无头端裁剪：SP2 子进程树监控（watchCommandTree，依赖 electron
 * child-monitor）与 SP5 网络代理注入（getNetworkGate）不移植——env 直接
 * 继承服务进程。纯 Node 实现，可被 jest 直接测试。
 */
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool-definition';

export interface CommandContext {
  /** 工作空间根；空串=未绑定目录（默认态锚点落家目录，见 resolveCwd） */
  workspacePath: string;
  /** 图执行无会话传 null（2026-10-28 去会话化，mirror 同款） */
  sessionId: number | null;
  fullAccess?: boolean;
  /** 安全事件上报：保持本模块纯函数可测 */
  onSecurityEvent?: ToolContext['onSecurityEvent'];
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
  'i',
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

/** 命令指纹（审计）：sha256 hex——脱敏留痕（preview 截断 + hash 可对账） */
function commandSha256(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

// ---------- bash 工具 ----------

const runCommandSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  cwd: z
    .string()
    .optional()
    .describe('工作目录（默认工作空间根；完全访问时可用任意路径）'),
});

interface ExecOutcome {
  code: number | null;
  /** 失败原因标签（空串=普通退出码失败）：超时 / 输出超限 */
  label: '' | '超时' | '输出超限';
  stdout: string;
  stderr: string;
}

/** maxBuffer 溢出（输出超 1MB）：新版 Node 有专用错误码，旧版仅在 message 提及 */
function isMaxBufferError(error: Error & { code?: unknown }): boolean {
  return (
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    /maxBuffer/i.test(error.message)
  );
}

/** cwd 解析：完全访问态直传不限定；默认态限定工作空间内，越界回退工作空间根。
 *  未绑定目录（workspacePath 空串）以家目录为锚——钳制/回退/审计语义不变 */
function resolveCwd(ctx: CommandContext, rel?: string): string | undefined {
  if (ctx.fullAccess) return rel ?? undefined;
  const anchor = ctx.workspacePath || os.homedir();
  const resolved = path.resolve(anchor, rel ?? '.');
  const inBounds =
    resolved === anchor || resolved.startsWith(anchor + path.sep);
  if (!inBounds) {
    ctx.onSecurityEvent?.({
      eventType: 'command-safety.cwd-fallback',
      decision: 'info',
      detail: { requested: resolved, fallback: anchor },
      sessionId: ctx.sessionId,
    });
  }
  return inBounds ? resolved : anchor;
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
      {
        cwd,
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: EXEC_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, label: '', stdout, stderr });
        } else if (isMaxBufferError(error)) {
          // 溢出错误 killed 亦为 true，须先于超时判定
          resolve({ code: null, label: '输出超限', stdout, stderr });
        } else if (error.killed) {
          resolve({ code: null, label: '超时', stdout, stderr });
        } else if (typeof error.code === 'number') {
          resolve({ code: error.code, label: '', stdout, stderr });
        } else {
          reject(error);
        }
      },
    );
  });
}

/** 合并 stdout/stderr 并截断至 8KB（尾部加截断标记） */
function mergeOutput(stdout: string, stderr: string): string {
  const merged = [stdout, stderr].filter((part) => part.length > 0).join('\n');
  return merged.length > OUTPUT_LIMIT
    ? merged.slice(0, OUTPUT_LIMIT) + '\n…（已截断）'
    : merged;
}

const runCommandTool: ToolDefinition<z.infer<typeof runCommandSchema>> = {
  name: 'bash',
  description: '执行工作空间内 shell 命令，返回退出码与输出；高危命令需批准',
  parameters: runCommandSchema,
  kind: 'write',
  execute: async (ctx: CommandContext, args) => {
    if (isDangerousCommand(args.command)) {
      ctx.onSecurityEvent?.({
        eventType: 'command-safety.blocked',
        decision: 'blocked',
        detail: { command: args.command.slice(0, 200), source: 'dangerous' },
        commandPreview: args.command.slice(0, 100),
        commandHash: commandSha256(args.command),
        sessionId: ctx.sessionId,
      });
      // 拦截文案按命令形态分流指引（T35 渐进披露）：删文件类指向
      // rm（原在 rm 描述里的「优先于 rm」教学挪此）
      const deleteHint = /\b(?:rm|rd|rmdir|del|erase)\b/i.test(args.command)
        ? '；删除文件请改用 rm 工具'
        : '';
      return `错误: 该命令被安全策略拦截（高风险破坏性操作）${deleteHint}`;
    }
    try {
      const { code, label, stdout, stderr } = await runExec(
        args.command,
        resolveCwd(ctx, args.cwd),
      );
      const out = mergeOutput(stdout, stderr);
      if (code === 0) return `退出码 0\n${out}`;
      const suffix = label ? `/${label}` : '';
      return `错误: 命令失败（退出码 ${code ?? '-'}${suffix}）\n${out}`;
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
