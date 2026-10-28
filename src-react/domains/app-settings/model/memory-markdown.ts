/**
 * 记忆画像 markdown 解析/拼接/合并（spec §3.1）：存储格式 = AI 输出格式 =
 * 导入粘贴格式，前端展示切分与主进程解析共用本模块（electron 反向
 * import src-react，沿用 automation/api/schedule.schema.ts 模式）。
 * 四节固定标题精确匹配；未知 "## " 行视为普通文本；无任何标题 → 全进 work。
 */

/** 四节 key 与中文标题的映射（节顺序即输出顺序） */
export const MEMORY_SECTION_DEFS = [
  { key: "work", title: "工作背景" },
  { key: "personal", title: "个人背景" },
  { key: "current", title: "当前关注" },
  { key: "recent", title: "近期动态" },
] as const;

export type MemorySectionKey = (typeof MEMORY_SECTION_DEFS)[number]["key"];

export interface MemorySections {
  work: string;
  personal: string;
  current: string;
  recent: string;
}

export const MEMORY_PROFILE_LIMIT = 8000;

const EMPTY_SECTIONS: MemorySections = {
  work: "",
  personal: "",
  current: "",
  recent: "",
};

const TITLE_TO_KEY = new Map<string, MemorySectionKey>(
  MEMORY_SECTION_DEFS.map(({ key, title }) => [title, key]),
);

/** 剥离 ``` 代码块围栏（导入粘贴与 AI 输出都可能带围栏） */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/** 是否识别到任一四节标题行（与 parseMemoryMarkdown 的标题识别同规则；
 * 导入弹窗据此区分「分类识别成功」与「无标题回退」） */
export function hasMemoryHeadings(md: string): boolean {
  return md
    .split("\n")
    .some((line) => TITLE_TO_KEY.has(line.trim().replace(/^##\s*/, "")));
}

/** 按四标题切分；缺节空串；无任何已知标题 → 全部进 work */
export function parseMemoryMarkdown(md: string): MemorySections {
  const sections: MemorySections = { ...EMPTY_SECTIONS };
  if (md.trim() === "") {
    return sections;
  }
  let current: MemorySectionKey | null = null;
  let fallbackOnly = true;
  const lines = md.split("\n");
  for (const line of lines) {
    const key = TITLE_TO_KEY.get(line.trim().replace(/^##\s*/, ""));
    if (key) {
      current = key;
      fallbackOnly = false;
      continue;
    }
    const target = current ?? "work";
    sections[target] =
      sections[target] === "" ? line : `${sections[target]}\n${line}`;
  }
  if (fallbackOnly && sections.work !== "") {
    return { ...EMPTY_SECTIONS, work: md.trim() };
  }
  // 去除各节首尾空行
  for (const { key } of MEMORY_SECTION_DEFS) {
    sections[key] = sections[key].replace(/^\n+|\n+$/g, "");
  }
  return sections;
}

/** 固定节序拼接；空节跳过 */
export function buildMemoryMarkdown(sections: MemorySections): string {
  return MEMORY_SECTION_DEFS.filter(({ key }) => sections[key].trim() !== "")
    .map(({ key, title }) => `## ${title}\n${sections[key].trim()}`)
    .join("\n\n");
}

/** 超限从头部截断（尾部为最新内容） */
export function truncateMemoryMarkdown(
  md: string,
  limit: number = MEMORY_PROFILE_LIMIT,
): string {
  return md.length > limit ? md.slice(md.length - limit) : md;
}

/** 近期动态节内排序：有日期条目倒序在前，无日期行沉底保序 */
export function sortRecentEntries(text: string): string {
  if (text.trim() === "") {
    return "";
  }
  const lines = text.split("\n");
  const dated = lines
    .filter((l) => /^\[\d{4}-\d{2}-\d{2}\]/.test(l.trim()))
    .sort((a, b) => b.localeCompare(a));
  const undated = lines.filter((l) => !/^\[\d{4}-\d{2}-\d{2}\]/.test(l.trim()));
  return [...dated, ...undated].join("\n");
}

/** 导入合并（spec §6.4）：三节文本追加、近期动态合并重排 */
export function mergeMemoryMarkdown(current: string, incoming: string): string {
  const cur = parseMemoryMarkdown(current);
  const inc = parseMemoryMarkdown(incoming);
  const appendText = (a: string, b: string): string =>
    [a.trim(), b.trim()].filter((s) => s !== "").join("\n");
  return truncateMemoryMarkdown(
    buildMemoryMarkdown({
      work: appendText(cur.work, inc.work),
      personal: appendText(cur.personal, inc.personal),
      current: appendText(cur.current, inc.current),
      recent: sortRecentEntries(appendText(cur.recent, inc.recent)),
    }),
  );
}
