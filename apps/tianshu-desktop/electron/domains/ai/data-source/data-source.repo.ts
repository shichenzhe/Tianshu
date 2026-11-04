/**
 * 数据源配置仓储 + IPC（PG 首选通道，切片 B 2026-10-29）：元库
 * dataSourceConfig 行的 CRUD 与连通性测试。凭据面：password 只写不读
 * （回执一律 hasPassword 布尔，聊天上下文/图定义永不接触明文——图侧仅
 * 存 dataSourceId，执行层解析）；连通测试 pg Client SELECT 1 短超时。
 */
import { handleUser } from "../../../commons/ipc-user";
import prisma from "../../../commons/prisma-client";
import { sealSecret, openSecret } from "../../security/secret-field";
import { isPgEngine, toPgClientConfig } from "./connection-config";
import type {
  DataSourceCreateParams,
  DataSourceRecord,
  DataSourceTestResult,
  DataSourceUpdateParams,
} from "../../../../src-react/domains/ai/api/data-source.api";

type DataSourceRow = NonNullable<
  Awaited<ReturnType<typeof prisma.dataSourceConfig.findFirst>>
>;

/** 连通测试超时（短超时快速反馈，点击即测） */
const TEST_TIMEOUT_MS = 5_000;

/** 首版引擎白名单：收口在 postgres，其他值拒绝（后续扩展按 engine 分流） */
function assertParamsEngine(): "postgres" {
  return "postgres";
}

export class DataSourceRepository {
  constructor() {
    this.registerIpcHandlers();
  }

  private toRecord(row: DataSourceRow): DataSourceRecord {
    return {
      id: row.id,
      name: row.name,
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      ssl: row.ssl,
      hasPassword: row.password !== null && row.password !== "",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private registerIpcHandlers() {
    handleUser("dataSource:list", (_, userId) => this.list(userId));
    handleUser("dataSource:create", (_, userId, p: DataSourceCreateParams) =>
      this.create(p, userId),
    );
    handleUser("dataSource:update", (_, userId, p: DataSourceUpdateParams) =>
      this.update(p, userId),
    );
    handleUser("dataSource:delete", (_, userId, id: number) =>
      this.delete(id, userId),
    );
    handleUser("dataSource:test", (_, userId, id: number) =>
      this.test(id, userId),
    );
  }

  /** 归属校验（不存在与他人所有同报错，不泄露存在性——provider 口径） */
  private async getOwnedRow(
    id: number,
    userId: number,
  ): Promise<DataSourceRow> {
    const row = await prisma.dataSourceConfig.findFirst({
      where: { id, userId },
    });
    if (!row) {
      throw new Error("DATA_SOURCE_NOT_FOUND");
    }
    return row;
  }

  /** 参数校验（必填非空 + 端口区间），异常中文文案前端 toast 直显 */
  private validate(p: DataSourceCreateParams): void {
    const fields: Array<[keyof DataSourceCreateParams, string]> = [
      ["name", "名称不能为空"],
      ["host", "主机不能为空"],
      ["database", "数据库不能为空"],
      ["username", "用户名不能为空"],
    ];
    for (const [key, message] of fields) {
      if (typeof p[key] !== "string" || (p[key] as string).trim() === "") {
        throw new Error(message);
      }
    }
    if (
      p.port !== undefined &&
      (!Number.isInteger(p.port) || p.port < 1 || p.port > 65_535)
    ) {
      throw new Error("端口须为 1-65535 的整数");
    }
    if (!isPgEngine(assertParamsEngine())) {
      throw new Error("不支持的引擎");
    }
  }

  async list(userId: number): Promise<DataSourceRecord[]> {
    return (
      await prisma.dataSourceConfig.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      })
    ).map((row) => this.toRecord(row));
  }

  async create(
    p: DataSourceCreateParams,
    userId: number,
  ): Promise<DataSourceRecord> {
    this.validate(p);
    const row = await prisma.dataSourceConfig.create({
      data: {
        name: p.name.trim(),
        engine: "postgres",
        host: p.host.trim(),
        port: p.port ?? 5432,
        database: p.database.trim(),
        username: p.username.trim(),
        // 安全批 E1：密码密封落库（读侧只判存在性，无需解密）
        password: p.password?.trim()
          ? await sealSecret("dataSource.password", p.password)
          : null,
        ssl: p.ssl ?? false,
        userId,
      },
    });
    return this.toRecord(row);
  }

  async update(
    p: DataSourceUpdateParams,
    userId: number,
  ): Promise<DataSourceRecord> {
    await this.getOwnedRow(p.id, userId);
    const row = await prisma.dataSourceConfig.update({
      where: { id: p.id },
      data: {
        ...(p.name !== undefined ? { name: p.name.trim() } : {}),
        ...(p.host !== undefined ? { host: p.host.trim() } : {}),
        ...(p.port !== undefined ? { port: p.port } : {}),
        ...(p.database !== undefined ? { database: p.database.trim() } : {}),
        ...(p.username !== undefined ? { username: p.username.trim() } : {}),
        ...(p.password !== undefined
          ? {
              // 安全批 E1：同 create 密封；清空路径 null 透传
              password: p.password?.trim()
                ? await sealSecret("dataSource.password", p.password)
                : p.password ?? null,
            }
          : {}),
        ...(p.ssl !== undefined ? { ssl: p.ssl } : {}),
      },
    });
    return this.toRecord(row);
  }

  async delete(id: number, userId: number): Promise<void> {
    await this.getOwnedRow(id, userId);
    await prisma.dataSourceConfig.delete({ where: { id } });
  }

  /**
   * 连通性测试：pg Client 建连 + SELECT 1，短超时快速反馈。本机/打包态
   * 均用已装 pg 驱动（dependencies + vite external 互锁，见构建配置）；
   * 失败原样回传（连接拒绝/超时/认证失败），前端 toast 直显
   */
  async test(id: number, userId: number): Promise<DataSourceTestResult> {
    const row = await this.getOwnedRow(id, userId);
    if (!isPgEngine(row.engine)) {
      return { success: false, error: `不支持的引擎: ${row.engine}` };
    }
    const { Client } = await import("pg");
    const startedAt = Date.now();
    // 安全批 E1：连通性测试读侧透明解密
    const client = new Client(
      toPgClientConfig(
        { ...row, password: await openSecret("dataSource.password", row.password) },
        TEST_TIMEOUT_MS,
      ),
    );
    try {
      await client.connect();
      await client.query("SELECT 1");
      return { success: true, latencyMs: Date.now() - startedAt };
    } catch (e) {
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    } finally {
      await client.end().catch(() => {});
    }
  }
}

export default DataSourceRepository;
