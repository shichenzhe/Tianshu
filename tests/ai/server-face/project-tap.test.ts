// A7 项目批（spec 2026-10-26 §3）：project 域四 tap 实现直测——userId 前置
// 序映射、create 载荷无身份字段透传、getDetail 只带 sessionId（不泄完整
// SessionRecord）、planView/asset 可见性守卫（守门失败不触达 repo）、asset
// readImage 四路守卫（真临时目录读写闭环）+ ProjectRepository.assertProjectVisible
// 公开守卫全分支（prisma 替身）。repo 真身禁测（构造注册 IPC）——公开守卫
// 纯查询除外。
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER_DATA = `/tmp/tianshu-face-project-${process.pid}`;

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => USER_DATA),
    getAppPath: vi.fn(() => USER_DATA),
    isPackaged: false,
  },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// prisma stub：仅 ProjectRepository.assertProjectVisible 公开守卫真身直测用
// （project-repo.test.ts 同款 mock 口径）
const prismaStub = vi.hoisted(() => ({
  project: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  projectMember: {
    create: vi.fn(),
    deleteMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
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
  planItem: { findMany: vi.fn(), deleteMany: vi.fn() },
  planItemAttachment: { deleteMany: vi.fn() },
  automationTask: { deleteMany: vi.fn() },
  planView: { deleteMany: vi.fn() },
  assistant: { findMany: vi.fn(), findUnique: vi.fn() },
  skillRecord: { findMany: vi.fn(), findUnique: vi.fn() },
  mcpServer: { findMany: vi.fn(), findUnique: vi.fn() },
  user: { findMany: vi.fn() },
}));

vi.mock("../../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import {
  createProjectFace,
  FaceProjectError,
} from "../../../electron/domains/server-face/project-tap";
import { createPlanItemFace } from "../../../electron/domains/server-face/plan-item-tap";
import { createPlanViewFace } from "../../../electron/domains/server-face/plan-view-tap";
import { createProjectAssetFace } from "../../../electron/domains/server-face/project-asset-tap";
import ProjectRepository from "../../../electron/domains/project/project.repo";
import { PROJECT_NOT_FOUND } from "../../../electron/domains/project/project.entity";

const UID = 7;
const ISO = "2026-10-26T00:00:00.000Z";

const PROJECT_RECORD = {
  id: 11,
  name: "项目甲",
  systemPrompt: null,
  templateKey: null,
  ownerId: UID,
  sessionId: 22,
  createdAt: ISO,
  updatedAt: ISO,
};
const SESSION_RECORD = {
  id: 22,
  workspaceId: 30,
  title: "项目甲",
  mode: "agent" as const,
  createdAt: ISO,
  updatedAt: ISO,
};
const BINDINGS = [
  {
    id: 1,
    itemType: "assistant" as const,
    itemId: 5,
    itemName: "专家A",
    valid: true,
  },
];
const DETAIL = {
  project: PROJECT_RECORD,
  assetWorkspaceId: 30,
  bindings: BINDINGS,
  session: SESSION_RECORD,
};

let dataRoot = "";
beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "face-project-"));
  process.env.TIANSHU_DATA_ROOT = dataRoot;
});
afterEach(() => {
  delete process.env.TIANSHU_DATA_ROOT;
  rmSync(dataRoot, { recursive: true, force: true });
});

/** 内存 projectRepo 替身：全方法缺省桩，overrides 按需覆写 */
function fakeProjectRepo(overrides: Record<string, unknown> = {}) {
  const base = {
    list: vi.fn(async () => [PROJECT_RECORD]),
    getDetail: vi.fn(async () => DETAIL),
    create: vi.fn(async () => PROJECT_RECORD),
    update: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    listMembers: vi.fn(async () => [
      { userId: UID, nickname: "昵称", username: "user", role: "owner" },
    ]),
  };
  return {
    repo: { ...base, ...overrides } as unknown as Parameters<
      typeof createProjectFace
    >[0],
    base,
  };
}

describe("project-tap（A7 桌面被控面）", () => {
  it("userId 前置映射：repo 按 (业务参..., userId) 旧序调用", async () => {
    const { repo, base } = fakeProjectRepo();
    const face = createProjectFace(repo);

    await face.query(UID);
    expect(base.list).toHaveBeenCalledWith(UID);
    await face.getDetail(UID, 11);
    expect(base.getDetail).toHaveBeenCalledWith(11, UID);
    await face.update(UID, { id: 11, name: "n" });
    expect(base.update).toHaveBeenCalledWith({ id: 11, name: "n" }, UID);
    await face.remove(UID, 11);
    expect(base.remove).toHaveBeenCalledWith(11, UID);
    await face.listMembers(UID, 11);
    expect(base.listMembers).toHaveBeenCalledWith(11, UID);
  });

  it("create：载荷无 ownerId 透传（身份唯一来源 withUserId）", async () => {
    const { repo, base } = fakeProjectRepo();
    await createProjectFace(repo).create(UID, {
      name: "新项目",
      systemPrompt: "指令",
    });
    const params = base.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual({ name: "新项目", systemPrompt: "指令" });
    expect(params).not.toHaveProperty("ownerId");
    expect(base.create.mock.calls[0][1]).toBe(UID);
  });

  it("getDetail：只回传 sessionId——不泄完整 SessionRecord", async () => {
    const { repo, base } = fakeProjectRepo();
    const detail = await createProjectFace(repo).getDetail(UID, 11);
    expect(detail).toEqual({
      project: PROJECT_RECORD,
      assetWorkspaceId: 30,
      bindings: BINDINGS,
      sessionId: 22,
    });
    expect(detail).not.toHaveProperty("session");
    expect(base.getDetail).toHaveBeenCalledWith(11, UID);
  });

  it("错误码透传：repo 稳定码 → FaceProjectError；非码错误原样抛", async () => {
    const coded = fakeProjectRepo({
      getDetail: vi.fn(async () => {
        throw new Error("PROJECT_NOT_FOUND");
      }),
    });
    await expect(
      createProjectFace(coded.repo).getDetail(UID, 404),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      createProjectFace(coded.repo).getDetail(UID, 404),
    ).rejects.toBeInstanceOf(FaceProjectError);

    const raw = fakeProjectRepo({
      getDetail: vi.fn(async () => {
        throw new Error("磁盘炸了");
      }),
    });
    await expect(
      createProjectFace(raw.repo).getDetail(UID, 404),
    ).rejects.toThrow("磁盘炸了");
  });
});

describe("plan-item-tap（A7 桌面被控面）", () => {
  const ITEM_RECORD = {
    id: 5,
    projectId: 3,
    title: "事项",
    description: "",
    aiSummary: "",
    status: "not_started" as const,
    priority: "P1" as const,
    assigneeId: null,
    tags: ["a"],
    customFields: {},
    startDate: "",
    dueDate: "",
    source: "manual" as const,
    sortOrder: 1,
    createdById: UID,
    createdAt: ISO,
    updatedAt: ISO,
  };

  function fakeItemRepo(overrides: Record<string, unknown> = {}) {
    const attachment = {
      id: 9,
      planItemId: 5,
      fileName: "f.png",
      assetPath: "docs/f.png",
      createdAt: ISO,
    };
    const base = {
      list: vi.fn(async () => [ITEM_RECORD]),
      listMine: vi.fn(async () => [ITEM_RECORD]),
      create: vi.fn(async () => ITEM_RECORD),
      update: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      listFields: vi.fn(async () => [{ name: "进度", type: "text" as const }]),
      listAttachments: vi.fn(async () => [attachment]),
      createAttachment: vi.fn(async () => attachment),
      removeAttachment: vi.fn(async () => {}),
    };
    return {
      repo: { ...base, ...overrides } as unknown as Parameters<
        typeof createPlanItemFace
      >[0],
      base,
    };
  }

  it("userId 前置映射 + create 载荷无 createdById 透传", async () => {
    const { repo, base } = fakeItemRepo();
    const face = createPlanItemFace(repo);

    await face.list(UID, 3);
    expect(base.list).toHaveBeenCalledWith(3, UID);
    await face.listMine(UID);
    expect(base.listMine).toHaveBeenCalledWith(UID);

    await face.create(UID, { title: "t", projectId: 3, status: "in_progress" });
    const params = base.create.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toEqual({ title: "t", projectId: 3, status: "in_progress" });
    expect(params).not.toHaveProperty("createdById");
    expect(base.create.mock.calls[0][1]).toBe(UID);

    await face.update(UID, { id: 5, title: "t2" });
    expect(base.update).toHaveBeenCalledWith({ id: 5, title: "t2" }, UID);
    await face.remove(UID, 5);
    expect(base.remove).toHaveBeenCalledWith(5, UID);
    await face.move(UID, { id: 5, status: "done", sortOrder: 2 });
    expect(base.move).toHaveBeenCalledWith(
      { id: 5, status: "done", sortOrder: 2 },
      UID,
    );
    await face.listFields(UID, 3);
    expect(base.listFields).toHaveBeenCalledWith(3, UID);
    await face.listAttachments(UID, 5);
    expect(base.listAttachments).toHaveBeenCalledWith(5, UID);
    await face.createAttachment(UID, 5, {
      fileName: "f.png",
      assetPath: "docs/f.png",
    });
    expect(base.createAttachment).toHaveBeenCalledWith(
      5,
      { fileName: "f.png", assetPath: "docs/f.png" },
      UID,
    );
    await face.removeAttachment(UID, 9);
    expect(base.removeAttachment).toHaveBeenCalledWith(9, UID);
  });

  it("FaceProjectError 码透传：list 抛稳定码 rejects code", async () => {
    const { repo } = fakeItemRepo({
      list: vi.fn(async () => {
        throw new Error("PLAN_ITEM_NOT_FOUND");
      }),
    });
    await expect(createPlanItemFace(repo).list(UID, 3)).rejects.toMatchObject({
      code: "PLAN_ITEM_NOT_FOUND",
    });
  });
});

describe("plan-view-tap（A7 桌面被控面）", () => {
  const VIEW = {
    id: 1,
    projectId: 3,
    name: "",
    type: "table" as const,
    groupBy: null,
    filterJson: "{}",
    sortJson: "[]",
    sortOrder: 0,
    createdAt: ISO,
    updatedAt: ISO,
  };

  function makeFace(guardOverrides: Record<string, unknown> = {}) {
    const projectRepo = {
      assertProjectVisible: vi.fn(async () => {}),
      ...guardOverrides,
    };
    const viewRepo = { list: vi.fn(async () => [VIEW]) };
    return {
      face: createPlanViewFace(
        projectRepo as unknown as Parameters<typeof createPlanViewFace>[0],
        viewRepo,
      ),
      projectRepo,
      viewRepo,
    };
  }

  it("守卫通过：assertProjectVisible 先行，list 直透", async () => {
    const { face, projectRepo, viewRepo } = makeFace();
    expect(await face.list(UID, 3)).toEqual([VIEW]);
    expect(projectRepo.assertProjectVisible).toHaveBeenCalledWith(3, UID);
    expect(viewRepo.list).toHaveBeenCalledWith(3);
  });

  it("守卫拒绝：非 owner 非成员 PROJECT_NOT_FOUND，不触达 viewRepo", async () => {
    const { face, projectRepo, viewRepo } = makeFace({
      assertProjectVisible: vi.fn(async () => {
        throw new Error("PROJECT_NOT_FOUND");
      }),
    });
    await expect(face.list(UID, 3)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect(projectRepo.assertProjectVisible).toHaveBeenCalledWith(3, UID);
    expect(viewRepo.list).not.toHaveBeenCalled();
  });
});

describe("project-asset-tap（A7 桌面被控面）", () => {
  function fakeAssetRepo(overrides: Record<string, unknown> = {}) {
    const base = {
      list: vi.fn(async () => [
        {
          name: "docs",
          type: "folder" as const,
          size: 0,
          updatedAt: ISO,
          ext: null,
        },
        {
          name: "a.png",
          type: "file" as const,
          size: 3,
          updatedAt: ISO,
          ext: "png",
        },
      ]),
      createFolder: vi.fn(async () => "dir"),
      rename: vi.fn(async () => "b.png"),
      delete: vi.fn(async () => {}),
      storage: vi.fn(async () => ({ usedBytes: 1, quotaBytes: 2 })),
      resolveAssetRoot: vi.fn(async () => ({
        root: dataRoot,
        workspaceId: 30,
      })),
    };
    return {
      repo: { ...base, ...overrides } as unknown as Parameters<
        typeof createProjectAssetFace
      >[1],
      base,
    };
  }

  function makeFace(assetOverrides: Record<string, unknown> = {}) {
    const projectRepo = {
      assertProjectVisible: vi.fn(async () => {}),
    };
    const { repo, base } = fakeAssetRepo(assetOverrides);
    return {
      face: createProjectAssetFace(
        projectRepo as unknown as Parameters<typeof createProjectAssetFace>[0],
        repo,
      ),
      projectRepo,
      base,
    };
  }

  it("守卫通过 + list：AssetEntry.ext null → DTO 空串；userId 序映射", async () => {
    const { face, projectRepo, base } = makeFace();
    const entries = await face.list(UID, 3);
    expect(entries[0].ext).toBe("");
    expect(entries[1].ext).toBe("png");
    expect(projectRepo.assertProjectVisible).toHaveBeenCalledWith(3, UID);
    expect(base.list).toHaveBeenCalledWith(3, undefined);
  });

  it("守卫拒绝：PROJECT_NOT_FOUND 原码透传，repo 未触达", async () => {
    const projectRepo = {
      assertProjectVisible: vi.fn(async () => {
        throw new Error("PROJECT_NOT_FOUND");
      }),
    };
    const { repo, base } = fakeAssetRepo();
    const face = createProjectAssetFace(
      projectRepo as unknown as Parameters<typeof createProjectAssetFace>[0],
      repo,
    );
    await expect(face.list(UID, 3)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    await expect(face.storage(UID, 3)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect(base.list).not.toHaveBeenCalled();
    expect(base.storage).not.toHaveBeenCalled();
  });

  it("createFolder/rename 返回最终名直传（资产 repo 无 userId 参——守卫分离）", async () => {
    const { face, base } = makeFace();
    expect(await face.createFolder(UID, 3, "", "d")).toBe("dir");
    expect(base.createFolder).toHaveBeenCalledWith(3, "", "d");
    expect(await face.rename(UID, 3, "a.png", "b")).toBe("b.png");
    expect(base.rename).toHaveBeenCalledWith(3, "a.png", "b");
    await face.remove(UID, 3, "a.png");
    expect(base.delete).toHaveBeenCalledWith(3, "a.png");
    expect(await face.storage(UID, 3)).toEqual({ usedBytes: 1, quotaBytes: 2 });
  });

  it("readImage：png happy path 出 mime+base64", async () => {
    const png = Buffer.from([137, 80, 78, 71, 1, 2, 3]);
    writeFileSync(path.join(dataRoot, "pic.png"), png);
    const { face } = makeFace();
    expect(await face.readImage(UID, 3, "pic.png")).toEqual({
      mime: "image/png",
      dataBase64: png.toString("base64"),
    });
  });

  it("readImage：越界路径 ASSET_PATH_ESCAPE；非白名单 ASSET_NAME_INVALID", async () => {
    const { face } = makeFace();
    await expect(face.readImage(UID, 3, "../pic.png")).rejects.toMatchObject({
      code: "ASSET_PATH_ESCAPE",
    });
    writeFileSync(path.join(dataRoot, "t.txt"), "hi");
    await expect(face.readImage(UID, 3, "t.txt")).rejects.toMatchObject({
      code: "ASSET_NAME_INVALID",
    });
  });

  it("readImage：大图/不存在 ASSET_NOT_FOUND（message 明示原因）", async () => {
    writeFileSync(
      path.join(dataRoot, "big.png"),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    );
    const { face } = makeFace();
    await expect(face.readImage(UID, 3, "big.png")).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
      message: "图片超过 10MB 上限",
    });
    await expect(face.readImage(UID, 3, "ghost.png")).rejects.toMatchObject({
      code: "ASSET_NOT_FOUND",
    });
  });

  it("readImage：守卫先行——resolveAssetRoot 未触达即拒", async () => {
    const projectRepo = {
      assertProjectVisible: vi.fn(async () => {
        throw new Error("PROJECT_NOT_FOUND");
      }),
    };
    const { repo, base } = fakeAssetRepo();
    const face = createProjectAssetFace(
      projectRepo as unknown as Parameters<typeof createProjectAssetFace>[0],
      repo,
    );
    await expect(face.readImage(UID, 3, "pic.png")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
    expect(base.resolveAssetRoot).not.toHaveBeenCalled();
  });
});

describe("ProjectRepository.assertProjectVisible（A7 公开守卫）", () => {
  const repo = new ProjectRepository();

  beforeEach(() => vi.clearAllMocks());

  it("owner 直接放行（不查成员表）", async () => {
    prismaStub.project.findUnique.mockResolvedValue({ id: 11, ownerId: UID });
    await expect(repo.assertProjectVisible(11, UID)).resolves.toBeUndefined();
    expect(prismaStub.projectMember.findFirst).not.toHaveBeenCalled();
  });

  it("成员放行（owner 不匹配回查 member 命中）", async () => {
    prismaStub.project.findUnique.mockResolvedValue({ id: 11, ownerId: 2 });
    prismaStub.projectMember.findFirst.mockResolvedValue({ id: 1 });
    await expect(repo.assertProjectVisible(11, UID)).resolves.toBeUndefined();
    expect(prismaStub.projectMember.findFirst).toHaveBeenCalledWith({
      where: { projectId: 11, userId: UID },
    });
  });

  it("非 owner 非成员拒：PROJECT_NOT_FOUND（存在性不泄露）", async () => {
    prismaStub.project.findUnique.mockResolvedValue({ id: 11, ownerId: 2 });
    prismaStub.projectMember.findFirst.mockResolvedValue(null);
    await expect(repo.assertProjectVisible(11, UID)).rejects.toThrow(
      PROJECT_NOT_FOUND,
    );
  });

  it("项目不存在拒：PROJECT_NOT_FOUND（同码同口径）", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    await expect(repo.assertProjectVisible(404, UID)).rejects.toThrow(
      PROJECT_NOT_FOUND,
    );
    expect(prismaStub.projectMember.findFirst).not.toHaveBeenCalled();
  });
});
