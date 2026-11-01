/**
 * 数据源引用解析（database 节点 dataSourceId → 元库连接配置，切片 B
 * 2026-10-29）：桌面单份（不入 drift 双份基线——server 侧无元库面）。
 * 查询经注入 lookup（executor 传 prisma 闭包、单测传 stub）；归属按图
 * userId（历史图 null → 0 永不命中，datasource_missing 兜底）。失败以
 * 判别结果返回（不 import executor 的 GraphNodeFailure——调用侧转换，
 * 零环依赖）；纯 Node 零 electron 依赖，vitest 直测。
 */
import { isPgEngine } from "../data-source/connection-config";

/** 元库行投影（prisma findFirst 返回行的子集，stub 友好） */
export interface DataSourceRowLike {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string | null;
  ssl: boolean | null;
}

export type DataSourceLookup = (
  id: number,
  userId: number,
) => Promise<DataSourceRowLike | null>;

/** 解析出的连接配置（engine 随配置走，首版 postgres） */
export interface ResolvedDataSource {
  engine: "postgres";
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

export type ResolveDataSourceResult =
  | { ok: true; config: ResolvedDataSource }
  | { ok: false; code: string; message: string };

/** 元库行 → 连接配置（engine 白名单校验；行存在性由 lookup 语义保证） */
export function toResolvedDataSource(
  row: DataSourceRowLike,
): ResolveDataSourceResult {
  if (!isPgEngine(row.engine)) {
    return {
      ok: false,
      code: "datasource_unsupported_engine",
      message: `数据源引擎暂不支持: ${row.engine}（首版仅 postgres）`,
    };
  }
  return {
    ok: true,
    config: {
      engine: "postgres",
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: row.password ?? "",
      ssl: row.ssl ?? false,
    },
  };
}

/**
 * dataSourceId 解析：undefined → null（节点走裸配置，零行为变化）；
 * 查无行/无权 → datasource_missing；引擎不支持 → 判别失败
 */
export async function resolveDataSource(params: {
  dataSourceId: number | undefined;
  userId: number;
  lookup: DataSourceLookup;
}): Promise<ResolveDataSourceResult | null> {
  const { dataSourceId, userId, lookup } = params;
  if (dataSourceId === undefined) {
    return null;
  }
  const row = await lookup(dataSourceId, userId);
  if (!row) {
    return {
      ok: false,
      code: "datasource_missing",
      message: `数据源不存在或无权访问: id=${dataSourceId}`,
    };
  }
  return toResolvedDataSource(row);
}
