/**
 * 外部文件读授权门：file:readExternalFile 的路径校验面。
 * 背景（2026-09-21 审查）：该通道曾任意绝对路径直读，渲染层一旦被
 * XSS 注入即可读取任意本地文件（凭据/密钥）。授权语义 = 「用户显式
 * 给出的文件」三类：
 * 1. 资料库根内（{userData}/library/**，入库即用户授权，对齐
 *    library.repo LIBRARY_ROOT_NAME）；
 * 2. 选择器路径：file:pickLocalFiles 由主进程亲自弹出选择器，返回即登记；
 * 3. 拖拽路径：preload 的 webUtils.getPathForFile 才能从 File 对象解出
 *    路径（XSS 合成的 File 解出空串，无法伪造授权）——preload 解出后经
 *    原生 ipcRenderer.send 登记（通道刻意不进 preload 白名单，渲染层
 *    无法直达授权通道本身）。
 * 授权集内存态（LRU 200 条 + 30 分钟 TTL 惰性过期）：重启即清，
 * 拖拽/选择一次授权当次会话内有效。
 */
import { app } from "electron";
import path from "node:path";

/** 与 library.repo LIBRARY_ROOT_NAME 同源（userData 子目录名） */
const LIBRARY_ROOT_NAME = "library";

const GRANT_LIMIT = 200;
const GRANT_TTL_MS = 30 * 60 * 1000;

/** 授权路径 → 登记时间（Map 保插入序，超限逐最旧淘汰） */
const granted = new Map<string, number>();

/** 资料库存储根（判定「库内路径直通」用） */
export function libraryRootOf(): string {
  return path.join(app.getPath("userData"), LIBRARY_ROOT_NAME);
}

function isInsideLibraryRoot(absPath: string): boolean {
  const root = libraryRootOf();
  const resolved = path.resolve(absPath);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 登记授权（拖拽/选择器路径；空串与重复登记幂等跳过） */
export function grantExternalPath(absPath: string): void {
  const key = absPath.trim();
  if (key === "") {
    return;
  }
  granted.delete(key); // 重置插入序（LRU 触碰语义）
  granted.set(key, Date.now());
  while (granted.size > GRANT_LIMIT) {
    const oldest = granted.keys().next().value as string;
    granted.delete(oldest);
  }
}

export function grantExternalPaths(absPaths: string[]): void {
  for (const p of absPaths) {
    grantExternalPath(p);
  }
}

/** 是否允许读取（库内直通；授权集内未过期放行） */
export function isExternalReadAllowed(absPath: string): boolean {
  if (isInsideLibraryRoot(absPath)) {
    return true;
  }
  const grantedAt = granted.get(absPath.trim());
  if (grantedAt === undefined) {
    return false;
  }
  if (Date.now() - grantedAt > GRANT_TTL_MS) {
    granted.delete(absPath.trim());
    return false;
  }
  return true;
}

/** 测试用：清空授权集 */
export function resetExternalGrants(): void {
  granted.clear();
}
