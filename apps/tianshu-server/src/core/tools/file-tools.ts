/**
 * 内置文件工具（自 mirror electron/domains/ai/agent/file-tools.ts 移植）：
 * 路径全部限定工作空间内，错误一律转字符串回喂，纯 Node 可被 jest 直接测试。
 * 无头端偏离一处：rm 的回收站分支——mirror 依赖 electron
 * shell.trashItem，服务端改为移入数据根 trash/ 目录（rename 落盘，跨设备
 * EXDEV 回退 copy+rm），语义（默认保护、可恢复）与 mirror 对齐。
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from './tool-definition';

export type { ToolDefinition } from './tool-definition';

const READ_LIMIT = 512 * 1024;
const WRITE_LIMIT = 1024 * 1024;
const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_RESULT_LIMIT = 50;

/** 工具失败的统一文案（回喂模型，不抛出）；web-tools 同语义复用 */
export function fail(message: string): string {
  return `错误: ${message}`;
}

/** 任意异常 → 字符串文案：PATH_OUTSIDE_WORKSPACE / ENOENT / EISDIR 译为中文 */
function toToolResult(e: unknown): string {
  if (e instanceof Error) {
    if (e.message === 'PATH_OUTSIDE_WORKSPACE')
      return fail('路径超出工作空间范围');
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fail('文件不存在');
    if (code === 'EISDIR') return fail('目标是目录，无法作为文件处理');
    return fail(e.message);
  }
  return fail(String(e));
}

/** 数据安全审计事件（detail.path 截 200） */
function emitDataEvent(
  ctx: ToolContext,
  eventType: string,
  decision: 'info' | 'failed',
  detail: Record<string, unknown>,
): void {
  if ('path' in detail && typeof detail.path === 'string') {
    detail.path = detail.path.slice(0, 200);
  }
  ctx.onSecurityEvent?.({
    eventType,
    decision,
    detail,
    sessionId: ctx.sessionId,
  });
}

/** 备份并审计：成功 backup-created；失败 backup-skipped；返回是否成功 */
async function backupAndAudit(
  ctx: ToolContext,
  absPath: string,
): Promise<boolean> {
  if (!ctx.onBackupFile) return false;
  const r = await ctx.onBackupFile(absPath, ctx.sessionId);
  if (r.ok) {
    emitDataEvent(ctx, 'data-safety.backup-created', 'info', {
      path: absPath,
      size: r.size,
    });
    return true;
  }
  if (r.reason !== 'disabled') {
    emitDataEvent(ctx, 'data-safety.backup-skipped', 'info', {
      path: absPath,
      reason: r.reason.slice(0, 200),
    });
  }
  return false;
}

/**
 * 对可能不存在的路径取 realpath：沿祖先上溯到存在的一级，再拼回缺失段。
 */
export function realPathLenient(target: string): string {
  try {
    return fsSync.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realPathLenient(parent), path.basename(target));
  }
}

/** 授权清单命中：realpath 归一后精确相等（缺失段沿祖先解析，形态无关） */
function hitsExtraAllowed(resolved: string, entries: string[]): boolean {
  const real = realPathLenient(resolved);
  return entries.some((entry) => realPathLenient(entry) === real);
}

/**
 * 解析并校验工作空间内路径：resolve 前缀校验 + realpath（symlink 跟随后）
 * 再校验。对尚不存在的新路径，缺失段沿最近存在祖先解析后再校验（防
 * symlink 目录逃逸）。越界抛 Error("PATH_OUTSIDE_WORKSPACE")；返回值为
 * 工作空间内的绝对路径。fullAccess=true 时跳过全部校验（含 realpath
 * 双检）：绝对路径直接 resolve 返回；相对路径仍以 workspacePath 为基。
 * extraAllowed：命中授权的绝对路径越界放行（realpath 归一精确比对）。
 */
export function resolveSafePath(
  workspacePath: string,
  relative: string,
  fullAccess = false,
  extraAllowed?: string[],
): string {
  if (fullAccess) {
    return path.isAbsolute(relative)
      ? path.resolve(relative)
      : path.resolve(workspacePath, relative);
  }
  const resolved = path.resolve(workspacePath, relative);
  // 授权命中在前：越界路径唯一合法来源即清单（未命中继续走下方双检拒绝）
  if (extraAllowed?.length && hitsExtraAllowed(resolved, extraAllowed)) {
    return resolved;
  }
  if (
    resolved !== workspacePath &&
    !resolved.startsWith(workspacePath + path.sep)
  ) {
    throw new Error('PATH_OUTSIDE_WORKSPACE');
  }
  const realWs = fsSync.realpathSync(workspacePath);
  const real = realPathLenient(resolved);
  if (real !== realWs && !real.startsWith(realWs + path.sep)) {
    throw new Error('PATH_OUTSIDE_WORKSPACE');
  }
  return resolved;
}

// ---------- read ----------

const readFileSchema = z.object({
  path: z.string().describe('工作空间内的相对路径'),
});

const readFileTool: ToolDefinition<z.infer<typeof readFileSchema>> = {
  name: 'read',
  description: '读取工作空间内文本文件（带行号，相对路径）',
  parameters: readFileSchema,
  kind: 'read',
  execute: async (ctx, args) => {
    try {
      const target = resolveSafePath(
        ctx.workspacePath,
        args.path,
        ctx.fullAccess,
        ctx.grantedPaths,
      );
      const stat = await fs.stat(target);
      if (stat.size > READ_LIMIT) return fail('文件超过 512KB 读取上限');
      const buf = await fs.readFile(target);
      if (buf.includes(0)) return fail('文件含二进制内容（NUL），不支持读取');
      const lines = buf.toString('utf8').split('\n');
      return lines
        .map((line, i) => `${String(i + 1).padStart(6, ' ')}| ${line}`)
        .join('\n');
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- write ----------

const writeFileSchema = z.object({
  path: z.string().describe('相对路径'),
  content: z.string().describe('完整文件内容（覆盖写入）'),
});

const writeFileTool: ToolDefinition<z.infer<typeof writeFileSchema>> = {
  name: 'write',
  description: '覆盖写入工作空间内文件（自动建父目录）；写操作需批准',
  parameters: writeFileSchema,
  kind: 'write',
  execute: async (ctx, args) => {
    try {
      if (!args.path.trim()) return fail('路径不能为空');
      const byteLength = Buffer.byteLength(args.content, 'utf8');
      if (byteLength > WRITE_LIMIT) return fail('内容超过 1MB 写入上限');
      const target = resolveSafePath(
        ctx.workspacePath,
        args.path,
        ctx.fullAccess,
        ctx.grantedPaths,
      );
      if (
        (await fs.stat(target).then(
          (s) => s.isFile(),
          () => false,
        )) &&
        ctx.onBackupFile
      ) {
        await backupAndAudit(ctx, target); // fail-open：失败不中断写入
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content, 'utf8');
      // 写盘成功后通知（缺席不通知）
      ctx.onFileWritten?.(target);
      return `已写入 ${args.path}（${byteLength} 字节）`;
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- ls ----------

const listDirSchema = z.object({
  path: z.string().optional().describe('相对路径，空为根目录'),
});

const listDirTool: ToolDefinition<z.infer<typeof listDirSchema>> = {
  name: 'ls',
  description: '列出目录一层内容（不递归、忽略隐藏项）',
  parameters: listDirSchema,
  kind: 'read',
  execute: async (ctx, args) => {
    try {
      // full 态接受绝对路径根（args.path 绝对 → 以它为基），相对路径仍基于工作空间
      const target = resolveSafePath(
        ctx.workspacePath,
        args.path ?? '',
        ctx.fullAccess,
        ctx.grantedPaths,
      );
      const entries = await fs.readdir(target, { withFileTypes: true });
      const visible = entries.filter((entry) => !entry.name.startsWith('.'));
      visible.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name),
      );
      const lines: string[] = [];
      for (const entry of visible) {
        if (entry.isDirectory()) {
          lines.push(`${entry.name}/\t目录`);
        } else if (entry.isFile()) {
          const stat = await fs.stat(path.join(target, entry.name));
          lines.push(`${entry.name}\t文件 ${stat.size}B`);
        }
      }
      return lines.join('\n') || '（空目录）';
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- grep ----------

const searchFilesSchema = z.object({
  pattern: z.string().describe('正则表达式'),
  glob: z.string().optional().describe('文件名过滤，如 *.ts'),
  output_mode: z
    .enum(['content', 'files_with_matches'])
    .optional()
    .describe('输出模式，默认 files_with_matches'),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('结果条数上限，默认 50'),
});

/** 简易 glob → RegExp（仅支持 * 与 ?，整段匹配文件名） */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist']);

/** M3 扫描预算：大工作区单次调用会串行读几百 MB，属资源失控 */
export interface CollectLimits {
  maxFiles: number;
  maxDepth: number;
}
const COLLECT_DEFAULT_LIMITS: CollectLimits = {
  maxFiles: 20000,
  maxDepth: 12,
};
/** 单次 grep 读取总字节预算（与单文件 2MB 上限互补） */
const SEARCH_TOTAL_BYTES_BUDGET = 64 * 1024 * 1024;

/**
 * 递归收集目录下文件（排除隐藏项与排除清单；symlink 条目不跟随）。
 * 返回 false = 已达预算截断（acc 内为已收集部分），true = 完整收集。
 */
export async function collectFiles(
  dir: string,
  acc: string[],
  depth = 0,
  limits: CollectLimits = COLLECT_DEFAULT_LIMITS,
): Promise<boolean> {
  if (depth > limits.maxDepth) {
    return false;
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const complete = await collectFiles(
        path.join(dir, entry.name),
        acc,
        depth + 1,
        limits,
      );
      if (!complete) return false;
    } else if (entry.isFile()) {
      if (acc.length >= limits.maxFiles) return false;
      acc.push(path.join(dir, entry.name));
    }
  }
  return true;
}

/** 正则防护上限：pattern 长度与逐行测试截断（模型生成物非用户手输，从严） */
const PATTERN_MAX_LENGTH = 200;
const LINE_TEST_SLICE = 2000;

/** 无界量词源：+、*、{n,}（有界 {n}/{n,m} 上限明确，非灾难回溯源） */
const UNBOUNDED_QUANT_SRC = '\\+|\\*|\\{\\d+,\\d*\\}';

/**
 * 嵌套量词形态（如 (a+)+、(\w{2,})*）：分组内带无界量词且分组自身再带
 * 无界量词——灾难性回溯（ReDoS）的典型源。启发式不跨内层括号。
 */
const NESTED_UNBOUNDED_QUANT = new RegExp(
  `\\((?:\\\\.|[^()\\\\])*(?:${UNBOUNDED_QUANT_SRC})(?:\\\\.|[^()\\\\])*\\)(?:${UNBOUNDED_QUANT_SRC})`,
);

/**
 * 编译用户（模型）提供的正则，含 ReDoS 三重防护：
 * 长度上限、嵌套量词形态拒绝、行截断（调用方）；非法时抛可读错误
 */
function compileRegex(pattern: string): RegExp {
  if (pattern.length > PATTERN_MAX_LENGTH) {
    throw new Error(
      `正则过长（超 ${PATTERN_MAX_LENGTH} 字符）: ${pattern.slice(0, 50)}…`,
    );
  }
  if (NESTED_UNBOUNDED_QUANT.test(pattern)) {
    throw new Error(
      '正则含嵌套量词（如 (a+)* 形态），存在灾难性回溯风险，请改写为更简单的模式',
    );
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`无效的正则表达式: ${pattern}`);
  }
}

const searchFilesTool: ToolDefinition<z.infer<typeof searchFilesSchema>> = {
  name: 'grep',
  description: '搜索工作空间文件内容（正则；glob 可过滤文件名）',
  parameters: searchFilesSchema,
  kind: 'read',
  execute: async (ctx, args) => {
    try {
      const regex = compileRegex(args.pattern);
      const globRe = args.glob ? globToRegExp(args.glob) : null;
      const filesMode =
        (args.output_mode ?? 'files_with_matches') === 'files_with_matches';
      const limit = args.head_limit ?? SEARCH_RESULT_LIMIT;
      const files: string[] = [];
      // 搜索根：schema 无 path 参数，根恒为 workspacePath
      const collectedAll = await collectFiles(ctx.workspacePath, files);
      const matchedFiles = new Set<string>();
      const contentLines: string[] = [];
      let bytesLeft = SEARCH_TOTAL_BYTES_BUDGET;
      let bytesExhausted = false;
      for (const file of files) {
        if (globRe && !globRe.test(path.basename(file))) continue;
        const stat = await fs.stat(file);
        if (stat.size > SEARCH_FILE_LIMIT) continue;
        if (stat.size > bytesLeft) {
          bytesExhausted = true;
          break;
        }
        bytesLeft -= stat.size;
        const buf = await fs.readFile(file);
        if (buf.includes(0)) continue;
        const rel = path
          .relative(ctx.workspacePath, file)
          .split(path.sep)
          .join('/');
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          // 行截断防超长行与正则灾难回溯的组合放大
          const line = lines[i].slice(0, LINE_TEST_SLICE);
          if (regex.test(line)) {
            matchedFiles.add(rel);
            if (!filesMode) contentLines.push(`${rel}:${i + 1}: ${line}`);
          }
        }
      }
      const results = filesMode ? [...matchedFiles] : contentLines;
      // 截断提示（模型可据此收窄 glob 或分层搜索）
      const notes: string[] = [];
      if (!collectedAll) {
        notes.push(
          '（收集截断：文件数或目录深度超上限，建议用 glob 收窄或分目录搜索）',
        );
      }
      if (bytesExhausted) {
        notes.push('（读取截断：累计已读字节达预算上限，建议收窄搜索范围）');
      }
      if (results.length === 0) {
        return notes.length > 0 ? notes.join('\n') : '未找到匹配内容';
      }
      const body = results.slice(0, limit).join('\n');
      const truncatedByLimit =
        results.length > limit ? `\n…（已截断至 ${limit} 条）` : '';
      return notes.length > 0
        ? `${body}${truncatedByLimit}\n${notes.join('\n')}`
        : `${body}${truncatedByLimit}`;
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- rm ----------

const deleteFileSchema = z.object({
  path: z.string().describe('要删除的文件或目录（相对路径，目录递归删）'),
});

/** 目录树收集全部文件绝对路径（供备份遍历） */
async function listFilesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) files.push(full);
    }
  }
  return files;
}

/** 服务端回收目录根（mirror shell.trashItem 的无头替代）：数据根下 trash/ */
export function trashRootOf(ctx: ToolContext): string {
  return ctx.trashRoot ?? path.join(os.homedir(), '.tianshu-server', 'trash');
}

/** 递归复制（跨设备 EXDEV 回退用） */
async function copyRecursive(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    return;
  }
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    await copyRecursive(path.join(src, ent.name), path.join(dest, ent.name));
  }
}

/**
 * 移入服务端回收目录（deleteProtection 缺省/true 分支）：
 * <trashRoot>/<sessionId>/<epoch>-<basename>，rename 原子落盘；跨设备
 * EXDEV 回退 copy+rm（工作空间目录可能在另一卷）。同名冲突由 epoch
 * 前缀天然错开。
 */
async function trashDelete(
  ctx: ToolContext,
  target: string,
  rel: string,
): Promise<string> {
  try {
    const dest = path.join(
      trashRootOf(ctx),
      String(ctx.sessionId),
      `${Date.now()}-${path.basename(target)}`,
    );
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(target, dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      await copyRecursive(target, dest);
      await fs.rm(target, { recursive: true, force: false });
    }
    emitDataEvent(ctx, 'data-safety.delete-trashed', 'info', {
      path: rel,
      trash: dest,
    });
    return `已将 ${rel} 移入回收目录`;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    emitDataEvent(ctx, 'data-safety.delete-failed', 'failed', {
      path: rel,
      error: error.slice(0, 200),
    });
    return fail(`移入回收目录失败: ${error}（文件已保留）`);
  }
}

/** 永久删除分支（deleteProtection=false）：先逐文件备份（fail-open）再递归删 */
async function permanentDelete(
  ctx: ToolContext,
  target: string,
  rel: string,
  isDir: boolean,
): Promise<string> {
  const files = isDir ? await listFilesUnder(target) : [target];
  let backed = 0;
  for (const f of files) {
    if (await backupAndAudit(ctx, f)) backed += 1;
  }
  await fs.rm(target, { recursive: true, force: false });
  emitDataEvent(ctx, 'data-safety.delete-permanent', 'info', {
    path: rel,
    files: files.length,
  });
  return `已永久删除 ${rel}（${files.length} 个文件，已备份 ${backed} 个）`;
}

const deleteFileTool: ToolDefinition<z.infer<typeof deleteFileSchema>> = {
  name: 'rm',
  description: '删除文件或目录（递归），默认移入回收目录；写操作需批准',
  parameters: deleteFileSchema,
  kind: 'write',
  execute: async (ctx, args) => {
    try {
      if (!args.path.trim()) return fail('路径不能为空');
      const target = resolveSafePath(
        ctx.workspacePath,
        args.path,
        ctx.fullAccess,
        ctx.grantedPaths,
      );
      const stat = await fs.stat(target).catch(() => null);
      if (!stat) return fail('文件不存在');
      const rel = args.path;
      if (ctx.deleteProtection !== false) return trashDelete(ctx, target, rel);
      return permanentDelete(ctx, target, rel, stat.isDirectory());
    } catch (e) {
      return toToolResult(e);
    }
  },
};

export const FILE_TOOLS: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  searchFilesTool,
  deleteFileTool,
];

/** 按名取内置文件工具 */
export function makeFileTool(
  name:
    'read' | 'write' | 'ls' | 'grep' | 'rm',
): ToolDefinition<never> {
  const tool = FILE_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`未知文件工具: ${name}`);
  return tool;
}
