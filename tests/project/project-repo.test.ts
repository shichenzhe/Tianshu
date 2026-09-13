/**
 * 项目仓储单测：create 重名/资产空间挂接/模型全局继承/欢迎消息/关联写入、
 * remove 级联删除（含资产目录树清理）、update 重名与不存在校验、
 * setBindings 全量替换、getDetail 一期旧项目资产空间自愈（二期 spec §3.2）、
 * listMembers 成员列表（joinedAt 序 + join user 昵称回退，三期子系统 A）。
 * 依赖经 vi.mock 替换（electron ipcMain+app / Log / node:fs/promises /
 * prisma client），沿用 personalization-repo.test.ts 的 mock 模式。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const { USER_DATA, fsStub } = vi.hoisted(() => ({
  USER_DATA: "/tmp/tianshu-test-userdata",
  fsStub: { mkdir: vi.fn(), rm: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => USER_DATA) },
}));
// project.repo 引 commons/Log（Winston，模块加载即建 transport）——mock 掉避免测试写日志
vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// fs stub：mkdir/rm 按 create/remove 生命周期断言（default 键兼容命名空间默认导入）
vi.mock("node:fs/promises", () => ({ default: fsStub, ...fsStub }));

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
  projectMember: { create: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
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
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  message: { create: vi.fn(), deleteMany: vi.fn() },
  workspace: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
  planItem: { deleteMany: vi.fn() },
  assistant: { findMany: vi.fn() },
  skillRecord: { findMany: vi.fn() },
  mcpServer: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
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

/** 期望中的资产目录/项目根目录（与实现 path.join 口径一致） */
const assetsDir = (projectId: number) =>
  path.join(USER_DATA, "projects", String(projectId), "assets");
const projectRootDir = (projectId: number) =>
  path.join(USER_DATA, "projects", String(projectId));

describe("ProjectRepository.create", () => {
  beforeEach(() => vi.clearAllMocks());

  it("同名项目 → 抛 PROJECT_NAME_EXISTS", async () => {
    prismaStub.project.findFirst.mockResolvedValue({ id: 1 });
    await expect(repo.create({ ownerId: 1, name: "test" })).rejects.toThrow(
      PROJECT_NAME_EXISTS,
    );
    expect(prismaStub.project.create).not.toHaveBeenCalled();
  });

  it("全局最近选过模型 → 项目 session 继承该模型（继承查询不限空间）", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.project.create.mockResolvedValue({ id: 11, name: "t2" });
    prismaStub.workspace.create.mockResolvedValue({ id: 30 });
    prismaStub.session.findFirst.mockResolvedValueOnce({ currentModelId: 42 });
    prismaStub.session.create.mockResolvedValue({ id: 22, projectId: 11 });

    await repo.create({ ownerId: 1, name: "t2" });

    expect(prismaStub.session.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaStub.session.findFirst).toHaveBeenCalledWith({
      where: { currentModelId: { not: null } },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      select: { currentModelId: true },
    });
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          projectId: 11,
          workspaceId: 30,
          title: "t2",
          currentModelId: 42,
        },
      }),
    );
  });

  it("全局无选过模型的会话 → 项目 session 不带模型字段", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.project.create.mockResolvedValue({ id: 12, name: "t3" });
    prismaStub.workspace.create.mockResolvedValue({ id: 31 });
    prismaStub.session.findFirst.mockResolvedValueOnce(null);
    prismaStub.session.create.mockResolvedValue({ id: 23, projectId: 12 });

    await repo.create({ ownerId: 1, name: "t3" });

    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectId: 12, workspaceId: 31, title: "t3" },
      }),
    );
  });

  it("正常创建 → 建 project + 资产目录 + 资产空间 + owner member + 项目 session + 欢迎消息", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.project.create.mockResolvedValue({ id: 11, name: "test" });
    prismaStub.workspace.create.mockResolvedValue({ id: 30 });
    prismaStub.session.findFirst.mockResolvedValueOnce({ currentModelId: 42 });
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });

    const result = await repo.create({
      ownerId: 1,
      name: "test",
      welcomeMessage: "欢迎",
    });

    expect(fsStub.mkdir).toHaveBeenCalledWith(assetsDir(11), {
      recursive: true,
    });
    expect(prismaStub.workspace.create).toHaveBeenCalledWith({
      data: {
        name: "资产 · test",
        directoryPath: assetsDir(11),
        projectId: 11,
      },
    });
    expect(prismaStub.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { projectId: 11, userId: 1, role: "owner" },
      }),
    );
    // 项目 session 挂资产空间（workspaceId=30），模型走全局继承（无 workspaceId 条件）
    expect(prismaStub.session.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaStub.session.findFirst).toHaveBeenCalledWith({
      where: { currentModelId: { not: null } },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      select: { currentModelId: true },
    });
    expect(prismaStub.session.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          projectId: 11,
          workspaceId: 30,
          title: "test",
          currentModelId: 42,
        },
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
    prismaStub.project.create.mockResolvedValue({ id: 12, name: "t2" });
    prismaStub.workspace.create.mockResolvedValue({ id: 31 });
    prismaStub.session.findFirst.mockResolvedValueOnce(null);
    prismaStub.session.create.mockResolvedValue({ id: 22, projectId: 12 });
    await repo.create({ ownerId: 1, name: "t2" });
    expect(prismaStub.message.create).not.toHaveBeenCalled();
  });

  it("创建时携带 bindings → 写入挂载", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.project.create.mockResolvedValue({ id: 11, name: "b" });
    prismaStub.workspace.create.mockResolvedValue({ id: 30 });
    prismaStub.session.findFirst.mockResolvedValueOnce(null);
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
    prismaStub.project.create.mockResolvedValue({ id: 11, name: "b" });
    prismaStub.workspace.create.mockResolvedValue({ id: 30 });
    prismaStub.session.findFirst.mockResolvedValueOnce(null);
    prismaStub.session.create.mockResolvedValue({ id: 21, projectId: 11 });
    await repo.create({ ownerId: 1, name: "b" });
    expect(prismaStub.projectBinding.createMany).not.toHaveBeenCalled();
  });

  it("资产目录创建失败 → 抛中文错误，不落 workspace 行/项目会话", async () => {
    prismaStub.project.findFirst.mockResolvedValue(null);
    prismaStub.project.create.mockResolvedValue({ id: 11, name: "t" });
    fsStub.mkdir.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    await expect(repo.create({ ownerId: 1, name: "t" })).rejects.toThrow(
      /资产目录创建失败/,
    );
    expect(prismaStub.workspace.create).not.toHaveBeenCalled();
    expect(prismaStub.session.create).not.toHaveBeenCalled();
  });
});

describe("ProjectRepository.remove", () => {
  beforeEach(() => vi.clearAllMocks());

  it("无资产空间（一期旧项目未自愈） → 跳过目录清理，级联删除不变", async () => {
    prismaStub.workspace.findFirst.mockResolvedValue(null);
    prismaStub.session.findMany.mockResolvedValue([{ id: 21 }, { id: 22 }]);
    await repo.remove(11);
    expect(fsStub.rm).not.toHaveBeenCalled();
    expect(prismaStub.workspace.delete).not.toHaveBeenCalled();
    // 三期级联：项目计划事项随项目删除（本地任务 projectId null 不受影响）
    expect(prismaStub.planItem.deleteMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
    });
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

  it("命中资产空间 → 删整棵 projects/<id> 目录树 + workspace 行，先于会话级联", async () => {
    prismaStub.workspace.findFirst.mockResolvedValueOnce({
      id: 30,
      directoryPath: assetsDir(11),
    });
    prismaStub.session.findMany.mockResolvedValue([{ id: 21 }]);
    await repo.remove(11);
    expect(fsStub.rm).toHaveBeenCalledWith(projectRootDir(11), {
      recursive: true,
      force: true,
    });
    expect(prismaStub.workspace.delete).toHaveBeenCalledWith({
      where: { id: 30 },
    });
    // 资产清理先于 message 级联（invocationCallOrder 跨 mock 全局递增）
    expect(
      prismaStub.workspace.delete.mock.invocationCallOrder[0],
    ).toBeLessThan(prismaStub.message.deleteMany.mock.invocationCallOrder[0]);
    expect(prismaStub.project.delete).toHaveBeenCalledWith({
      where: { id: 11 },
    });
  });

  it("资产目录删除失败 → 记日志后仍删 workspace 行与项目（DB 级联不中断）", async () => {
    prismaStub.workspace.findFirst.mockResolvedValueOnce({
      id: 30,
      directoryPath: assetsDir(11),
    });
    fsStub.rm.mockRejectedValueOnce(new Error("EACCES: permission denied"));
    prismaStub.session.findMany.mockResolvedValue([]);
    await expect(repo.remove(11)).resolves.toBeUndefined();
    expect(prismaStub.workspace.delete).toHaveBeenCalledWith({
      where: { id: 30 },
    });
    expect(prismaStub.project.delete).toHaveBeenCalledWith({
      where: { id: 11 },
    });
  });
});

describe("ProjectRepository.getDetail（一期旧项目自愈）", () => {
  beforeEach(() => vi.clearAllMocks());

  const projectRow = {
    id: 11,
    name: "旧项目",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
  };
  const sessionRow = {
    id: 21,
    workspaceId: 7,
    projectId: 11,
    assistantId: null,
    currentModelId: null,
    title: "旧项目",
    mode: null,
    pinnedAt: null,
    archivedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-02T00:00:00Z"),
    lastMessageAt: null,
  };

  it("项目无资产空间 → 补建目录 + workspace + 重绑 session，返回 assetWorkspaceId", async () => {
    prismaStub.project.findUnique.mockResolvedValue(projectRow);
    prismaStub.session.findFirst.mockResolvedValue(sessionRow);
    prismaStub.workspace.findFirst.mockResolvedValue(null);
    prismaStub.workspace.create.mockResolvedValue({
      id: 30,
      name: "资产 · 旧项目",
      directoryPath: assetsDir(11),
      projectId: 11,
    });
    prismaStub.projectBinding.findMany.mockResolvedValue([]);

    const detail = await repo.getDetail(11);

    expect(fsStub.mkdir).toHaveBeenCalledWith(assetsDir(11), {
      recursive: true,
    });
    expect(prismaStub.workspace.create).toHaveBeenCalledWith({
      data: {
        name: "资产 · 旧项目",
        directoryPath: assetsDir(11),
        projectId: 11,
      },
    });
    expect(prismaStub.session.updateMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
      data: { workspaceId: 30 },
    });
    expect(detail.assetWorkspaceId).toBe(30);
    // 响应内 session 立即反映重绑结果
    expect(detail.session.workspaceId).toBe(30);
    expect(detail.project.sessionId).toBe(21);
  });

  it("已有资产空间 → 幂等零副作用（不建目录/不建行/不重绑）", async () => {
    prismaStub.project.findUnique.mockResolvedValue(projectRow);
    prismaStub.session.findFirst.mockResolvedValue(sessionRow);
    prismaStub.workspace.findFirst.mockResolvedValue({
      id: 30,
      directoryPath: assetsDir(11),
      projectId: 11,
    });
    prismaStub.projectBinding.findMany.mockResolvedValue([]);

    const detail = await repo.getDetail(11);

    expect(fsStub.mkdir).not.toHaveBeenCalled();
    expect(prismaStub.workspace.create).not.toHaveBeenCalled();
    expect(prismaStub.session.updateMany).not.toHaveBeenCalled();
    expect(detail.assetWorkspaceId).toBe(30);
  });

  it("项目或会话不存在 → 抛 PROJECT_NOT_FOUND", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    prismaStub.session.findFirst.mockResolvedValue(null);
    await expect(repo.getDetail(99)).rejects.toThrow(PROJECT_NOT_FOUND);
    expect(prismaStub.workspace.create).not.toHaveBeenCalled();
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

describe("ProjectRepository.getPromptContext", () => {
  beforeEach(() => vi.clearAllMocks());

  it("项目不存在 → null（调用方回退助手 prompt）", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    await expect(repo.getPromptContext(99)).resolves.toBeNull();
    expect(prismaStub.projectBinding.findMany).not.toHaveBeenCalled();
  });

  it("三源挂载 → 专家 prompt/技能名/连接器名按挂载顺序收集", async () => {
    prismaStub.project.findUnique.mockResolvedValue({
      id: 11,
      name: "p",
      systemPrompt: "项目指令",
    });
    // 挂载顺序：assistant(5,3) → skill(4) → mcpServer(6)；assistant 5 无 prompt 行
    prismaStub.projectBinding.findMany.mockResolvedValue([
      { id: 1, projectId: 11, itemType: "assistant", itemId: 5 },
      { id: 2, projectId: 11, itemType: "assistant", itemId: 3 },
      { id: 3, projectId: 11, itemType: "skill", itemId: 4 },
      { id: 4, projectId: 11, itemType: "mcpServer", itemId: 6 },
    ]);
    // findMany 返回乱序：验证按挂载 id 顺序重排
    prismaStub.assistant.findMany.mockResolvedValue([
      { id: 3, systemPrompt: "专家B" },
      { id: 5, systemPrompt: "专家A" },
    ]);
    prismaStub.skillRecord.findMany.mockResolvedValue([
      { id: 4, name: "技能1" },
    ]);
    prismaStub.mcpServer.findMany.mockResolvedValue([
      { id: 6, name: "连接器1" },
    ]);

    await expect(repo.getPromptContext(11)).resolves.toEqual({
      projectName: "p",
      systemPrompt: "项目指令",
      boundAssistantPrompts: ["专家A", "专家B"],
      boundSkillNames: ["技能1"],
      boundConnectorNames: ["连接器1"],
    });
  });

  it("已删挂载源 → 出队不计入（兜底不产生 #id 占位）", async () => {
    prismaStub.project.findUnique.mockResolvedValue({
      id: 11,
      name: "p",
      systemPrompt: null,
    });
    prismaStub.projectBinding.findMany.mockResolvedValue([
      { id: 1, projectId: 11, itemType: "assistant", itemId: 5 },
      { id: 2, projectId: 11, itemType: "skill", itemId: 4 },
    ]);
    prismaStub.assistant.findMany.mockResolvedValue([]); // 专家已删
    prismaStub.skillRecord.findMany.mockResolvedValue([]); // 技能已删

    await expect(repo.getPromptContext(11)).resolves.toEqual({
      projectName: "p",
      systemPrompt: null,
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: [],
    });
  });

  it("挂载连接器仅取启用行（声明与注册工具集一致，二期 §3.7）", async () => {
    prismaStub.project.findUnique.mockResolvedValue({
      id: 11,
      name: "p",
      systemPrompt: null,
    });
    prismaStub.projectBinding.findMany.mockResolvedValue([
      { id: 1, projectId: 11, itemType: "mcpServer", itemId: 6 },
      { id: 2, projectId: 11, itemType: "mcpServer", itemId: 7 },
    ]);
    // 禁用行（id=7）由 DB where 过滤：mock 返回值即查询结果
    prismaStub.mcpServer.findMany.mockResolvedValue([
      { id: 6, name: "启用连接器" },
    ]);

    await expect(repo.getPromptContext(11)).resolves.toEqual({
      projectName: "p",
      systemPrompt: null,
      boundAssistantPrompts: [],
      boundSkillNames: [],
      boundConnectorNames: ["启用连接器"],
    });
    expect(prismaStub.mcpServer.findMany).toHaveBeenCalledWith({
      where: { id: { in: [6, 7] }, enabled: true },
      select: { id: true, name: true },
    });
  });
});

describe("ProjectRepository.listMembers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("返回成员列表（joinedAt 序）并 join user 取昵称（缺昵称回退用户名）", async () => {
    const now = new Date("2026-09-01T00:00:00Z");
    prismaStub.projectMember.findMany.mockResolvedValue([
      { projectId: 11, userId: 2, role: "member", joinedAt: now },
      { projectId: 11, userId: 1, role: "owner", joinedAt: now },
    ]);
    prismaStub.user.findMany.mockResolvedValue([
      { id: 1, nickname: "黄", username: "hjx" },
      { id: 2, nickname: "", username: "ai_bot" },
    ]);
    const members = await repo.listMembers(11);
    expect(members).toEqual([
      { userId: 2, nickname: "ai_bot", username: "ai_bot", role: "member" },
      { userId: 1, nickname: "黄", username: "hjx", role: "owner" },
    ]);
    expect(prismaStub.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectId: 11 },
      orderBy: { joinedAt: "asc" },
    });
    expect(prismaStub.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: [2, 1] } },
    });
  });
});
