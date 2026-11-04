/**
 * 文件→会话历史映射（spec §12 项 4，WorkBuddy 会话绑定持久化对齐）：
 * localStorage `tianshu-file-window-session-map` 存 Record<dedupeKey,
 * sessionId[]>（每文件最近 10、新者置顶去重）。recentSessionOf 供无
 * sessionId 的 tab seed 最近会话；pushSession 在 sessionId 从无到有
 * （ensureSession 建成/seed）与新 tab 带入（移窗）时记录；removeSession
 * 摘除已删会话（发送报 SESSION_NOT_FOUND 时清绑定防误用，见
 * use-file-session）。接线点在 FileWindowView 的 store 订阅（recent-files
 * 先例——store 不沾 localStorage）；「新建任务」只解绑不触发 seed/push
 * （旧会话留映射尾部）。sessionResourceIndex 反转映射供主窗会话列表
 * 跳文件窗（spec §19 项 1）。
 */
import type { FileWindowResource } from "../model/resource";
import { dedupeKeyOf } from "../store/file-window.store";

const KEY = "tianshu-file-window-session-map";
const LIMIT = 10;

/** 读取整映射：损坏/非对象 JSON/无 localStorage 一律空映射兜底 */
function mapOf(): Record<string, number[]> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as Record<string, number[]>;
  } catch {
    return {};
  }
}

function saveMap(map: Record<string, number[]>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 写入失败（隐私模式等）静默：映射尽力而为
  }
}

export function recentSessionOf(resource: FileWindowResource): number | null {
  const ids = mapOf()[dedupeKeyOf(resource)];
  return typeof ids?.[0] === "number" ? ids[0] : null;
}

export function pushSession(
  resource: FileWindowResource,
  sessionId: number,
): void {
  const key = dedupeKeyOf(resource);
  const map = mapOf();
  const rest = (Array.isArray(map[key]) ? map[key] : []).filter(
    (x) => typeof x === "number" && x !== sessionId,
  );
  map[key] = [sessionId, ...rest].slice(0, LIMIT);
  saveMap(map);
}

export function removeSession(
  resource: FileWindowResource,
  sessionId: number,
): void {
  const key = dedupeKeyOf(resource);
  const map = mapOf();
  const rest = (Array.isArray(map[key]) ? map[key] : []).filter(
    (x) => typeof x === "number" && x !== sessionId,
  );
  if (rest.length > 0) map[key] = rest;
  else delete map[key];
  saveMap(map);
}

/** dedupeKey → resource 解析（sessionResourceIndex 反转用）：键形如
 *  w:{workspaceId}:{path} / l:{itemId}——path 含冒号时首个分隔符后整体
 *  作 path（与 dedupeKeyOf 生成端对齐）；前缀/数字/path 非法返回 null */
function resourceOfKey(key: string): FileWindowResource | null {
  if (key.startsWith("w:")) {
    const rest = key.slice(2);
    const sep = rest.indexOf(":");
    if (sep <= 0) return null;
    const workspaceId = Number(rest.slice(0, sep));
    const path = rest.slice(sep + 1);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0 || !path) {
      return null;
    }
    return { kind: "workspace", workspaceId, path };
  }
  if (key.startsWith("l:")) {
    const itemId = Number(key.slice(2));
    if (!Number.isInteger(itemId) || itemId <= 0) return null;
    return { kind: "library", itemId };
  }
  return null;
}

/**
 * 反向索引（spec §19 项 1，主窗→文件窗跳转）：sessionId → 其最近所在
 * resource。同一 session 多文件共指（移窗后旧键残留）时后键覆盖——映射
 * 不含时间戳，以 JSON 键序（pushSession 新键居后）作「最近」的确定近似；
 * 损坏条目（键非法、值非数组、id 非正整数）一律跳过。session-map 由文件
 * 窗写入 localStorage，主窗同 partition 可读（构建轻量：一次读+反转）。
 */
export function sessionResourceIndex(): Map<number, FileWindowResource> {
  const index = new Map<number, FileWindowResource>();
  for (const [key, ids] of Object.entries(mapOf())) {
    const resource = resourceOfKey(key);
    if (!resource || !Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id === "number" && Number.isInteger(id) && id > 0) {
        index.set(id, resource);
      }
    }
  }
  return index;
}
