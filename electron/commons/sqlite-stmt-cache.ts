/**
 * better-sqlite3 statement 缓存补丁（防原生崩溃）
 *
 * 根因（2026-09 实锤，参照 UNITRONIX/BetterDesk#377、tobi/qmd#827）：
 * Electron 44 内嵌 Node 24 代运行时上，better-sqlite3 的 Statement GC finalizer
 * 与 cleanup-hook 注册表 teardown 存在竞态——大量 statement 依赖 GC 回收时触发
 * `Statement::~Statement → RemoveEnvironmentCleanupHook (env) != nullptr` 断言
 * 崩溃（SIGABRT）。@prisma/adapter-better-sqlite3 每次查询 prepare(sql) 后不保留
 * 引用（statement 全部交予 GC），正中此竞态。
 *
 * 修复：按 SQL 缓存 statement 复用（不进 GC → finalizer 竞态在数学上不可达）。
 * 已验证：Electron 完整模式压测（异步循环 + fetch 并发），未缓存 <1k 次即崩，
 * 缓存版 5 分钟零断言。上游修复（better-sqlite3 13.x 线）落地后可移除本补丁。
 */
// better-sqlite3 自带类型缺失（项目不直接依赖其类型；运行时经 external 原生加载）
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const Database: any = require("better-sqlite3");

type PreparedStatement = {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

const cacheByDb = new WeakMap<object, Map<string, PreparedStatement>>();
const originalPrepare = Database.prototype.prepare;

Database.prototype.prepare = function patchedPrepare(
  this: object,
  sql: string,
  ...options: unknown[]
): PreparedStatement {
  // 带 options 的调用不缓存（本项目内无此用法，透传保真）
  if (options.length > 0) {
    return originalPrepare.apply(this, [sql, ...options]);
  }
  let cache = cacheByDb.get(this);
  if (!cache) {
    cache = new Map<string, PreparedStatement>();
    cacheByDb.set(this, cache);
  }
  const cached = cache.get(sql);
  if (cached) {
    return cached;
  }
  const stmt = originalPrepare.call(this, sql) as PreparedStatement;
  cache.set(sql, stmt);
  return stmt;
};
