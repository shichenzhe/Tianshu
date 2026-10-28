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
 * 修复：按 SQL 缓存底层 statement 复用；prepare 返回轻量 JS facade 适配
 * adapter 的「bind(args) 后执行」用法（原生 bind() 每个 statement 仅允许一次，
 * 故 facade 记录参数、执行时以临时参数调用）。原生 statement 永不进 GC →
 * finalizer 竞态不可达；facade 为纯 JS 对象，可安全被回收。
 * 上游修复（better-sqlite3 13.x 线）落地后可移除本补丁。
 */
// better-sqlite3 自带类型缺失（项目不直接依赖其类型；运行时经 external 原生加载）
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const Database: any = require("better-sqlite3");

interface NativeStatement {
  run: (...params: unknown[]) => unknown;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  iterate: (...params: unknown[]) => IterableIterator<unknown>;
  columns: () => Array<{ name: string; type: string }>;
  raw: () => {
    run: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  reader: boolean;
}

/** 一次性外观：把「bind 后执行」翻译为「带临时参数执行」 */
class StatementFacade {
  private boundArgs: unknown[] = [];

  constructor(private readonly native: NativeStatement) {}

  bind(args: unknown[]): this {
    this.boundArgs = args;
    return this;
  }

  private params(extra: unknown[]): unknown[] {
    return extra.length > 0 ? extra : this.boundArgs;
  }

  run(...extra: unknown[]): unknown {
    return this.native.run(...this.params(extra));
  }

  get(...extra: unknown[]): unknown {
    return this.native.get(...this.params(extra));
  }

  all(...extra: unknown[]): unknown[] {
    return this.native.all(...this.params(extra));
  }

  iterate(...extra: unknown[]): IterableIterator<unknown> {
    return this.native.iterate(...this.params(extra));
  }

  columns(): Array<{ name: string; type: string }> {
    return this.native.columns();
  }

  raw(): { all: (...extra: unknown[]) => unknown[] } {
    const rawStmt = this.native.raw();
    return {
      all: (...extra: unknown[]) => rawStmt.all(...this.params(extra)),
    };
  }

  get reader(): boolean {
    return this.native.reader;
  }
}

const cacheByDb = new WeakMap<object, Map<string, NativeStatement>>();
const originalPrepare = Database.prototype.prepare;

Database.prototype.prepare = function patchedPrepare(
  this: object,
  sql: string,
  ...options: unknown[]
): StatementFacade {
  // 带 options 的调用不缓存（本项目内无此用法，直接透传原 statement）
  if (options.length > 0) {
    return new StatementFacade(
      originalPrepare.apply(this, [sql, ...options]) as NativeStatement,
    );
  }
  let cache = cacheByDb.get(this);
  if (!cache) {
    cache = new Map<string, NativeStatement>();
    cacheByDb.set(this, cache);
  }
  const cached = cache.get(sql);
  if (cached) {
    return new StatementFacade(cached);
  }
  const stmt = originalPrepare.call(this, sql) as NativeStatement;
  cache.set(sql, stmt);
  return new StatementFacade(stmt);
};
