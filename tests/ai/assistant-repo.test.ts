/**
 * assistant.repo 单测：新字段透传(tags JSON 序列化/description/sourceSlug)、
 * 去播种回归、builtin 删除限制回归。IPC/DB 副作用 mock 三件套隔离
 * （同 automation-repo.test.ts）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock("../../electron/commons/Log", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    assistant: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

import { AssistantRepository } from "../../electron/domains/ai/chat/assistant.repo";
import prisma from "../../electron/commons/prisma-client";

const UID = 1;
const repo = new AssistantRepository();

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  name: "通用助手",
  icon: "🤖",
  systemPrompt: "prompt",
  temperature: null,
  topP: null,
  maxTokens: null,
  builtin: false,
  description: null,
  tags: null,
  sourceSlug: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  userId: UID,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list（去播种回归）", () => {
  it("空用户不再播种，直接返回空数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    const result = await repo.list(UID);
    expect(result).toEqual([]);
    expect(prisma.assistant.count).not.toHaveBeenCalled();
  });

  it("toRecord 解析 tags JSON 字符串为数组", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: '["a","b"]' }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual(["a", "b"]);
  });

  it("toRecord 对坏 JSON tags 回退空数组不抛错", async () => {
    (prisma.assistant.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      row({ tags: "{broken" }),
    ]);
    const result = await repo.list(UID);
    expect(result[0].tags).toEqual([]);
  });
});

describe("create（新字段透传）", () => {
  it("tags 序列化为 JSON 字符串，description/sourceSlug 落库", async () => {
    (prisma.assistant.create as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    );
    await repo.create(
      {
        name: "通用助手",
        systemPrompt: "prompt",
        description: "d",
        tags: ["x"],
        sourceSlug: "general",
      },
      UID,
    );
    expect(prisma.assistant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        description: "d",
        tags: '["x"]',
        sourceSlug: "general",
      }),
    });
  });
});

describe("update（可空清空语义）", () => {
  it("tags null 清空、undefined 不出现在 data", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    (prisma.assistant.update as ReturnType<typeof vi.fn>).mockResolvedValue(
      row(),
    );
    await repo.update({ id: 1, name: "n", tags: null }, UID);
    const data = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[0][0].data;
    expect(data.tags).toBeNull();
    await repo.update({ id: 1, description: "new" }, UID);
    const data2 = (prisma.assistant.update as ReturnType<typeof vi.fn>).mock
      .calls[1][0].data;
    expect("tags" in data2).toBe(false);
    expect(data2.description).toBe("new");
  });
});

describe("delete（builtin 限制回归）", () => {
  it("builtin 行拒绝删除", async () => {
    (prisma.assistant.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
      row({ builtin: true }),
    );
    await expect(repo.delete(1, UID)).rejects.toThrow("ASSISTANT_BUILTIN");
    expect(prisma.assistant.delete).not.toHaveBeenCalled();
  });
});
