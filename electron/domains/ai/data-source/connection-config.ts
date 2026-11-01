/**
 * 数据源连接配置构造（纯函数，repo 连通测试与图执行器 dataSourceId 解析
 * 共用）：元库行 → pg Client 构造参数。ssl 布尔开（rejectUnauthorized
 * false——内网/云 PG 自签证书场景的务实缺省，注释备案）；纯 Node 零
 * electron 依赖，vitest 直测。
 */

/** 元库 dataSourceConfig 行的最小投影（executor 侧同构消费） */
export interface DataSourceConfigLike {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string | null;
  ssl: boolean | null;
}

/** 首版引擎收口：仅 postgres（后续扩展按 engine 分流） */
export function isPgEngine(engine: string): boolean {
  return engine === "postgres";
}

export interface PgClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 开启时的宽松 TLS（自签证书可连） */
  ssl?: { rejectUnauthorized: false };
  connectionTimeoutMillis: number;
}

/** 元库行 → pg Client 构造参数（超时可覆盖，连通测试用短超时） */
export function toPgClientConfig(
  cfg: DataSourceConfigLike,
  timeoutMs: number = 15_000,
): PgClientConfig {
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.username,
    password: cfg.password ?? "",
    ...(cfg.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: timeoutMs,
  };
}
