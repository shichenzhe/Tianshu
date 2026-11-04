/**
 * 会话级文件路径授权清单（spec 2026-10-14 §6.4；T28 多用户隔离 spec
 * §16 项 2）：文件窗口 library tab 发起 AI 对话时注册条目 storagePath，
 * 使 AI 工具可直改数据根内文件。
 * 双层放行之一：file-gate（makeFileDecider 第 3 参 grantedOf）读放行
 * "default"、file-tools resolveSafePath（extraAllowed）越界放行；write 审批
 * 横幅仍由 write kind:"write" 走，授权不绕过。
 * 多用户隔离（T28）：查询/落盘均带 userId 维度（option 唯一键
 * type+name+userId，每用户一行 findFirst({type,name,userId})），内存缓存
 * 按 userId 分桶——两用户授权互不可见。会话 userId 为 null（v12 前旧行）
 * 走独立内存空桶不入库：授权注册经 grant IPC 归属校验（findFirst 带
 * userId），此类会话本就无授权可存。旧版单行（userId NULL）数据不迁移：
 * 会话级授权短生命周期，重启后随 library tab 会话重开重新注册。
 * 同步性：gate 判定是同步闭包而清单异步加载——模块级缓存，grant/revoke
 * 原地同步更新（gate/工具闭包即时可见）+ 异步落盘 option 表（同
 * option-store 手法：upsert 走 updateMany 命中 0 行则 create 两步）；落盘
 * 失败仅记日志不影响内存态。
 * 生命周期：grant 时注册（fileWindow:grantFilePath handler）；revoke 时机
 * = 窗口关 library tab / 会话删除（session.repo deleteSession/
 * deleteWorkspace + project.repo deleteProject 级联删除接线，尽力而为，
 * spec 允许懒清理）。
 * 授权语义为精确文件路径匹配（两条链路一致），不做目录前缀展开。
 */
import prisma from "../../../commons/prisma-client";
import Log from "../../../commons/Log";
import { realPathLenient } from "../agent/file-tools";

const OPTION_TYPE = "fileWindow";
const OPTION_NAME = "grantedPaths";
/** 授权清单 option 落盘键（诊断/文档口径：type.name） */
export const GRANTED_PATHS_OPTION_KEY = `${OPTION_TYPE}.${OPTION_NAME}`;

type GrantedStore = Record<string, string[]>;

/** 每用户桶：cache 内存态、loadPromise 懒加载去重（失败也只尝试一次）、
 *  loadFailed 落盘跳过标记（空缓存不得覆盖已持久化快照）、loaded 就位
 *  标记（未加载时同步查询视为无授权，fail-safe） */
interface UserBucket {
  cache: GrantedStore;
  loadPromise: Promise<GrantedStore> | null;
  loadFailed: boolean;
  loaded: boolean;
}

/** 模块级同步缓存（按 userId 分桶）：String(null)="null" 与数字 id 键
 *  天然不冲突；null userId 桶恒 loaded（内存空桶，不入库不落盘） */
const buckets = new Map<string, UserBucket>();

function bucketOf(userId: number | null): UserBucket {
  const key = String(userId);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      cache: {},
      loadPromise: null,
      loadFailed: false,
      loaded: userId === null,
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** 行值 → 清单：畸形 JSON/非预期形状回退空对象，非字符串条目剔除 */
function parseStore(raw: string | null | undefined): GrantedStore {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const store: GrantedStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        store[key] = value.filter(
          (item): item is string => typeof item === "string" && item !== "",
        );
      }
    }
    return store;
  } catch {
    return {};
  }
}

/** 懒加载（每用户进程内一次）：DB 读失败回退空清单（fail-safe——读侧
 *  default 外全拒）。prisma 访问整体入 Promise 链：prisma.option 缺失等
 *  同步抛错也走同一 catch（不外泄 unhandled rejection——测试桩 prisma
 *  局部实现即此形态） */
function load(userId: number | null): Promise<GrantedStore> {
  const bucket = bucketOf(userId);
  if (bucket.loaded) return Promise.resolve(bucket.cache);
  if (!bucket.loadPromise) {
    bucket.loadPromise = Promise.resolve()
      .then(() =>
        prisma.option.findFirst({
          where: { type: OPTION_TYPE, name: OPTION_NAME, userId },
          select: { value: true },
        }),
      )
      .then((row) => {
        bucket.loaded = true;
        bucket.cache = parseStore(row?.value);
        return bucket.cache;
      })
      .catch((e) => {
        Log.error("授权清单加载失败", e);
        bucket.loaded = true;
        bucket.cache = {};
        bucket.loadFailed = true;
        return bucket.cache;
      });
  }
  return bucket.loadPromise;
}

/**
 * 落盘（每用户一行）：缓存已由调用方原地更新，此处序列化写 option 表；
 * 失败仅日志（内存态为准，重启后回退上次成功落盘的快照）。加载失败
 * （loadFailed）时跳过——防止空缓存把已持久化快照洗掉；null userId
 * 桶不入库（见文件头注释）
 */
async function persist(userId: number | null): Promise<void> {
  const bucket = bucketOf(userId);
  if (userId === null || !bucket.loaded || bucket.loadFailed) return;
  const value = JSON.stringify(bucket.cache);
  try {
    const result = await prisma.option.updateMany({
      where: { type: OPTION_TYPE, name: OPTION_NAME, userId },
      data: { value },
    });
    if (result.count === 0) {
      await prisma.option.create({
        data: { type: OPTION_TYPE, name: OPTION_NAME, userId, value },
      });
    }
  } catch (e) {
    Log.error("授权清单持久化失败", e);
  }
}

/**
 * 注册授权（fileWindow:grantFilePath handler 调用）：缓存原地同步更新，
 * 落盘失败不影响内存态；重复注册幂等
 */
export async function grantFilePath(
  sessionId: number,
  absPath: string,
  userId: number,
): Promise<null> {
  const store = await load(userId);
  const key = String(sessionId);
  const list = store[key] ?? (store[key] = []);
  if (!list.includes(absPath)) list.push(absPath);
  await persist(userId);
  return null;
}

/** 会话授权清单（异步：首次调用触发该用户懒加载，恢复 DB 态） */
export async function grantedPathsOf(
  sessionId: number,
  userId: number | null,
): Promise<string[]> {
  const store = await load(userId);
  return [...(store[String(sessionId)] ?? [])];
}

/** 会话授权回收（窗口关 library tab / 会话删除，尽力而为） */
export async function revokeSession(
  sessionId: number,
  userId: number | null,
): Promise<null> {
  const store = await load(userId);
  const key = String(sessionId);
  if (!(key in store)) return null;
  delete store[key];
  await persist(userId);
  return null;
}

/** 会话授权清单同步读（未加载=空，fail-safe）：ChatService 工具 ctx 闭包用 */
export function grantedSyncOf(
  sessionId: number,
  userId: number | null,
): string[] {
  const bucket = bucketOf(userId);
  return bucket.loaded ? [...(bucket.cache[String(sessionId)] ?? [])] : [];
}

/**
 * 全量扁平集（跨会话、跨用户）同步读：file-gate grantedOf 判定用——
 * gate 单例签名无用户维度，取并集；gate 仅做「黑名单放宽」（返回
 * "default" 不阻断），真正的访问控制在 resolveSafePath 的每会话清单
 * （sessionId 全局唯一，跨用户不可撞），并集至多让他人授权的路径文字
 * 不被内置敏感清单拦截，不构成跨用户数据访问。条目与其 realpath 归一
 * 形态都入集
 */
export function grantedSetSync(): Set<string> {
  const set = new Set<string>();
  for (const bucket of buckets.values()) {
    if (!bucket.loaded) continue;
    for (const list of Object.values(bucket.cache)) {
      for (const entry of list) {
        set.add(entry);
        set.add(realPathLenient(entry));
      }
    }
  }
  return set;
}

/**
 * gate 同步判定：查询路径文字形态与 realpath 归一形态任一命中
 * （授权登记与工具 resolve 的路径文字形态不一致时兜底）
 */
export function isPathGrantedSync(absPath: string): boolean {
  const set = grantedSetSync();
  return set.has(absPath) || set.has(realPathLenient(absPath));
}
