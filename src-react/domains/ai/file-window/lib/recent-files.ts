/**
 * 最近打开（+ 菜单 Task 15）：localStorage `tianshu-file-window-recent`
 * 存 FileWindowResource[]（去重键 dedupeKeyOf），pushRecent 置顶截尾 10 条。
 * 接线点选在 FileWindowView 的 store 订阅（openTab 成功即新增 tab）——
 * store 不沾 localStorage（状态机纯净，持久化语义归视图层）；快照恢复/
 * deliver 投递同路覆盖，同键者仅置顶不重复。
 * 读取按 shape 过滤（spec §13 项 2 网址 tab 废止）：旧版本残留的 url
 * 条目及其他畸形数据静默丢弃，不再回填进菜单。
 */
import type { FileWindowResource } from "../model/resource";
import { dedupeKeyOf } from "../store/file-window.store";

const KEY = "tianshu-file-window-recent";
const LIMIT = 10;

/** workspace/library 形状守卫：url（已废止）与畸形条目一并排除 */
function isFileResource(r: unknown): r is FileWindowResource {
  if (!r || typeof r !== "object") return false;
  return (
    (r as { kind?: unknown }).kind === "workspace" ||
    (r as { kind?: unknown }).kind === "library"
  );
}

export function recentOf(): FileWindowResource[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(isFileResource) : [];
  } catch {
    // 损坏/不可用（无 localStorage 环境）按空兜底
    return [];
  }
}

export function pushRecent(resource: FileWindowResource): void {
  const key = dedupeKeyOf(resource);
  const next = [
    resource,
    ...recentOf().filter((r) => dedupeKeyOf(r) !== key),
  ].slice(0, LIMIT);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 写入失败（隐私模式等）静默：最近列表尽力而为
  }
}
