// electron/domains/ai/orchestration/db-client.ts
/**
 * 数据库查询（database 节点后端）：五种引擎统一 (sql, params) →
 * { rows?, rowCount }。驱动全部懒加载（空载工作流不付启动成本）：
 * SQLite 用 better-sqlite3（同库依赖，限工作空间内文件）；C/S 四家
 * pg / mysql2 / oracledb(thin) / mssql。params 参数化防注入（SQL 内
 * ? / $1 / :name 按各家驱动原样透传）。ETL 补强：maxRows 可配去硬
 * 截断（输出字节上限联动）；batchRows 非空时批量模式——事务包裹逐行
 * 绑定，任一行失败整体回滚，输出总 affectedRows。
 */
import path from "node:path";
import Database from "better-sqlite3";
import type { NodeContext } from "./graph-executor";

export type DbEngine = "sqlite" | "postgres" | "mysql" | "oracle" | "sqlserver";

export interface DbQueryParams {
  engine: DbEngine;
  sqlitePath: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sql: string;
  params: string[];
  /** SELECT 行数上限（输出字节联动）；批量模式忽略 */
  maxRows: number;
  /** 批量模式行集（每项一维参数数组）；空数组/null 走单语句 */
  batchRows: string[][] | null;
  ctx: NodeContext;
}

export interface DbQueryResult {
  /** SELECT 命中行（数组）；写操作无 rows */
  rows?: Array<Record<string, unknown>>;
  /** 写操作影响行数（批量模式为各行之和） */
  rowCount?: number;
}

export class DbError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

const MIN_BYTES = 256 * 1024;
const BYTES_PER_ROW = 512;

/** 输出字节上限：maxRows 联动（每行预留 512B，下限 256KB） */
function bytesBudget(maxRows: number): number {
  return Math.max(MIN_BYTES, maxRows * BYTES_PER_ROW);
}

/** 结果序列化：rows 紧凑 JSON（字节截断附总量）；写操作回执 */
export function formatDbResult(result: DbQueryResult, maxRows: number): string {
  if (result.rows !== undefined) {
    if (result.rows.length > maxRows) {
      return JSON.stringify({
        truncated: true,
        total: result.rows.length,
        rows: result.rows.slice(0, maxRows),
        hint: `超过 maxRows=${maxRows}，行集已截断（SQL 内 LIMIT/OFFSET 分页取全量）`,
      });
    }
    const budget = bytesBudget(maxRows);
    const json = JSON.stringify(result.rows);
    if (Buffer.byteLength(json, "utf-8") > budget) {
      return `${json.slice(0, budget)}…（已按字节截断）`;
    }
    return json;
  }
  return JSON.stringify({ affectedRows: result.rowCount ?? 0 });
}

/** 统一入口：批量模式走事务逐行；单语句按引擎分发 */
export async function runDatabaseQuery(
  params: DbQueryParams,
): Promise<DbQueryResult> {
  if (params.batchRows && params.batchRows.length > 0) {
    return runBatch(params);
  }
  const result =
    params.engine === "sqlite"
      ? await querySqlite(params)
      : await queryClientServer(params);
  return result;
}

/** 批量模式：同一 SQL 逐行绑定，事务包裹，失败回滚并报错 */
async function runBatch(params: DbQueryParams): Promise<DbQueryResult> {
  if (params.engine === "sqlite") {
    const db = openSqlite(params);
    try {
      const run = db.transaction((rows: string[][]) => {
        const stmt = db.prepare(params.sql);
        let affected = 0;
        for (const row of rows) {
          affected += stmt.run(...row).changes;
        }
        return affected;
      });
      return { rowCount: run(params.batchRows!) };
    } catch (e) {
      throw wrapDbError(e);
    } finally {
      db.close();
    }
  }
  return batchClientServer(params);
}

async function batchClientServer(
  params: DbQueryParams,
): Promise<DbQueryResult> {
  let affected = 0;
  // 各引擎事务循环（连接生命周期与单查询一致，失败统一回滚后抛出）
  switch (params.engine) {
    case "postgres": {
      const { Client } = await import("pg");
      const client = new Client(pgConfig(params));
      await client.connect();
      try {
        await client.query("BEGIN");
        for (const row of params.batchRows!) {
          const r = await client.query(params.sql, row);
          affected += r.rowCount ?? 0;
        }
        await client.query("COMMIT");
        return { rowCount: affected };
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw wrapDbError(e);
      } finally {
        await client.end();
      }
    }
    case "mysql": {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.createConnection(mysqlConfig(params));
      try {
        await conn.beginTransaction();
        for (const row of params.batchRows!) {
          const [r] = await conn.query(params.sql, row);
          if (!Array.isArray(r)) {
            affected += r.affectedRows;
          }
        }
        await conn.commit();
        return { rowCount: affected };
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw wrapDbError(e);
      } finally {
        await conn.end();
      }
    }
    case "oracle": {
      const oracledb = await import("oracledb");
      const conn = await oracledb.getConnection(oracleConfig(params));
      try {
        for (const row of params.batchRows!) {
          const r = await conn.execute(params.sql, row);
          affected += r.rowsAffected ?? 0;
        }
        await conn.commit();
        return { rowCount: affected };
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw wrapDbError(e);
      } finally {
        await conn.close();
      }
    }
    case "sqlserver": {
      const mssql = await import("mssql");
      const pool = new mssql.ConnectionPool(mssqlConfig(params));
      await pool.connect();
      try {
        const request = pool.request();
        await request.batch("BEGIN TRANSACTION");
        for (const row of params.batchRows!) {
          // mssql request 状态复用会累积 input；逐请求保持干净
          const r = await pool
            .request()
            .query(interpolateSqlserver(params.sql, row));
          if (!r.recordset) {
            affected += r.rowsAffected?.[0] ?? 0;
          }
        }
        await request.batch("COMMIT");
        return { rowCount: affected };
      } catch (e) {
        await pool
          .request()
          .batch("ROLLBACK")
          .catch(() => {});
        throw wrapDbError(e);
      } finally {
        await pool.close();
      }
    }
    default:
      throw new DbError("db_query_failed", `未知引擎: ${params.engine}`);
  }
}

/** sqlserver request.query 不接收参数数组——批量行经参数化值内联（值仅
 * string；转义单引号防破碎，数值形态保持裸值） */
function interpolateSqlserver(sql: string, row: string[]): string {
  return sql.replace(/\?/g, () => {
    const value = row.shift();
    if (value === undefined) {
      throw new DbError("db_query_failed", "批量参数与 ? 占位数量不符");
    }
    return /^-?\d+(\.\d+)?$/.test(value)
      ? value
      : `'${value.replace(/'/g, "''")}'`;
  });
}

function pgConfig(params: DbQueryParams) {
  return {
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    connectionTimeoutMillis: 15_000,
    query_timeout: 120_000,
  };
}
function mysqlConfig(params: DbQueryParams) {
  return {
    host: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    connectTimeout: 15_000,
  };
}
function oracleConfig(params: DbQueryParams) {
  return {
    user: params.username,
    password: params.password,
    connectString: `${params.host}:${params.port}/${params.database}`,
  };
}
function mssqlConfig(params: DbQueryParams) {
  return {
    server: params.host,
    port: params.port,
    database: params.database,
    user: params.username,
    password: params.password,
    options: { encrypt: false, trustServerCertificate: true },
    connectionTimeout: 15_000,
    requestTimeout: 120_000,
  };
}

function wrapDbError(e: unknown): DbError {
  if (e instanceof DbError) {
    return e;
  }
  const message = e instanceof Error ? e.message : String(e);
  return new DbError(
    message.match(/connect|ECONNREFUSED|ENOTFOUND|timeout|login/i)
      ? "db_connect_failed"
      : "db_query_failed",
    message,
  );
}

function openSqlite(params: DbQueryParams): Database.Database {
  const ws = params.ctx.workspacePath;
  if (!ws) {
    throw new DbError(
      "db_workspace_missing",
      "SQLite 须在绑定了目录的工作空间下执行",
    );
  }
  const resolved = path.resolve(ws, params.sqlitePath);
  const inside = resolved === ws || resolved.startsWith(`${ws}${path.sep}`);
  if (!inside) {
    throw new DbError(
      "db_outside_workspace",
      `SQLite 文件路径越界: ${params.sqlitePath}`,
    );
  }
  try {
    return new Database(resolved);
  } catch (e) {
    throw new DbError(
      "db_connect_failed",
      `打开 SQLite 失败: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** SQLite：限工作空间内文件（复用执行器授权边界语义）；SELECT 经
 * iterate 流式取行至 maxRows+1（+1 为超限哨兵行，formatDbResult 据此出
 * 截断标注）——大表不全量驻留内存 */
async function querySqlite(params: DbQueryParams): Promise<DbQueryResult> {
  const db = openSqlite(params);
  try {
    const stmt = db.prepare(params.sql);
    if (stmt.reader) {
      const rows: Array<Record<string, unknown>> = [];
      for (const row of stmt.iterate(...params.params)) {
        rows.push(row as Record<string, unknown>);
        if (rows.length > params.maxRows) {
          break;
        }
      }
      return { rows };
    }
    const info = stmt.run(...params.params);
    return { rowCount: info.changes };
  } catch (e) {
    throw wrapDbError(e);
  } finally {
    db.close();
  }
}

/** C/S 四家单语句：各家驱动懒加载 + 统一适配 */
async function queryClientServer(
  params: DbQueryParams,
): Promise<DbQueryResult> {
  try {
    switch (params.engine) {
      case "postgres":
        return await queryPostgres(params);
      case "mysql":
        return await queryMysql(params);
      case "oracle":
        return await queryOracle(params);
      case "sqlserver":
        return await querySqlserver(params);
      default:
        throw new DbError("db_query_failed", `未知引擎: ${params.engine}`);
    }
  } catch (e) {
    throw wrapDbError(e);
  }
}

async function queryPostgres(params: DbQueryParams): Promise<DbQueryResult> {
  const { Client } = await import("pg");
  const client = new Client(pgConfig(params));
  await client.connect();
  try {
    const result = await client.query(params.sql, params.params);
    if (result.command === "SELECT" || result.rows.length > 0) {
      return { rows: result.rows as Array<Record<string, unknown>> };
    }
    return { rowCount: result.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

async function queryMysql(params: DbQueryParams): Promise<DbQueryResult> {
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(mysqlConfig(params));
  try {
    const [result] = await conn.query(params.sql, params.params);
    if (Array.isArray(result)) {
      return { rows: result as Array<Record<string, unknown>> };
    }
    return { rowCount: result.affectedRows };
  } finally {
    await conn.end();
  }
}

async function queryOracle(params: DbQueryParams): Promise<DbQueryResult> {
  const oracledb = await import("oracledb");
  const conn = await oracledb.getConnection(oracleConfig(params));
  try {
    const result = await conn.execute(params.sql, params.params, {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    if (result.rows && Array.isArray(result.rows)) {
      return { rows: result.rows as Array<Record<string, unknown>> };
    }
    return { rowCount: result.rowsAffected ?? 0 };
  } finally {
    await conn.close();
  }
}

async function querySqlserver(params: DbQueryParams): Promise<DbQueryResult> {
  const mssql = await import("mssql");
  const pool = new mssql.ConnectionPool(mssqlConfig(params));
  await pool.connect();
  try {
    // mssql 的 request.query 不支持位置参数（@name 形态）——params 非空时与批量同款内联
    const sql =
      params.params.length > 0
        ? interpolateSqlserver(params.sql, params.params)
        : params.sql;
    const request = pool.request();
    const result = await request.query(sql);
    if (result.recordset && result.recordset.length > 0) {
      return { rows: result.recordset as Array<Record<string, unknown>> };
    }
    if (result.recordset) {
      return { rows: [] };
    }
    return { rowCount: result.rowsAffected?.[0] ?? 0 };
  } finally {
    await pool.close();
  }
}
