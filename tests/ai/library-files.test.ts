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

// prisma-client mock 中 create 需把 size 更新为 data.size；本测试主要断言磁盘与返回
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import LibraryRepository from "../../electron/domains/ai/library/library.repo";

beforeEach(() => {
  table.length = 0;
  nextId = 1;
});

describe("LibraryRepository 文件通道", () => {
  it("addFiles 拷贝入库并落 storagePath 目录；重名自动序号", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-src-"));
    const src1 = path.join(srcDir, "笔记.md");
    fs.writeFileSync(src1, "# hello");
    const src2 = path.join(srcDir, "图片.png");
    fs.writeFileSync(src2, "png");

    const repo = new LibraryRepository();
    const result = await repo.addFiles([src1, src2], null);
    expect(result.added).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    // 原名落盘在 {userData}/library/{id}/ 下（userData 被 mock 为
    // /tmp/tianshu-test-user-data）
    for (const item of result.added) {
      expect(fs.existsSync(item.storagePath)).toBe(true);
    }
    // 再次入库同名 → 序号（uniqueDbName 为 Task 2 已定契约：序号插在
    // 扩展名前，"笔记.md" → "笔记 (2).md"——brief 期望串笔误已修正）
    const again = await repo.addFiles([src1], null);
    expect(again.added[0].name).toBe("笔记 (2).md");
  });

  it("addFiles 源缺失进 failed 不阻断批次", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-src2-"));
    const ok = path.join(srcDir, "ok.txt");
    fs.writeFileSync(ok, "x");
    const repo = new LibraryRepository();
    const result = await repo.addFiles([ok, "/nonexistent/a.txt"], null);
    expect(result.added).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
  });

  it("delete 级联清理磁盘目录", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-src3-"));
    const src = path.join(srcDir, "d.txt");
    fs.writeFileSync(src, "x");
    const repo = new LibraryRepository();
    const { added } = await repo.addFiles([src], null);
    const dir = path.dirname(added[0].storagePath as string);
    await repo.delete([added[0].id]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("rename 文件同步磁盘文件名（storagePath 不变量）", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-src4-"));
    const src = path.join(srcDir, "r.txt");
    fs.writeFileSync(src, "data");
    const repo = new LibraryRepository();
    const { added } = await repo.addFiles([src], null);
    const renamed = await repo.rename(added[0].id, "改名后.txt");
    // 磁盘文件名随 DB name 变化，storagePath 始终指向真实文件
    expect(fs.existsSync(renamed.storagePath)).toBe(true);
    expect(fs.readFileSync(renamed.storagePath as string, "utf8")).toBe("data");
    expect(fs.existsSync(added[0].storagePath as string)).toBe(false);
  });

  it("move 撞名文件磁盘双写：同名移入目标层自动序号且 storagePath 落盘", async () => {
    const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "lib-src5-"));
    const src = path.join(srcDir, "同.txt");
    fs.writeFileSync(src, "m");
    const repo = new LibraryRepository();
    const folder = await repo.createFolder("目标", null);
    const { added } = await repo.addFiles([src], null); // 根层
    await repo.addFiles([src], folder.id); // 目标层同名（序号占位）
    const oldPath = added[0].storagePath as string;
    // 根层同名文件移入目标层 → DB 名「同 (2).txt」且磁盘同步改名
    await repo.move([added[0].id], folder.id);
    const { items } = await repo.list(folder.id);
    const moved = items.find((item) => item.id === added[0].id);
    expect(moved?.name).toBe("同 (2).txt");
    expect(fs.existsSync(moved?.storagePath as string)).toBe(true);
    expect(fs.readFileSync(moved?.storagePath as string, "utf8")).toBe("m");
    expect(fs.existsSync(oldPath)).toBe(false);
  });
});
