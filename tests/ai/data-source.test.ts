// tests/ai/data-source.test.ts
/**
 * 数据源配置（PG 首选通道，切片 B）单测：
 * - connection-config：pg Client 构造（ssl 开关/密码空兜底/超时覆盖）
 * - datasource-resolver：dataSourceId 解析三分支（无引用 null / 查无行
 *   datasource_missing / 引擎白名单）与元库行 → 连接配置
 * - DataSourceRepository：CRUD 与 userId 隔离（mock prisma，先例
 *   graph-repo.test.ts 三件套）、password 只写不读（回执 hasPassword）、
 *   连通测试（pg Client mock）
 * - graph schema：databaseNodeSchema 增量可选 dataSourceId（旧图零影响）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    dataSourceConfig: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { DataSourceRepository } from "../../electron/domains/ai/data-source/data-source.repo";
import prisma from "../../electron/commons/prisma-client";
import {
  toPgClientConfig,
  type DataSourceConfigLike,
} from "../../electron/domains/ai/data-source/connection-config";
import {
  resolveDataSource,
  toResolvedDataSource,
} from "../../electron/domains/ai/orchestration/datasource-resolver";
import { validateGraph } from "../../src-react/domains/ai/orchestration/api/graph.schema";

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  name: "主库",
  engine: "postgres",
  host: "127.0.0.1",
  port: 5432,
  database: "app",
  username: "postgres",
  password: "secret",
  ssl: false,
  createdAt: new Date("2026-10-29T08:00:00Z"),
  updatedAt: new Date("2026-10-29T08:00:00Z"),
  userId: 7,
  ...over,
});

const delegate = prisma.dataSourceConfig as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("connection-config（pg 连接构造）", () => {
  const base: DataSourceConfigLike = {
    engine: "postgres",
    host: "h",
    port: 5433,
    database: "d",
    username: "u",
    password: "p",
    ssl: false,
  };

  it("ssl 关：无 ssl 键；ssl 开：宽松 TLS（rejectUnauthorized false）", () => {
    const off = toPgClientConfig(base);
    expect(off).not.toHaveProperty("ssl");
    const on = toPgClientConfig({ ...base, ssl: true });
    expect(on.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("password null 兜底空串；超时可覆盖", () => {
    const cfg = toPgClientConfig({ ...base, password: null }, 5_000);
    expect(cfg.password).toBe("");
    expect(cfg.connectionTimeoutMillis).toBe(5_000);
  });
});

describe("datasource-resolver（dataSourceId 解析）", () => {
  it("无引用（undefined）→ null，节点走裸配置零行为变化", async () => {
    expect(
      await resolveDataSource({
        dataSourceId: undefined,
        userId: 7,
        lookup: vi.fn(),
      }),
    ).toBeNull();
  });

  it("查无行/归属不符 → datasource_missing 判别失败", async () => {
    const lookup = vi.fn(async () => null);
    const result = await resolveDataSource({
      dataSourceId: 9,
      userId: 7,
      lookup,
    });
    expect(result).toEqual({
      ok: false,
      code: "datasource_missing",
      message: expect.stringContaining("9"),
    });
    // lookup 按 (id, userId) 查——userId 隔离语义
    expect(lookup).toHaveBeenCalledWith(9, 7);
  });

  it("引擎白名单：非 postgres 判别失败；postgres 行 → 连接配置（ssl null 兜底 false）", () => {
    expect(toResolvedDataSource(row({ engine: "mysql" })).ok).toBe(false);
    const result = toResolvedDataSource(row({ ssl: null, password: null }));
    expect(result).toEqual({
      ok: true,
      config: {
        engine: "postgres",
        host: "127.0.0.1",
        port: 5432,
        database: "app",
        username: "postgres",
        password: "",
        ssl: false,
      },
    });
  });
});

describe("DataSourceRepository（CRUD 与隔离）", () => {
  const repo = new DataSourceRepository();

  it("list 按用户过滤且回执不含 password（hasPassword 布尔代替）", async () => {
    delegate.findMany.mockResolvedValue([
      row({ id: 1, password: "secret" }),
      row({ id: 2, password: null, name: "空密码" }),
    ]);
    const records = await repo.list(7);
    expect(delegate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 7 } }),
    );
    expect(records[0]).not.toHaveProperty("password");
    expect(records[0].hasPassword).toBe(true);
    expect(records[1].hasPassword).toBe(false);
  });

  it("create 校验：名称空/端口越界中文拒绝；合法载荷 engine 固定 postgres、端口缺省 5432、空密码落 null", async () => {
    await expect(
      repo.create({ name: " ", host: "h", database: "d", username: "u" }, 7),
    ).rejects.toThrow("名称不能为空");
    await expect(
      repo.create(
        { name: "n", host: "h", port: 0, database: "d", username: "u" },
        7,
      ),
    ).rejects.toThrow("端口");
    delegate.create.mockResolvedValue(row());
    await repo.create(
      { name: "n", host: "h", database: "d", username: "u" },
      7,
    );
    expect(delegate.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        engine: "postgres",
        port: 5432,
        password: null,
        userId: 7,
      }),
    });
  });

  it("update：归属校验先于写（他人行 DATA_SOURCE_NOT_FOUND）；password undefined 不上送、null 清空", async () => {
    delegate.findFirst.mockResolvedValue(null);
    await expect(repo.update({ id: 1, name: "x" }, 7)).rejects.toThrow(
      "DATA_SOURCE_NOT_FOUND",
    );
    delegate.findFirst.mockResolvedValue(row());
    delegate.update.mockResolvedValue(row());
    await repo.update({ id: 1, name: "x" }, 7);
    expect(delegate.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: "x" },
    });
    await repo.update({ id: 1, password: null }, 7);
    expect(delegate.update).toHaveBeenLastCalledWith({
      where: { id: 1 },
      data: { password: null },
    });
  });

  it("delete：归属校验 + 按主键删", async () => {
    delegate.findFirst.mockResolvedValue(row());
    await repo.delete(1, 7);
    expect(delegate.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("test：非 postgres 引擎结构化拒绝", async () => {
    delegate.findFirst.mockResolvedValue(row({ engine: "mysql" }));
    const result = await repo.test(1, 7);
    expect(result.success).toBe(false);
    expect(result.error).toContain("mysql");
  });
});

describe("graph schema：databaseNodeSchema.dataSourceId（增量可选）", () => {
  const dbNode = (extra: Record<string, unknown>) => ({
    id: "db",
    name: "查询",
    kind: "database",
    engine: "postgres",
    sql: "SELECT 1",
    ...extra,
  });
  const graphOf = (node: Record<string, unknown>) => ({
    version: 1,
    inputSchema: {},
    nodes: [{ id: "start", name: "开始", kind: "start", variables: [] }, node],
    edges: [
      { from: "start", to: "db" },
      { from: "db", to: "END" },
    ],
  });

  it("带 dataSourceId 过校验（zod 落入节点对象）；不带同样过（旧图零影响）", () => {
    const withRef = validateGraph(graphOf(dbNode({ dataSourceId: 3 })));
    expect(withRef.ok).toBe(true);
    if (withRef.ok) {
      const node = withRef.value.nodes[1];
      expect(node.kind === "database" && node.dataSourceId).toBe(3);
    }
    const legacy = validateGraph(graphOf(dbNode({})));
    expect(legacy.ok).toBe(true);
    if (legacy.ok) {
      const node = legacy.value.nodes[1];
      expect(node.kind === "database" && node.dataSourceId).toBeUndefined();
    }
  });

  it("dataSourceId 非正整数拒绝", () => {
    expect(validateGraph(graphOf(dbNode({ dataSourceId: 0 }))).ok).toBe(false);
    expect(validateGraph(graphOf(dbNode({ dataSourceId: -1 }))).ok).toBe(false);
  });
});
