/**
 * 项目记忆（设计文档 §6 P0，批8）：会话交接把「决议 + 产出物索引」沉淀进
 * 项目资产空间固定文件 memory.md，getPromptContext 读回注入项目会话
 * system base——「指令（人写 systemPrompt）+ 记忆（AI 沉淀）」双层上下文。
 * 纯函数、无 IO（文件读写分别在 project.repo 的 appendMemory/getPromptContext）。
 *
 * 文件形态：固定头 + 若干条目段；条目以 HTML 注释标记行锚定分隔
 * （markdown 渲染不可见，且不受摘要正文内 "## " 标题干扰）。条目追加在尾
 * （时间序），超 MEMORY_MAX_ENTRIES 裁最旧；system 注入侧另有字符预算
 * （整段取舍保最新），防长记忆撑爆上下文。
 */

/** 资产空间内固定文件名（workspace 相对路径根级） */
export const MEMORY_FILE = "memory.md";

/** 文件内条目保留上限（追加在尾，超限裁最旧） */
export const MEMORY_MAX_ENTRIES = 20;

/** system 注入字符预算（整段取舍，保最新；至少保留最新一段） */
export const MEMORY_PROMPT_CHAR_LIMIT = 8000;

/** 条目标记行前缀（markdown 注释，渲染不可见） */
export const MEMORY_ENTRY_MARKER_PREFIX = "<!-- tianshu:memory-entry ";

/** 文件固定头（AI 沉淀层说明；正文提取时剥去不进 system） */
export const MEMORY_HEADER = [
  "# 项目记忆（AI 沉淀）",
  "",
  "> 由会话交接自动追加：历次工作的决议与产出物索引（最新在末尾）。",
  "> 本文件作为项目上下文注入会话，可人工编辑整理。",
].join("\n");

/** 单条记忆条目（交接回写载荷） */
export interface ProjectMemoryEntry {
  /** 条目标题（如交接待办标题） */
  title: string;
  /** 决议/交接摘要（markdown） */
  summary: string;
  /** 产出物索引（资产空间相对路径） */
  artifacts?: string[];
}

/** 内容字段剥离标记前缀（防摘要正文伪造条目边界拆段；内容本身保留） */
function stripMarker(text: string): string {
  return text.split(MEMORY_ENTRY_MARKER_PREFIX).join("<!-- memory-entry ");
}

/** 本地时间 yyyy-MM-dd HH:mm */
function formatStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 条目 → markdown 段（标记行 + 时间标题 + 摘要 + 产出物索引） */
export function renderMemoryEntry(entry: ProjectMemoryEntry, at: Date): string {
  const lines = [
    `${MEMORY_ENTRY_MARKER_PREFIX}${at.toISOString()} -->`,
    `## [${formatStamp(at)}] ${stripMarker(entry.title).trim()}`,
  ];
  const summary = stripMarker(entry.summary).trim();
  if (summary) {
    lines.push("", summary);
  }
  const artifacts = (entry.artifacts ?? [])
    .map((artifact) => stripMarker(artifact).trim())
    .filter(Boolean);
  if (artifacts.length > 0) {
    lines.push("", "产出物：", ...artifacts.map((artifact) => `- ${artifact}`));
  }
  return lines.join("\n");
}

/** 文件内容 → 条目段数组（标记行锚定、随段保留——merge 重写时不可丢标记；
 *  头部/非条目内容丢弃，空段过滤） */
export function parseMemorySections(content: string | null): string[] {
  if (!content) {
    return [];
  }
  return content
    .split(/(?=^<!-- tianshu:memory-entry )/m)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith(MEMORY_ENTRY_MARKER_PREFIX));
}

/** 合并回写：既有条目 + 新条目（追加在尾），超上限裁最旧，重写固定头 */
export function mergeMemoryContent(
  existing: string | null,
  entry: ProjectMemoryEntry,
  at: Date = new Date(),
  maxEntries: number = MEMORY_MAX_ENTRIES,
): string {
  const sections = [
    ...parseMemorySections(existing),
    renderMemoryEntry(entry, at),
  ];
  return [MEMORY_HEADER, ...sections.slice(-maxEntries)].join("\n\n");
}

/** system 注入正文：条目段拼接（剥固定头）；超字符预算从最旧整段丢弃，
 *  至少保最新一段；无条目 → null（调用方不注入记忆段） */
export function extractMemoryBody(
  content: string | null,
  charLimit: number = MEMORY_PROMPT_CHAR_LIMIT,
): string | null {
  const sections = parseMemorySections(content);
  const kept: string[] = [];
  let size = 0;
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    if (kept.length > 0 && size + sections[index].length > charLimit) {
      break;
    }
    kept.unshift(sections[index]);
    size += sections[index].length;
  }
  return kept.length > 0 ? kept.join("\n\n") : null;
}
