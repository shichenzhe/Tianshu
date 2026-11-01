/**
 * library_search 工具单测（2026-11-01 审查余项⑨）：纯 Node 工具，
 * vitest 直测（widget/read-skill 先例）；prisma 经 vi.mock 替身。
 */
import { describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: { libraryItem: { findMany } },
}));

import {
  LIBRARY_SEARCH_EMPTY,
  LIBRARY_SEARCH_TOOL_NAME,
  makeLibrarySearchTool,
} from "../../electron/domains/ai/agent/library-search-tool";

const ctx = () => ({ workspacePath: "/tmp/ws", sessionId: 1, userId: 7 });

describe("makeLibrarySearchTool", () => {
  it("命中输出条目行（id/名称/类型/大小/日期），查询形态与 UI search 同款", async () => {
    findMany.mockResolvedValueOnce([
      {
        id: 3,
        name: "H6发版说明.md",
        mimeType: "text/markdown",
        size: 8192,
        updatedAt: new Date("2026-10-30T00:00:00Z"),
      },
      {
        id: 5,
        name: "notes.txt",
        mimeType: null,
        size: null,
        updatedAt: new Date("2026-10-29T00:00:00Z"),
      },
    ]);
    const out = await makeLibrarySearchTool().execute(ctx(), {
      keyword: "说明",
    });
    expect(out).toContain("命中 2 条");
    expect(out).toContain("条目 #3｜H6发版说明.md");
    expect(out).toContain("text/markdown");
    expect(out).toContain("条目 #5｜notes.txt");
    expect(findMany).toHaveBeenCalledWith({
      where: { kind: "file", name: { contains: "说明" }, userId: 7 },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });
  });

  it("无命中/空关键词返回空文案（不炸不伪造）", async () => {
    findMany.mockResolvedValueOnce([]);
    const tool = makeLibrarySearchTool();
    expect(await tool.execute(ctx(), { keyword: "不存在" })).toBe(
      LIBRARY_SEARCH_EMPTY,
    );
    expect(await tool.execute(ctx(), { keyword: "   " })).toBe(
      LIBRARY_SEARCH_EMPTY,
    );
  });

  it("keyword 截 100 防超长 LIKE；limit 透传 take；kind=read", async () => {
    findMany.mockResolvedValueOnce([]);
    const tool = makeLibrarySearchTool();
    await tool.execute(ctx(), { keyword: "x".repeat(300), limit: 3 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          name: { contains: "x".repeat(100) },
        }),
        take: 3,
      }),
    );
    expect(tool.kind).toBe("read");
    expect(tool.name).toBe(LIBRARY_SEARCH_TOOL_NAME);
  });
});
