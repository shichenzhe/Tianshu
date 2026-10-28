/**
 * 资料库前端纯函数（单测覆盖）：列表排序（folder 恒置前）与类型筛选、
 * 预览分级判定（spec 裁定 6——html/pdf/audio/video 走 webview，md/
 * text/code/image 内联，其余 Finder）、file:// URL 逐段编码、容量格式化。
 */
import type { LibraryItem } from "../api/library.api";
import type { ArtifactListItem } from "../../api/artifact.api";

export type SortField = "name" | "activity";

/** 排序：文件夹恒置前，同类按字段升降序（名称本地化比较） */
export function sortItems(
  items: LibraryItem[],
  field: SortField,
  order: "asc" | "desc",
): LibraryItem[] {
  const factor = order === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "folder" ? -1 : 1;
    }
    if (field === "name") {
      return a.name.localeCompare(b.name) * factor;
    }
    return activityTimeOf(a).localeCompare(activityTimeOf(b)) * factor;
  });
}

/** 类型筛选：命中 fileType 的文件 + 文件夹恒保留；"all" 原样返回 */
export function filterByType(
  items: LibraryItem[],
  fileType: string | "all",
): LibraryItem[] {
  if (fileType === "all") {
    return items;
  }
  return items.filter(
    (item) => item.kind === "folder" || item.fileType === fileType,
  );
}

export type PreviewMode =
  | "inline-md"
  | "inline-csv"
  | "inline-image"
  | "inline-text"
  | "webview"
  | "finder";

/** 预览分级：markdown → md 渲染；csv 扩展（fileType=spreadsheet）→ 表格，
 *  其余 spreadsheet（xls/xlsx 二进制）走 Finder */
export function previewModeOf(
  item: Pick<LibraryItem, "fileType" | "name">,
): PreviewMode {
  const ext = item.name.slice(item.name.lastIndexOf(".") + 1).toLowerCase();
  switch (item.fileType) {
    case "html":
    case "pdf":
    case "audio":
    case "video":
      return "webview";
    case "image":
      return "inline-image";
    case "markdown":
      return "inline-md";
    case "text":
    case "code":
      return "inline-text";
    case "spreadsheet":
      return ext === "csv" ? "inline-csv" : "finder";
    default:
      return "finder";
  }
}

/** CSV 解析（RFC 4180 子集，单测覆盖）：引号字段内逗号/换行/""（转义
 *  引号）保留；\r\n 归一 \n；空文本返回 []；行 = 字段数组 */
export function parseCsv(text: string): string[][] {
  if (text === "") {
    return [];
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // 末尾补一个虚拟 \n 收尾字段/行（简化 EOF 分支）
  const source = `${text}\n`;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  // 结尾连续空行剔除（虚拟 \n 与原文尾随空行——空行 = 单空字段；
  //  中间空行保留，CSV 语义里是真实空记录）
  while (
    rows.length > 0 &&
    rows[rows.length - 1].length === 1 &&
    rows[rows.length - 1][0] === ""
  ) {
    rows.pop();
  }
  return rows;
}

/** CSV 序列化（与 parseCsv 往返）：含逗号/引号/换行的字段引号包裹 +
 *  引号翻倍转义；行以 \n 连接（行尾不加） */
export function serializeCsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const needsQuote = /[",\n\r]/.test(cell);
          return needsQuote ? `"${cell.replaceAll('"', '""')}"` : cell;
        })
        .join(","),
    )
    .join("\n");
}

/** 文件名拆分（行内重命名共用）：扩展名（含点）锁定不可编辑、提交时
 *  原样拼回；首字符点（.gitignore 式）/ 无点 整名为主干 */
export function splitFileName(name: string): { stem: string; ext: string } {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return { stem: name, ext: "" };
  }
  return { stem: name.slice(0, dotIndex), ext: name.slice(dotIndex) };
}

/** 表格编辑器网格化：短行补空字段对齐最长行（矩形）；空/极小输入回落
 *  单格 [[""]]（编辑器保一格可编辑） */
export function toCsvGrid(rows: string[][]): string[][] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0) {
    return [[""]];
  }
  return rows.map((row) => [
    ...row,
    ...new Array<string>(width - row.length).fill(""),
  ]);
}

// fileUrlOf 抽至公共 lib（资料库/产物面板两处预览共用），此处再导出
// 维持既有 import 面稳定
export { fileUrlOf } from "@/lib/file-url";

/** 容量格式化：B/KB/MB/GB（一位小数，≥1 才带小数）；null → "—" */
export function formatSize(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 树形栏嵌套节点（平铺行 → buildFolderTree 组装；file/link 恒叶子） */
export interface FolderTreeNode {
  id: number;
  name: string;
  kind: "folder" | "file" | "link";
  children: FolderTreeNode[];
}

/** 层内排序：folder 恒置前（对齐主区列表 sortItems 口径），同 kind 按名 */
const byNameFolderFirst = (a: FolderTreeNode, b: FolderTreeNode): number => {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
};

/** 平铺条目行 → 嵌套树：file/link 挂父文件夹 children 作叶子；层内
 *  folder 前 file 后各按 name 排序（parent 不在集合的孤儿挂根兜底——
 *  move 防环已保证数据无环，自环防御性跳过） */
export function buildFolderTree(
  rows: Array<Pick<LibraryItem, "id" | "parentId" | "name" | "kind">>,
): FolderTreeNode[] {
  const byId = new Map<number, FolderTreeNode>();
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      name: row.name,
      kind: row.kind,
      children: [],
    });
  }
  const roots: FolderTreeNode[] = [];
  for (const row of rows) {
    const node = byId.get(row.id)!;
    const parent =
      row.parentId !== null && row.parentId !== row.id
        ? byId.get(row.parentId)
        : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortTree = (nodes: FolderTreeNode[]): void => {
    nodes.sort(byNameFolderFirst);
    for (const node of nodes) {
      sortTree(node.children);
    }
  };
  sortTree(roots);
  return roots;
}

/** NEW 判定（spec §3）：file 且从未预览过（lastViewedAt 为 null）；
 *  rename/move 触碰 updatedAt 不影响判定 */
export function isNewItem(
  item: Pick<LibraryItem, "kind" | "lastViewedAt">,
): boolean {
  return item.kind === "file" && item.lastViewedAt === null;
}

/** 「最近访问」列与排序的显示值：lastViewedAt ?? createdAt */
export function activityTimeOf(
  item: Pick<LibraryItem, "lastViewedAt" | "createdAt">,
): string {
  return item.lastViewedAt ?? item.createdAt;
}

/** 位置列显示：空链（根层）显示根名；非空「名 / 名」连接（不打根名前缀） */
export function formatLocation(location: string[], rootLabel: string): string {
  return location.length === 0 ? rootLabel : location.join(" / ");
}

/** 「最近」时间列格式化：zh「2026年9月19日 09:03」/ 其余「Sep 19, 2026 09:03」
 *  （Intl 按用户本地时区渲染，24 小时制） */
export function formatActivityTime(iso: string, locale: string): string {
  const date = new Date(iso);
  const tag = locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
  const dateText = new Intl.DateTimeFormat(tag, {
    year: "numeric",
    month: tag === "zh-CN" ? "long" : "short",
    day: "numeric",
  }).format(date);
  const timeText = new Intl.DateTimeFormat(tag, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  return `${dateText} ${timeText}`;
}

/** 资料库主区视图路由（spec §5）：「最近」快捷入口 or 文件夹层（null=根）；
 *  artifacts=本地产物（跨会话 write_file 聚合，自带列表+预览） */
export type LibraryViewRoute =
  | { type: "recent" }
  | { type: "folder"; id: number | null }
  | { type: "artifacts" };

/** 本地产物会话组（任务）：组内文件保持传入序（后端已按写入时间降序） */
export interface ArtifactSessionGroup {
  sessionId: number;
  title: string;
  files: ArtifactListItem[];
}

/** 本地产物工作空间组：sessions 按组内最新写入时间降序 */
export interface ArtifactWorkspaceGroup {
  workspaceId: number;
  name: string;
  sessions: ArtifactSessionGroup[];
}

const groupTime = (group: { files: ArtifactListItem[] }): string =>
  group.files[0]?.writtenAt ?? "";

/**
 * 本地产物树分组（spec §2.1 树状分层参考）：关键字（命中文件名/任务标题/
 * 工作空间名任一）与类型双过滤 → 工作空间→会话两级分组；空组整枝剔除，
 * 会话/工作空间均按组内最新写入时间降序
 */
export function groupArtifacts(
  items: ArtifactListItem[],
  filter: {
    keyword: string;
    fileType: string | "all";
    favoriteOnly?: boolean;
  },
): ArtifactWorkspaceGroup[] {
  const keyword = filter.keyword.trim().toLowerCase();
  const matched = items.filter((item) => {
    if (filter.fileType !== "all" && item.fileType !== filter.fileType) {
      return false;
    }
    if (filter.favoriteOnly && !item.favorite) {
      return false;
    }
    if (!keyword) return true;
    return (
      item.name.toLowerCase().includes(keyword) ||
      item.sessionTitle.toLowerCase().includes(keyword) ||
      item.workspaceName.toLowerCase().includes(keyword)
    );
  });
  // 双层 Map 建组（保持首个出现序，排序随后统一做）
  const byWorkspace = new Map<number, ArtifactWorkspaceGroup>();
  for (const file of matched) {
    let wsGroup = byWorkspace.get(file.workspaceId);
    if (!wsGroup) {
      wsGroup = {
        workspaceId: file.workspaceId,
        name: file.workspaceName,
        sessions: [],
      };
      byWorkspace.set(file.workspaceId, wsGroup);
    }
    let session = wsGroup.sessions.find((s) => s.sessionId === file.sessionId);
    if (!session) {
      session = {
        sessionId: file.sessionId,
        title: file.sessionTitle,
        files: [],
      };
      wsGroup.sessions.push(session);
    }
    session.files.push(file);
  }
  const groups = [...byWorkspace.values()];
  for (const ws of groups) {
    ws.sessions.sort((a, b) => groupTime(b).localeCompare(groupTime(a)));
  }
  return groups.sort((a, b) =>
    groupTime(b.sessions[0] ?? { files: [] }).localeCompare(
      groupTime(a.sessions[0] ?? { files: [] }),
    ),
  );
}

/** 本地产物表头排序三态（PRD §4.4）：default→asc→desc→default 循环 */
export type ArtifactSortState =
  "default" | "nameAsc" | "nameDesc" | "timeAsc" | "timeDesc";

/** 三态循环表：同字段推进下一态，换字段重置到该字段升序 */
const ARTIFACT_SORT_NEXT: Record<
  "name" | "time",
  Record<ArtifactSortState, ArtifactSortState>
> = {
  name: {
    default: "nameAsc",
    nameAsc: "nameDesc",
    nameDesc: "default",
    timeAsc: "nameAsc",
    timeDesc: "nameAsc",
  },
  time: {
    default: "timeAsc",
    timeAsc: "timeDesc",
    timeDesc: "default",
    nameAsc: "timeAsc",
    nameDesc: "timeAsc",
  },
};

/** 表头点击推进排序态（name/time 字段分派） */
export function nextArtifactSort(
  current: ArtifactSortState,
  field: "name" | "time",
): ArtifactSortState {
  return ARTIFACT_SORT_NEXT[field][current];
}

/** 组内文件行排序（default 保持 groupArtifacts 现序）；返回新数组不 mutate */
export function sortArtifactFiles(
  files: ArtifactListItem[],
  state: ArtifactSortState,
): ArtifactListItem[] {
  const byName = (a: ArtifactListItem, b: ArtifactListItem) =>
    a.name.localeCompare(b.name);
  const byTime = (a: ArtifactListItem, b: ArtifactListItem) =>
    a.writtenAt.localeCompare(b.writtenAt);
  switch (state) {
    case "nameAsc":
      return [...files].sort(byName);
    case "nameDesc":
      return [...files].sort((a, b) => byName(b, a));
    case "timeAsc":
      return [...files].sort(byTime);
    case "timeDesc":
      return [...files].sort((a, b) => byTime(b, a));
    default:
      return [...files];
  }
}
