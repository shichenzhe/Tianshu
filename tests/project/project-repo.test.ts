/**
 * 项目仓储单测：create 重名/欢迎消息/关联写入、remove 级联删除、
 * update 重名与不存在校验、setBindings 全量替换。
 * 依赖经 vi.mock 替换（electron ipcMain / prisma client），沿用
 * personalization-repo.test.ts 的 mock 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
}));

// prisma stub：各测试按需覆写实现（vi.hoisted 使其在 vi.mock 工厂执行前初始化）
const prismaStub = vi.hoisted(() => ({
  project: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectMember: { create: vi.fn(), deleteMany: vi.fn() },
  projectBinding: {
    createMany: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
  },
  session: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    deleteMany: vi.fn(),
  },
  message: { create: vi.fn(), deleteMany: vi.fn() },
  workspace: { findFirst: vi.fn() },
  assistant: { findMany: vi.fn() },
  $transaction: vi.fn((fn) => fn(prismaStub)),
}));

vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import ProjectRepository from "../../electron/domains/project/project.repo";
import {
  PROJECT_NAME_EXISTS,
  PROJECT_NOT_FOUND,
} from "../../electron/domains/project/project.entity";

const repo = new ProjectRepository();

describe("ProjectRepository.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同名项目 → 抛 PROJECT_NAME_EXISTS", async () => {
    prismaStub.project.findFirst.mockResolvedValue({ id: 1 });
    await expect(repo.create({ ownerId: 1, name: "test" })).rejects.toThrow(
      PROJECT_NAME_EXISTS,
    );
    expect(prismaStub.project.create).not.toHaveBeenCalled();
  });

  it("正常创建 → 建 project + owner member + 项目 session + 欢迎消息", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 11 });
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });

    const result = await repo.create({
      ownerId: 1,
      name: "test",
      welcomeMessage: "欢迎",
    });

    expect(prismaStub.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectId: 11, userId: 1, role: "owner" },
      }),
    );
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectId: 11, workspaceId: 7, title: "test" },
      }),
    );
    expect(prismaStub.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sessionId: 21, role: "assistant" }),
      }),
    );
    expect(result.sessionId).toBe(21);
  });

  it("无欢迎消息 → 不写欢迎 message", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 12 });
    prismaStub.session.create.mockResolvedValue({ id: 22, projectId: 12 });
    await repo.create({ ownerId: 1, name: "t2" });
    expect(prismaStub.message.create).not.toHaveBeenCalled();
  });

  it("创建时携带 bindings → 写入挂载", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 11 });
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });
    await repo.create({
      ownerId: 1,
      name: "b",
      bindings: [{ itemType: "assistant", itemId: 3 }],
    });
    expect(prismaStub.projectBinding.createMany).toHaveBeenCalledWith({
      data: [{ projectId: 11, itemType: "assistant", itemId: 3 }],
    });
  });

  it("创建时不带 bindings → 不写挂载", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.workspace.findFirst.mockResolvedValue({ id: 7 });
    prismaStub.project.create.mockResolvedValue({ id: 11 });
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });
    await repo.create({ ownerId: 1, name: "b" });
    expect(prismaStub.projectBinding.createMany).not.toHaveBeenCalled();
  });
});

describe("ProjectRepository.remove", () => {
  it("级联删除 bindings/members/messages/sessions/project", async () => {
    prismaStub.session.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    await repo.remove(11);
    expect(prismaStub.message.deleteMany).toHaveBeenCalledWith({
      where: { sessionId: { in: [21, 22] } },
    });
    expect(prismaStub.session.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
    expect(prismaStub.projectMember.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
    expect(prismaStub.projectBinding.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
    expect(prismaStub.project.delete).toHaveBeenCalledWith({
      where: { id: 11 },
    });
  });
});

describe("ProjectRepository.update", () => {
  it("改名校验同用户重名 → 抛 PROJECT_NAME_EXISTS", async () => {
    prismaStub.project.findUnique.mockResolvedValue({
      id: 1,
      ownerId: 1,
      name: "a",
    });
    prismaStub.project.findFirst.mockResolvedValue({ id: 2 });
    await expect(repo.update({ id: 1, name: "b" })).rejects.toThrow(
      PROJECT_NAME_EXISTS,
    );
  });

  it("项目不存在 → 抛 PROJECT_NOT_FOUND", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    await expect(repo.update({ id: 99, name: "x" })).rejects.toThrow(
      PROJECT_NOT_FOUND,
    );
  });
});

describe("ProjectRepository.setBindings", () => {
  it("全量替换：先清空再批量写入", async () => {
    await repo.setBindings(11, [
      { itemType: "assistant", itemId: 3 },
      { itemType: "skill", itemId: 4 },
    ]);
    expect(prismaStub.projectBinding.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
    expect(prismaStub.projectBinding.createMany).toHaveBeenCalledWith({
      data: [
        { projectId: 11, itemType: "assistant", itemId: 3 },
        { projectId: 11, itemType: "skill", itemId: 4 },
      ],
    });
  });
});
