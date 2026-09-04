/**
 * 内置文件工具（P1）：路径全部限定工作空间内，错误一律转字符串回喂
 * 纯 Node 实现（禁止 import electron），可被 vitest 直接测试
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface ToolContext {
  workspacePath: string;
  sessionId: number;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  parameters: z.ZodType<TArgs>;
  kind: "read" | "write";
  /** 方法签名（非属性）以保持 ToolDefinition<T> 到 ToolDefinition<unknown> 的可赋值性 */
  execute(ctx: ToolContext, args: TArgs): Promise<string>;
}

const READ_LIMIT = 512 * 1024;
const WRITE_LIMIT = 1024 * 1024;
const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_RESULT_LIMIT = 50;

/** 工具失败的统一文案（回喂模型，不抛出） */
function fail(message: string): string {
  return `错误: ${message}`;
}

/** 任意异常 → 字符串文案：PATH_OUTSIDE_WORKSPACE / ENOENT / EISDIR 译为中文 */
function toToolResult(e: unknown): string {
  if (e instanceof Error) {
    if (e.message === "PATH_OUTSIDE_WORKSPACE")
      return fail("路径超出工作空间范围");
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return fail("文件不存在");
    if (code === "EISDIR") return fail("目标是目录，无法作为文件处理");
    return fail(e.message);
  }
  return fail(String(e));
}

/** 对可能不存在的路径取 realpath：沿祖先上溯到存在的一级，再拼回缺失段 */
function realPathLenient(target: string): string {
  try {
    return fsSync.realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    if (parent === target) return target;
    return path.join(realPathLenient(parent), path.basename(target));
  }
}

/**
 * 解析并校验工作空间内路径：resolve 前缀校验 + realpath（symlink 跟随后）再校验。
 * 对尚不存在的新路径，缺失段沿最近存在祖先解析后再校验（防 symlink 目录逃逸）。
 * 越界抛 Error("PATH_OUTSIDE_WORKSPACE")；返回值为工作空间内的绝对路径。
 */
export function resolveSafePath(
  workspacePath: string,
  relative: string,
): string {
  const resolved = path.resolve(workspacePath, relative);
  if (
    resolved !== workspacePath &&
    !resolved.startsWith(workspacePath + path.sep)
  ) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const realWs = fsSync.realpathSync(workspacePath);
  const real = realPathLenient(resolved);
  if (real !== realWs && !real.startsWith(realWs + path.sep)) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  return resolved;
}

// ---------- read_file ----------

const readFileSchema = z.object({
  path: z.string().describe("工作空间内的相对路径"),
});

const readFileTool: ToolDefinition<z.infer<typeof readFileSchema>> = {
  name: "read_file",
  description: "读取工作空间内的文本文件（带行号）。路径为工作空间内相对路径。",
  parameters: readFileSchema,
  kind: "read",
  execute: async (ctx, args) => {
    try {
      const target = resolveSafePath(ctx.workspacePath, args.path);
      const stat = await fs.stat(target);
      if (stat.size > READ_LIMIT) return fail("文件超过 512KB 读取上限");
      const buf = await fs.readFile(target);
      if (buf.includes(0)) return fail("文件含二进制内容（NUL），不支持读取");
      const lines = buf.toString("utf8").split("\n");
      return lines
        .map((line, i) => `${String(i + 1).padStart(6, " ")}| ${line}`)
        .join("\n");
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- write_file ----------

const writeFileSchema = z.object({
  path: z.string().describe("相对路径"),
  content: z.string().describe("完整文件内容（覆盖写入）"),
});

const writeFileTool: ToolDefinition<z.infer<typeof writeFileSchema>> = {
  name: "write_file",
  description:
    "将内容覆盖写入工作空间内文件（自动创建父目录）。写操作需用户批准。",
  parameters: writeFileSchema,
  kind: "write",
  execute: async (ctx, args) => {
    try {
      if (!args.path.trim()) return fail("路径不能为空");
      const byteLength = Buffer.byteLength(args.content, "utf8");
      if (byteLength > WRITE_LIMIT) return fail("内容超过 1MB 写入上限");
      const target = resolveSafePath(ctx.workspacePath, args.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content, "utf8");
      return `已写入 ${args.path}（${byteLength} 字节）`;
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- list_dir ----------

const listDirSchema = z.object({
  path: z.string().optional().describe("相对路径，空为根目录"),
});

const listDirTool: ToolDefinition<z.infer<typeof listDirSchema>> = {
  name: "list_dir",
  description: "列出目录一层的文件与子目录（不递归，忽略隐藏项）。",
  parameters: listDirSchema,
  kind: "read",
  execute: async (ctx, args) => {
    try {
      const target = resolveSafePath(ctx.workspacePath, args.path ?? "");
      const entries = await fs.readdir(target, { withFileTypes: true });
      const visible = entries.filter((entry) => !entry.name.startsWith("."));
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
      return lines.join("\n") || "（空目录）";
    } catch (e) {
      return toToolResult(e);
    }
  },
};

// ---------- search_files ----------

const searchFilesSchema = z.object({
  pattern: z.string().describe("正则表达式"),
  glob: z.string().optional().describe("文件名过滤，如 *.ts"),
  output_mode: z
    .enum(["content", "files_with_matches"])
    .optional()
    .describe("输出模式，默认 files_with_matches"),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("结果条数上限，默认 50"),
});

/** 简易 glob → RegExp（仅支持 * 与 ?，整段匹配文件名） */
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

const EXCLUDED_DIRS = new Set(["node_modules", ".git", "dist"]);

/** 递归收集目录下文件（排除隐藏项与排除清单；symlink 条目不跟随） */
async function collectFiles(dir: string, acc: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      acc.push(path.join(dir, entry.name));
    }
  }
}

/** 编译用户提供的正则，非法时抛可读错误（由外层转字符串） */
function compileRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    throw new Error(`无效的正则表达式: ${pattern}`);
  }
}

const searchFilesTool: ToolDefinition<z.infer<typeof searchFilesSchema>> = {
  name: "search_files",
  description: "在工作空间内按正则搜索文件内容。可用 glob 过滤文件名。",
  parameters: searchFilesSchema,
  kind: "read",
  execute: async (ctx, args) => {
    try {
      const regex = compileRegex(args.pattern);
      const globRe = args.glob ? globToRegExp(args.glob) : null;
      const filesMode =
        (args.output_mode ?? "files_with_matches") === "files_with_matches";
      const limit = args.head_limit ?? SEARCH_RESULT_LIMIT;
      const files: string[] = [];
      await collectFiles(ctx.workspacePath, files);
      const matchedFiles = new Set<string>();
      const contentLines: string[] = [];
      for (const file of files) {
        if (globRe && !globRe.test(path.basename(file))) continue;
        const stat = await fs.stat(file);
        if (stat.size > SEARCH_FILE_LIMIT) continue;
        const buf = await fs.readFile(file);
        if (buf.includes(0)) continue;
        const rel = path
          .relative(ctx.workspacePath, file)
          .split(path.sep)
          .join("/");
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matchedFiles.add(rel);
            if (!filesMode) contentLines.push(`${rel}:${i + 1}: ${lines[i]}`);
          }
        }
      }
      const results = filesMode ? [...matchedFiles] : contentLines;
      if (results.length === 0) return "未找到匹配内容";
      const body = results.slice(0, limit).join("\n");
      return results.length > limit
        ? `${body}\n…（已截断至 ${limit} 条）`
        : body;
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
];
