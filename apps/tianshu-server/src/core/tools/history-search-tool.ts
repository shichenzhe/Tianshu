/**
 * search_history 工具 server 版（spec 2026-11-02-history-search-tool-design
 * 移植批）：chat 模型检索当前用户的历史会话——三级裁剪均为单向有损，
 * 丢失细节对模型永久不可达，本工具兜底「需要时一次调用捞回」（mirror
 * electron/domains/ai/agent/history-search-tool.ts 同构：WB 三设计吸收
 * ——当前会话零访问经 ctx.sessionId 排除/查询自包含/检索路由分层）。
 * 分歧点（drift 不入册，本 spec 测试守护——library 工具对先例）：本仓
 * prisma 模型名 sessionRecord/messageRecord（@@map 同表名）；db 经 deps
 * 注入、缺省 graphExecutorRuntime() 取进程级句柄（library-tools 先例）。
 * 检索实现 LIKE（blocks contains）起步——FTS5 本仓 Prisma 引擎栈无
 * （spec 非目标：向量化；PG 检索层批后可再评估 FTS）。
 */
import { z } from 'zod';
import { parseBlocks } from '@tianshu/core';
import type { ToolDefinition } from './tool-definition';

export const HISTORY_SEARCH_TOOL_NAME = 'search_history';

/** message 扫描上限：10 组上限 × 每组多片段富余量，防长历史全表深扫 */
export const MESSAGE_SCAN_LIMIT = 60;

/** 每会话返回片段上限 */
const SNIPPETS_PER_SESSION = 3;

/** 片段字符窗口上限 */
const SNIPPET_WINDOW_CHARS = 300;

/** query 截长（防超长 LIKE） */
const QUERY_MAX_CHARS = 100;

/** 默认返回会话组数 */
const DEFAULT_LIMIT = 5;

/** 空结果文案（导出供测试断言；含改写建议回指自包含查询） */
export const HISTORY_SEARCH_EMPTY =
  '未命中历史会话——请尝试更具体的关键词，并附上已知的时间范围或背景描述';

const argsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('自包含的检索描述：要找的内容关键词 + 已知时间范围或背景'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('返回会话数，缺省 5'),
});

export type HistorySearchArgs = z.infer<typeof argsSchema>;

/** session 行最小消费形状（prisma 全行结构满足；stub 只需这两列） */
export interface HistorySearchSessionRow {
  id: number;
  title: string | null;
}

/** message 行最小消费形状 */
export interface HistorySearchMessageRow {
  sessionId: number;
  blocks: string;
  createdAt: Date;
}

/** prisma 结构子集（注入 stub/真实客户端均可；library-tools 先例） */
export interface HistorySearchPrisma {
  sessionRecord: {
    findMany(args: {
      where: { userId: number };
      select: { id: true; title: true };
    }): Promise<HistorySearchSessionRow[]>;
  };
  messageRecord: {
    findMany(args: {
      where: { blocks: { contains: string }; sessionId: { in: number[] } };
      orderBy: { createdAt: 'desc' };
      take: number;
    }): Promise<HistorySearchMessageRow[]>;
  };
}

/** 换行压平（\r\n 先行保证 1:1 替换不漂移索引） */
function flatten(text: string): string {
  return text.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
}

/** 以命中位置为中心截窗口（≤300 字符），两侧截断处加省略号 */
function windowAround(text: string, index: number): string {
  const start = Math.max(0, index - SNIPPET_WINDOW_CHARS / 2);
  const end = Math.min(text.length, start + SNIPPET_WINDOW_CHARS);
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end) +
    (end < text.length ? '…' : '')
  );
}

/**
 * 单条消息片段提取（纯函数）：blocks 解析后按块序收集可读源（text/
 * thinking 文本、tool_call 字符串 output）——命中工具输出正是本工具
 * 价值（找回被瘦身掉的旧输出）；大小写不敏感。优先返回含 query 的
 * 可读源窗口；可读源均未含（如仅 args 命中）取首个非空源头部；无
 * 可读源（纯 image）或 blocks 非法 JSON 返回 null（调用方剔除）
 */
export function extractSnippet(
  blocksJson: string,
  query: string,
): string | null {
  const blocks = parseBlocks(blocksJson);
  const sources: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'thinking') {
      sources.push(flatten(block.text));
    } else if (block.type === 'tool_call' && typeof block.output === 'string') {
      sources.push(flatten(block.output));
    }
  }
  const readable = sources.filter((s) => s.length > 0);
  if (readable.length === 0) {
    return null;
  }
  const needle = query.toLowerCase();
  for (const source of readable) {
    const index = source.toLowerCase().indexOf(needle);
    if (index >= 0) {
      return source.length <= SNIPPET_WINDOW_CHARS
        ? source
        : windowAround(source, index);
    }
  }
  // 可读源无命中（LIKE 命中在 args/块结构里）：头部窗口仍有信息量
  const first = readable[0];
  return first.length <= SNIPPET_WINDOW_CHARS
    ? first
    : first.slice(0, SNIPPET_WINDOW_CHARS) + '…';
}

/** 会话标题回退（DB default 非空，旧行兜底） */
const sessionTitle = (title: string | null): string => title ?? '未命名会话';

/** 消息日期（UTC ISO 日期段，工具结果稳定输出） */
const messageDate = (createdAt: Date): string =>
  createdAt.toISOString().slice(0, 10);

/**
 * 检索结果格式化（纯函数）：rows 须为 createdAt 倒序（findMany orderBy
 * 保证）——按 sessionId 首现序分组即最新会话优先；每组片段上限 3，全部
 * 无可读片段的组整组剔除；行格式 `- 标题（YYYY-MM-DD）：片段 … 片段`
 */
export function formatHistorySearchResults(
  rows: HistorySearchMessageRow[],
  sessions: HistorySearchSessionRow[],
  query: string,
  limit: number,
): string {
  const titleById = new Map(sessions.map((s) => [s.id, s.title]));
  const snippetsBySession = new Map<number, string[]>();
  for (const row of rows) {
    const snippets = snippetsBySession.get(row.sessionId) ?? [];
    if (snippets.length >= SNIPPETS_PER_SESSION) {
      continue;
    }
    const snippet = extractSnippet(row.blocks, query);
    if (snippet !== null) {
      snippets.push(snippet);
      snippetsBySession.set(row.sessionId, snippets);
    }
  }
  const groups = [
    ...(snippetsBySession.entries() as IterableIterator<[number, string[]]>),
  ]
    .slice(0, limit)
    .map(
      ([sessionId, snippets]) =>
        `- ${sessionTitle(titleById.get(sessionId) ?? null)}（${messageDate(
          rows.find((r) => r.sessionId === sessionId)!.createdAt,
        )}）：${snippets.join(' … ')}`,
    );
  if (groups.length === 0) {
    return HISTORY_SEARCH_EMPTY;
  }
  return `历史会话命中 ${groups.length} 个：\n${groups.join('\n')}`;
}

/**
 * 工具工厂：db 缺省经 graphExecutorRuntime() 取进程级句柄（注册表单例
 * 在安装前构造，须取用时解析——library-tools 先例）；chat 会话装配显式
 * 注入本仓 prisma
 */
export function makeHistorySearchTool(
  deps: { db?: HistorySearchPrisma } = {},
): ToolDefinition<HistorySearchArgs> {
  return {
    name: HISTORY_SEARCH_TOOL_NAME,
    description:
      '检索当前用户的历史会话（不含本会话），返回命中片段与所属会话：' +
      '仅当需要当前上下文中不存在的过去事件、讨论结论或文件路径时调用；' +
      '查询必须自包含——描述要找的内容与已知时间范围或背景；' +
      '当前上下文已有或任务自包含时不要调用',
    parameters: argsSchema,
    kind: 'read',
    execute: async (ctx, { query, limit }) => {
      const trimmed = query.trim().slice(0, QUERY_MAX_CHARS);
      if (!trimmed) {
        return HISTORY_SEARCH_EMPTY;
      }
      const db =
        deps.db ??
        (await import('../graph/executor-runtime')).graphExecutorRuntime().db;
      const userId = ctx.userId ?? 0;
      const sessions = await db.sessionRecord.findMany({
        where: { userId },
        select: { id: true, title: true },
      });
      // 当前会话排除（WB「零访问」设计）：图执行 sessionId null 无排除对象
      const searchableIds = sessions
        .filter((s) => s.id !== ctx.sessionId)
        .map((s) => s.id);
      const rows = await db.messageRecord.findMany({
        where: {
          blocks: { contains: trimmed },
          sessionId: { in: searchableIds },
        },
        orderBy: { createdAt: 'desc' },
        take: MESSAGE_SCAN_LIMIT,
      });
      return formatHistorySearchResults(
        rows,
        sessions,
        trimmed,
        limit ?? DEFAULT_LIMIT,
      );
    },
  };
}

/** 注册表静态装配用的单例（定义无状态、db 取用时解析，进程内共享安全
 *  ——LIBRARY_SEARCH_TOOL 先例；graph LLM 节点 tools:true 经 registry 获得） */
export const HISTORY_SEARCH_TOOL = makeHistorySearchTool();
