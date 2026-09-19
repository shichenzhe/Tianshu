import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data") },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));

// library.repo 引入 Log（→ winston + electron，asset-repo.test 先例直接 mock）
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

// 内存表：findMany(where.parentId === null 不匹配的用 null 语义对齐
const table: Array<Record<string, unknown> & { id: number }> = [];
let nextId = 1;

vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    libraryItem: {
      findMany: vi.fn(
        async ({ where }: { where?: Record<string, unknown> } = {}) =>
          table.filter((row) =>
            Object.entries(where ?? {}).every(([key, value]) => {
              if (key === "parentId") {
                return row.parentId === value;
              }
              if (key === "id" && typeof value === "object" && value) {
                const op = value as { in: number[] };
                return op.in.includes(row.id);
              }
              if (key === "name" && typeof value === "object" && value) {
                return row.name.includes(
                  (value as { contains: string }).contains,
                );
              }
              return row[key] === value;
            }),
          ),
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: number } }) =>
          table.find((row) => row.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: nextId++,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        table.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: number };
          data: Record<string, unknown>;
        }) => {
          const row = table.find((r) => r.id === where.id);
          if (!row) {
            throw new Error("not found");
          }
          Object.assign(row, data);
          return row;
        },
      ),
      deleteMany: vi.fn(
        async ({ where }: { where: { id: { in: number[] } } }) => {
          const ids = new Set(where.id.in);
          for (let i = table.length - 1; i >= 0; i -= 1) {
            if (ids.has(table[i].id)) {
              table.splice(i, 1);
            }
          }
          return { count: where.id.in.length };
        },
      ),
    },
  },
}));

import LibraryRepository from "../../electron/domains/ai/library/library.repo";

beforeEach(() => {
  table.length = 0;
  nextId = 1;
});

describe("LibraryRepository 元数据通道", () => {
  it("createFolder 重名自动序号；list 返回面包屑与 folder 置前", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("工作", null);
    const f2 = await repo.createFolder("工作", null);
    expect(f2.name).toBe("工作 (2)");
    const file = await repo.createFolder("a.md", f1.id);
    Object.assign(
      table.find((r) => r.id === file.id)!,
      {
        kind: "file",
        fileType: "text",
      },
    );
    const { items, breadcrumbs } = await repo.list(f1.id);
    expect(items.map((i: { name: string }) => i.name)).toEqual(["a.md"]);
    expect(breadcrumbs.map((b: { id: number }) => b.id)).toEqual([f1.id]);
    const root = await repo.list(null);
    expect(root.items[0].kind).toBe("folder");
  });

  it("move 移入自身子树被拒", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null);
    const f2 = await repo.createFolder("B", f1.id);
    await expect(repo.move([f1.id], f2.id)).rejects.toThrow();
  });

  it("delete 级联删除子树记录", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null);
    await repo.createFolder("B", f1.id);
    await repo.delete([f1.id]);
    expect(table).toHaveLength(0);
  });

  it("createFolder 校验上级存在且为文件夹", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null);
    const file = await repo.createFolder("伪文件", f1.id);
    Object.assign(
      table.find((r) => r.id === file.id)!,
      { kind: "file" },
    );
    await expect(repo.createFolder("B", 999)).rejects.toThrow("条目不存在");
    await expect(repo.createFolder("B", file.id)).rejects.toThrow(
      "上级必须是文件夹",
    );
  });

  it("subtreeCount 统计全部后代（不含自身）；无子为 0", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null);
    const f2 = await repo.createFolder("B", f1.id);
    await repo.createFolder("C", f2.id);
    const f4 = await repo.createFolder("E", null);
    expect(await repo.subtreeCount(f1.id)).toBe(2);
    expect(await repo.subtreeCount(f2.id)).toBe(1);
    expect(await repo.subtreeCount(f4.id)).toBe(0);
    await expect(repo.subtreeCount(999)).rejects.toThrow("条目不存在");
  });
});
