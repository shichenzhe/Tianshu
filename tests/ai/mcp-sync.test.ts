/**
 * mcpServer:sync diff 回写测试：manager 缺省（undefined）退化为纯 CRUD，
 * 覆盖三分支（增/删/改）、同名参数未变跳过、enabled 保留库值、userId 隔离、
 * 计数返回；openHub 走 shell.openExternal（mock electron）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../electron/commons/ipc-user", () => ({ handleUser: vi.fn() }));
vi.mock("../../electron/commons/Log", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { shell } from "electron";
import { McpRepository } from "../../electron/domains/ai/mcp/mcp.repo";

type Row = {
  id: number;
  userId: number | null;
  name: string;
  transport: string;
  command?: string | null;
  args?: string | null;
  env?: string | null;
  url?: string | null;
  headers?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

const table: Row[] = [];
let nextId = 1;

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    mcpServer: {
      findMany: vi.fn(async ({ where }: { where: { userId: number } }) =>
        table.filter((r) => r.userId === where.userId),
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: number; userId: number } }) =>
          table.find((r) => r.id === where.id && r.userId === where.userId),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: number } }) =>
        table.find((r) => r.id === where.id),
      ),
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        const row: Row = {
          id: nextId++,
          userId: null,
          name: "",
          transport: "stdio",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        } as Row;
        table.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Partial<Row>;
        }) => {
          const row = table.find((r) => r.id === where.id)!;
          Object.assign(row, data, { updatedAt: new Date() });
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: number } }) => {
        const idx = table.findIndex((r) => r.id === where.id);
        return table.splice(idx, 1)[0];
      }),
    },
  },
}));

function seed(partial: Partial<Row>): Row {
  const row: Row = {
    id: nextId++,
    userId: 1,
    name: "demo",
    transport: "stdio",
    command: "npx",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as Row;
  table.push(row);
  return row;
}

async function makeRepo() {
  return new McpRepository(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("../../electron/commons/prisma-client")).default as any,
    undefined,
  );
}

beforeEach(() => {
  table.length = 0;
  nextId = 1;
  vi.clearAllMocks();
});

describe("McpRepository.openHub", () => {
  it("走 shell.openExternal 打开主进程写死的 Hub 地址", async () => {
    const repo = await makeRepo();
    await (repo as unknown as { openHub(): Promise<void> }).openHub();
    expect(shell.openExternal).toHaveBeenCalledWith("https://mcp.so");
  });
});

describe("McpRepository.sync", () => {
  it("新增（JSON 有/库无）→ create 且 enabled 默认 true", async () => {
    const repo = await makeRepo();
    const result = await repo.sync(
      { feishu: { transport: "stdio", command: "npx" } },
      1,
    );
    expect(result).toEqual({ created: 1, updated: 0, deleted: 0 });
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({
      name: "feishu",
      userId: 1,
      enabled: true,
    });
  });

  it("删除（JSON 无/库有）→ delete", async () => {
    seed({ userId: 1, name: "old" });
    const repo = await makeRepo();
    const result = await repo.sync({}, 1);
    expect(result).toEqual({ created: 0, updated: 0, deleted: 1 });
    expect(table).toHaveLength(0);
  });

  it("同名参数变化 → update 且保留库内 enabled=false", async () => {
    seed({
      userId: 1,
      name: "a",
      url: "https://old",
      transport: "http",
      enabled: false,
    });
    const repo = await makeRepo();
    const result = await repo.sync(
      { a: { transport: "http", url: "https://new" } },
      1,
    );
    expect(result).toEqual({ created: 0, updated: 1, deleted: 0 });
    expect(table[0]).toMatchObject({ url: "https://new", enabled: false });
  });

  it("同名参数未变 → 跳过（updated=0）", async () => {
    seed({ userId: 1, name: "a", command: "npx", args: '["--x"]' });
    const repo = await makeRepo();
    const result = await repo.sync(
      { a: { transport: "stdio", command: "npx", args: '["--x"]' } },
      1,
    );
    expect(result).toEqual({ created: 0, updated: 0, deleted: 0 });
  });

  it("混合 diff：只触碰本人行（userId 隔离）", async () => {
    seed({ userId: 2, name: "other" });
    seed({ userId: 1, name: "mine", transport: "stdio", command: "old" });
    const repo = await makeRepo();
    const result = await repo.sync(
      {
        mine: { transport: "stdio", command: "new" },
        fresh: { transport: "http", url: "https://f" },
      },
      1,
    );
    expect(result).toEqual({ created: 1, updated: 1, deleted: 0 });
    expect(table.find((r) => r.name === "other")).toBeTruthy();
    expect(table.find((r) => r.name === "mine")).toMatchObject({
      command: "new",
    });
  });
});
