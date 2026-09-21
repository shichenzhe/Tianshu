import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs/promises";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  // userData 与 library-files.test.ts 错开：两文件 ID 寻址目录均为
  // library/{id} 且各自 nextId 从 1 起，vitest 并行跑同路径会互相删/改盘
  app: { getPath: vi.fn(() => "/tmp/tianshu-test-user-data-repo") },
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
              if (
                value !== null &&
                typeof value === "object" &&
                "not" in (value as Record<string, unknown>)
              ) {
                return row[key] !== (value as { not: unknown }).not;
              }
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
      findFirst: vi.fn(
        async ({ where }: { where?: Record<string, unknown> } = {}) =>
          table.find((row) =>
            Object.entries(where ?? {}).every(
              ([key, value]) => row[key] === value,
            ),
          ) ?? null,
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
          favorite: false,
          lastViewedAt: null,
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

/** 测试用户 id（v12 起资料库按用户隔离，repo 方法末位参数） */
const UID = 1;

beforeEach(() => {
  table.length = 0;
  nextId = 1;
});

describe("LibraryRepository 元数据通道", () => {
  it("createFolder 重名自动序号；list 返回面包屑与 folder 置前", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("工作", null, UID);
    const f2 = await repo.createFolder("工作", null, UID);
    expect(f2.name).toBe("工作 (2)");
    const file = await repo.createFolder("a.md", f1.id, UID);
    Object.assign(
      table.find((r) => r.id === file.id)!,
      {
        kind: "file",
        fileType: "text",
      },
    );
    const { items, breadcrumbs } = await repo.list(f1.id, UID);
    expect(items.map((i: { name: string }) => i.name)).toEqual(["a.md"]);
    expect(breadcrumbs.map((b: { id: number }) => b.id)).toEqual([f1.id]);
    const root = await repo.list(null, UID);
    expect(root.items[0].kind).toBe("folder");
  });

  it("move 移入自身子树被拒", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    const f2 = await repo.createFolder("B", f1.id, UID);
    await expect(repo.move([f1.id], f2.id, UID)).rejects.toThrow();
  });

  it("revealItem 对 folder 防御性拒绝（纯 DB 无磁盘实体）", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    await expect(repo.revealItem(f1.id, UID)).rejects.toThrow("无实体");
  });

  it("delete 级联删除子树记录", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    await repo.createFolder("B", f1.id, UID);
    await repo.delete([f1.id], UID);
    expect(table).toHaveLength(0);
  });

  it("createFolder 校验上级存在且为文件夹", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    const file = await repo.createFolder("伪文件", f1.id, UID);
    Object.assign(
      table.find((r) => r.id === file.id)!,
      { kind: "file" },
    );
    await expect(repo.createFolder("B", 999, UID)).rejects.toThrow(
      "条目不存在",
    );
    await expect(repo.createFolder("B", file.id, UID)).rejects.toThrow(
      "上级必须是文件夹",
    );
  });

  it("subtreeCount 统计全部后代（不含自身）；无子为 0", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    const f2 = await repo.createFolder("B", f1.id, UID);
    await repo.createFolder("C", f2.id, UID);
    const f4 = await repo.createFolder("E", null, UID);
    expect(await repo.subtreeCount(f1.id, UID)).toBe(2);
    expect(await repo.subtreeCount(f2.id, UID)).toBe(1);
    expect(await repo.subtreeCount(f4.id, UID)).toBe(0);
    await expect(repo.subtreeCount(999, UID)).rejects.toThrow("条目不存在");
  });

  it("tree 返回全量 folder 平铺（含层级 id，不含 file）", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("A", null, UID);
    await repo.createFolder("B", f1.id, UID);
    const file = await repo.createFolder("伪文件", f1.id, UID);
    Object.assign(
      table.find((r) => r.id === file.id)!,
      { kind: "file" },
    );
    const tree = await repo.tree(UID);
    expect(tree).toHaveLength(2);
    expect(tree.find((n) => n.id === f1.id)?.parentId).toBeNull();
    expect(tree.find((n) => n.name === "B")?.parentId).toBe(f1.id);
    expect(tree.some((n) => n.id === file.id)).toBe(false);
  });
});

describe("收藏 / 最近访问 / 位置链", () => {
  // addFiles 走真实 fs（源文件须存在，拷入 mock 的 userData 目录）
  const SRC_A = "/tmp/a.txt";
  const SRC_B = "/tmp/b.txt";

  beforeEach(async () => {
    table.length = 0;
    nextId = 1;
    await fs.writeFile(SRC_A, "a");
    await fs.writeFile(SRC_B, "b");
  });

  it("toggleFavorite 切换并返回最新项", async () => {
    const repo = new LibraryRepository();
    const file = await repo.addFiles([SRC_A], null, UID);
    const on = await repo.toggleFavorite(file.added[0].id, UID);
    expect(on.favorite).toBe(true);
    const off = await repo.toggleFavorite(file.added[0].id, UID);
    expect(off.favorite).toBe(false);
  });

  it("markViewed 置 lastViewedAt（ISO 字符串）", async () => {
    const repo = new LibraryRepository();
    const file = await repo.addFiles([SRC_A], null, UID);
    const viewed = await repo.markViewed(file.added[0].id, UID);
    expect(typeof viewed.lastViewedAt).toBe("string");
    expect(new Date(viewed.lastViewedAt).getTime()).toBeGreaterThan(0);
  });

  it("listRecent 仅已访问 file，按 lastViewedAt 倒序", async () => {
    const repo = new LibraryRepository();
    const folder = await repo.createFolder("F", null, UID);
    const a = await repo.addFiles([SRC_A], null, UID);
    const b = await repo.addFiles([SRC_B], folder.id, UID);
    await repo.markViewed(a.added[0].id, UID);
    await new Promise((r) => setTimeout(r, 5));
    await repo.markViewed(b.added[0].id, UID);
    const recent = await repo.listRecent(UID);
    expect(recent.map((i) => i.name)).toEqual(["b.txt", "a.txt"]);
    expect(recent.every((i) => i.kind === "file")).toBe(true);
  });

  it("listFavorites 仅收藏 file", async () => {
    const repo = new LibraryRepository();
    const a = await repo.addFiles([SRC_A], null, UID);
    await repo.createFolder("F", null, UID);
    await repo.toggleFavorite(a.added[0].id, UID);
    const favorites = await repo.listFavorites(UID);
    expect(favorites).toHaveLength(1);
    expect(favorites[0].name).toBe("a.txt");
  });

  it("search 项含 location 祖代名序列（根→父）", async () => {
    const repo = new LibraryRepository();
    const f1 = await repo.createFolder("F1", null, UID);
    const f2 = await repo.createFolder("F2", f1.id, UID);
    await repo.addFiles([SRC_A], f2.id, UID);
    const results = await repo.search("a", UID);
    expect(results[0].location).toEqual(["F1", "F2"]);
    // 根层文件 location 为空数组
    await repo.addFiles([SRC_B], null, UID);
    const rootResults = await repo.search("b", UID);
    expect(rootResults[0].location).toEqual([]);
  });
});
