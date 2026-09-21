/**
 * 资料库纯函数（模块级导出，单测覆盖；asset.repo 同源口径的资料库版）：
 * 名称清洗/同层重名序号（DB 口径，非磁盘口径）、子树收集与祖先判定
 * （删除级联与移动循环防护共用）、面包屑上溯、扩展名分类与 mime 映射、
 * 列表基准序（folder 置前）、ID 寻址目录拼装。
 */
import path from "node:path";

/** 名称非法字符：Windows 保留符号 + 控制字符（\p{Cc} 覆盖 C0/C1/DEL） */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]/gu;

/** 名称长度上限：文件系统普遍 255 字符内，留 " (2)" 重名序号余量 */
export const LIBRARY_NAME_MAX = 200;

/** 超长截断（保留扩展名；扩展名自身超限则整名硬截） */
function truncateName(name: string): string {
  if (name.length <= LIBRARY_NAME_MAX) {
    return name;
  }
  const ext = path.extname(name);
  const stemBudget = LIBRARY_NAME_MAX - ext.length;
  return stemBudget > 0
    ? name.slice(0, stemBudget) + ext
    : name.slice(0, LIBRARY_NAME_MAX);
}

/** 名称清洗：剥离非法字符与首尾空白/点号、超长截断；清洗后为空抛错 */
export function sanitizeLibraryName(name: string): string {
  const cleaned = truncateName(
    name
      .replace(ILLEGAL_NAME_CHARS, "")
      .replace(/^[\s.]+/, "")
      .replace(/[\s.]+$/, ""),
  );
  if (!cleaned) {
    throw new Error("名称无效");
  }
  return cleaned;
}

/** 同层重名探测（DB 名集合口径）：占用则 " (2)"、" (3)"…，扩展名保留 */
export function uniqueDbName(
  existingNames: ReadonlySet<string>,
  name: string,
): string {
  if (!existingNames.has(name)) {
    return name;
  }
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 2; ; index++) {
    const candidate = `${stem} (${index})${ext}`;
    if (!existingNames.has(candidate)) {
      return candidate;
    }
  }
}

/** 子树/面包屑共用的最小行结构 */
export interface ItemRow {
  id: number;
  parentId: number | null;
  name: string;
  kind: "folder" | "file";
}

/** 收集 rootIds（含自身）在 rows 中的全部后代 id */
export function collectSubtreeIds(
  rows: readonly ItemRow[],
  rootIds: readonly number[],
): number[] {
  const childrenOf = new Map<number | null, number[]>();
  for (const row of rows) {
    const list = childrenOf.get(row.parentId) ?? [];
    list.push(row.id);
    childrenOf.set(row.parentId, list);
  }
  const result: number[] = [];
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    result.push(id);
    queue.push(...(childrenOf.get(id) ?? []));
  }
  return result;
}

/** candidateId 是否为 ancestorId 自身或其后代（移动循环防护） */
export function isDescendantOrSelf(
  rows: readonly ItemRow[],
  ancestorId: number,
  candidateId: number,
): boolean {
  return collectSubtreeIds(rows, [ancestorId]).includes(candidateId);
}

/** 面包屑链（根→叶）；断链/成环时返回已上溯收集的部分（层深兜底 100） */
export function buildBreadcrumbChain(
  rows: readonly ItemRow[],
  leafId: number,
): ItemRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const chain: ItemRow[] = [];
  let current = byId.get(leafId);
  while (current && chain.length < 100) {
    chain.unshift(current);
    current =
      current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/** 扩展名 → 简化分类（spec §3，预览分级与类型筛选共用） */
const FILE_TYPE_BY_EXT: Record<string, string> = {
  html: "html",
  htm: "html",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  flac: "audio",
  aac: "audio",
  mp4: "video",
  mov: "video",
  avi: "video",
  mkv: "video",
  webm: "video",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  json: "code",
  py: "code",
  java: "code",
  c: "code",
  cpp: "code",
  h: "code",
  go: "code",
  rs: "code",
  rb: "code",
  php: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  sql: "code",
  css: "code",
  scss: "code",
  yaml: "code",
  yml: "code",
  xml: "code",
  txt: "text",
  md: "text",
  markdown: "text",
  log: "text",
  csv: "text",
  rtf: "text",
  doc: "document",
  docx: "document",
  xls: "document",
  xlsx: "document",
  ppt: "document",
  pptx: "document",
  pages: "document",
  numbers: "document",
  key: "document",
  wps: "document",
  et: "document",
  dps: "document",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  bz2: "archive",
  dmg: "archive",
  iso: "archive",
};

export type LibraryFileType = keyof typeof FILE_TYPE_BY_EXT | "other";

/** 扩展名小写分类；未命中归 other */
export function classifyFileType(fileName: string): string {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return FILE_TYPE_BY_EXT[ext] ?? "other";
}

/** 常用 mime 映射（未命中 null——mimeType 尽力而为字段） */
const MIME_BY_EXT: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
  webm: "video/webm",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  log: "text/plain",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
};

export function mimeOf(fileName: string): string | null {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

/** 列表基准序：文件夹在前、同类按名升序（UI 可再重排） */
export function compareLibraryItems(
  a: { kind: string; name: string },
  b: { kind: string; name: string },
): number {
  if (a.kind !== b.kind) {
    return a.kind === "folder" ? -1 : 1;
  }
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** ID 寻址目录：{libraryRoot}/{itemId}（文件本体与原文件名同放） */
export function storageDirOf(libraryRoot: string, itemId: number): string {
  return path.join(libraryRoot, String(itemId));
}
