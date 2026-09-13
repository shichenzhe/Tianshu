/**
 * 资产仓储单测（TDD）：sanitizeName 清洗用例表、safeJoin 沙箱穿越拒绝、
 * uniqueName 重名序号、list 目录映射（类型/大小/时间/ext + 文件夹懒统计 + 缺失自愈）、
 * createFolder/rename 清洗+序号、delete 文件/文件夹/幂等分支、
 * upload 逐文件复制（全成/部分失败/清洗序号/沙箱拒绝）、storage 递归 du
 * （mock fs 目录树求和/缺失归零/符号链接跳过/stat 竞态不连坐）、
 * openFile 文件放行文件夹拒绝 + openPath 错误串转抛、revealFile 定位调用、
 * pickFiles 多选返回/取消归 null。
 * 依赖经 vi.mock 替换（electron ipcMain+app+dialog+shell / Log /
 * node:fs/promises / node:fs existsSync / prisma client），
 * 沿用 project-repo.test.ts 的 mock 模式；
 * ProjectRepository 以桩对象注入（ensureAssetWorkspace 返回固定资产根）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";

const {
  USER_DATA,
  ROOT,
  fsStub,
  existsSyncStub,
  prismaStub,
  projectRepoStub,
  dialogStub,
  shellStub,
} = vi.hoisted(() => ({
  USER_DATA: "/tmp/tianshu-test-userdata",
  ROOT: "/tmp/tianshu-asset-root",
  fsStub: {
    readdir: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
    copyFile: vi.fn(),
  },
  existsSyncStub: vi.fn(),
  prismaStub: { project: { findUnique: vi.fn() } },
  projectRepoStub: { ensureAssetWorkspace: vi.fn() },
  dialogStub: { showOpenDialog: vi.fn() },
  shellStub: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: vi.fn(() => USER_DATA) },
  dialog: dialogStub,
  shell: shellStub,
}));
// asset.repo 引 commons/Log（Winston，模块加载即建 transport）——mock 掉避免测试写日志
vi.mock("../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// fs stub：readdir/stat/mkdir/rename/unlink/rm/copyFile 按用例路由（default 键兼容命名空间默认导入）
vi.mock("node:fs/promises", () => ({ default: fsStub, ...fsStub }));
// existsSync 供 uniqueName 同步探测
vi.mock("node:fs", () => ({ existsSync: existsSyncStub }));
vi.mock("../../electron/commons/prisma-client", () => ({
  default: prismaStub,
}));

import { ipcMain } from "electron";
import AssetRepository, {
  safeJoin,
  sanitizeName,
  uniqueName,
} from "../../electron/domains/project/asset.repo";
import { ASSET_QUOTA_BYTES } from "../../electron/domains/project/asset.entity";
import type ProjectRepository from "../../electron/domains/project/project.repo";

const repo = new AssetRepository(
  projectRepoStub as unknown as ProjectRepository,
);

const MTIME = new Date("2026-09-01T12:00:00Z");

/** Dirent 桩 */
const fileDirent = (name: string) => ({
  name,
  isDirectory: () => false,
  isFile: () => true,
});
const dirDirent = (name: string) => ({
  name,
  isDirectory: () => true,
  isFile: () => false,
});
/** 符号链接桩：withFileTypes 下既非文件也非目录（lstat 口径，不跟随） */
const symlinkDirent = (name: string) => ({
  name,
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => true,
});

/** stat 桩 */
const fileStat = (size: number) => ({
  size,
  mtime: MTIME,
  isFile: () => true,
  isDirectory: () => false,
});
const dirStat = () => ({
  size: 0,
  mtime: MTIME,
  isFile: () => false,
  isDirectory: () => true,
});

/** 带 code 的 fs 错误桩（ENOENT/EACCES 分支判定用） */
function errnoError(code: string, target: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: ${target}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** 按路径路由 readdir/stat 的目录树桩 */
function mockTree(
  direntsByDir: Record<string, unknown[]>,
  statsByPath: Record<string, unknown>,
) {
  fsStub.readdir.mockImplementation(
    async (dir: string) => direntsByDir[dir] ?? [],
  );
  fsStub.stat.mockImplementation(async (target: string) => {
    const stat = statsByPath[target];
    if (!stat) {
      throw errnoError("ENOENT", target);
    }
    return stat;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaStub.project.findUnique.mockResolvedValue({ id: 11, name: "p" });
  projectRepoStub.ensureAssetWorkspace.mockResolvedValue({
    id: 30,
    directoryPath: ROOT,
  });
  existsSyncStub.mockReturnValue(false);
  dialogStub.showOpenDialog.mockResolvedValue({
    canceled: true,
    filePaths: [],
  });
  shellStub.openPath.mockResolvedValue("");
});

describe("sanitizeName", () => {
  it.each(["a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"])(
    "剥离非法字符 %j → ab",
    (name) => {
      expect(sanitizeName(name)).toBe("ab");
    },
  );

  it.each(["a\u0000b", "a\u001fb", "a\u007fb"])(
    "剥离控制字符 %j → ab",
    (name) => {
      expect(sanitizeName(name)).toBe("ab");
    },
  );

  it("剥离首尾空白", () => {
    expect(sanitizeName("  计划书 ")).toBe("计划书");
  });

  it("剥离首尾点号", () => {
    expect(sanitizeName(".隐藏.")).toBe("隐藏");
  });

  it("合法名称原样返回（保留中间空格）", () => {
    expect(sanitizeName("季度报告 2026.pdf")).toBe("季度报告 2026.pdf");
  });

  it.each(["", " ", ".", "..", ":", "/", "\\", "?", "*", "|", '""', "<>"])(
    "清洗后为空（%j）→ 抛「名称无效」",
    (name) => {
      expect(() => sanitizeName(name)).toThrow("名称无效");
    },
  );
});

describe("safeJoin", () => {
  it("空相对路径 → 根目录", () => {
    expect(safeJoin(ROOT, "")).toBe(path.resolve(ROOT));
  });

  it("斜杠 / → 根目录（前导分隔不逃到盘符根）", () => {
    expect(safeJoin(ROOT, "/")).toBe(path.resolve(ROOT));
  });

  it.each(["..", "../escape", "a/../../b", "a/../.."])(
    "穿越路径 %j → 抛「非法路径」",
    (relPath) => {
      expect(() => safeJoin(ROOT, relPath)).toThrow("非法路径");
    },
  );

  it("绝对路径注入 → 抛「非法路径」", () => {
    expect(() => safeJoin(ROOT, "/etc/passwd")).toThrow("非法路径");
  });

  it("空字节注入 → 抛「非法路径」", () => {
    expect(() => safeJoin(ROOT, "a\u0000b")).toThrow("非法路径");
  });

  it("相似前缀目录不放行（root-evil 与 root 无包含关系）", () => {
    expect(() => safeJoin(ROOT, `../${path.basename(ROOT)}-evil/x`)).toThrow(
      "非法路径",
    );
  });

  it("嵌套与深层路径放行", () => {
    expect(safeJoin(ROOT, "docs")).toBe(path.join(path.resolve(ROOT), "docs"));
    expect(safeJoin(ROOT, "a/b/c/d.txt")).toBe(
      path.join(path.resolve(ROOT), "a/b/c/d.txt"),
    );
  });
});

describe("uniqueName", () => {
  it("名称未被占用 → 原样返回", () => {
    expect(uniqueName(ROOT, "计划书")).toBe("计划书");
    expect(existsSyncStub).toHaveBeenCalledWith(path.join(ROOT, "计划书"));
  });

  it("占用 → 追加序号「 (2)」", () => {
    existsSyncStub.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(uniqueName(ROOT, "计划书")).toBe("计划书 (2)");
  });

  it("扩展名保留：a.txt → a (2).txt", () => {
    existsSyncStub.mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(uniqueName(ROOT, "a.txt")).toBe("a (2).txt");
    expect(existsSyncStub).toHaveBeenLastCalledWith(
      path.join(ROOT, "a (2).txt"),
    );
  });

  it("顺序探测不回填空洞：「 (2)」也占用 → 「 (3)」", () => {
    existsSyncStub
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    expect(uniqueName(ROOT, "a.txt")).toBe("a (3).txt");
  });
});

describe("AssetRepository.resolveAssetRoot", () => {
  it("project 行 → ensureAssetWorkspace → { root, workspaceId }", async () => {
    await expect(repo.resolveAssetRoot(11)).resolves.toEqual({
      root: ROOT,
      workspaceId: 30,
    });
    expect(prismaStub.project.findUnique).toHaveBeenCalledWith({
      where: { id: 11 },
    });
  });

  it("项目不存在 → 抛 PROJECT_NOT_FOUND，不触发资产空间自愈", async () => {
    prismaStub.project.findUnique.mockResolvedValue(null);
    await expect(repo.resolveAssetRoot(99)).rejects.toThrow(
      "PROJECT_NOT_FOUND",
    );
    expect(projectRepoStub.ensureAssetWorkspace).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.list", () => {
  it("混合目录项 → 映射类型/大小/时间/ext，文件夹在前名升序", async () => {
    // 根乱序给入：b.txt、docs/、a.md；docs 内：x.pdf(40) + 子目录 sub/（不递归）
    mockTree(
      {
        [ROOT]: [fileDirent("b.txt"), dirDirent("docs"), fileDirent("a.md")],
        [path.join(ROOT, "docs")]: [fileDirent("x.pdf"), dirDirent("sub")],
      },
      {
        [path.join(ROOT, "b.txt")]: fileStat(10),
        [path.join(ROOT, "a.md")]: fileStat(5),
        [path.join(ROOT, "docs")]: dirStat(),
        [path.join(ROOT, "docs", "x.pdf")]: fileStat(40),
      },
    );

    await expect(repo.list(11, "")).resolves.toEqual([
      {
        name: "docs",
        type: "folder",
        size: 40,
        updatedAt: MTIME.toISOString(),
        ext: null,
      },
      {
        name: "a.md",
        type: "file",
        size: 5,
        updatedAt: MTIME.toISOString(),
        ext: "md",
      },
      {
        name: "b.txt",
        type: "file",
        size: 10,
        updatedAt: MTIME.toISOString(),
        ext: "txt",
      },
    ]);
  });

  it("folderPath 省缺 → 根目录", async () => {
    mockTree(
      { [ROOT]: [fileDirent("a.txt")] },
      { [path.join(ROOT, "a.txt")]: fileStat(3) },
    );
    await expect(repo.list(11)).resolves.toEqual([
      {
        name: "a.txt",
        type: "file",
        size: 3,
        updatedAt: MTIME.toISOString(),
        ext: "txt",
      },
    ]);
  });

  it("子目录列表经同一沙箱与懒统计", async () => {
    mockTree(
      { [path.join(ROOT, "docs")]: [fileDirent("x.pdf")] },
      { [path.join(ROOT, "docs", "x.pdf")]: fileStat(40) },
    );
    await expect(repo.list(11, "docs")).resolves.toEqual([
      {
        name: "x.pdf",
        type: "file",
        size: 40,
        updatedAt: MTIME.toISOString(),
        ext: "pdf",
      },
    ]);
  });

  it("大写扩展名归一小写", async () => {
    mockTree(
      { [ROOT]: [fileDirent("IMG.PNG")] },
      { [path.join(ROOT, "IMG.PNG")]: fileStat(7) },
    );
    await expect(repo.list(11, "")).resolves.toMatchObject([
      { name: "IMG.PNG", ext: "png" },
    ]);
  });

  it("目录缺失 → mkdir recursive 自愈 + 空列表", async () => {
    fsStub.readdir.mockRejectedValueOnce(
      errnoError("ENOENT", path.join(ROOT, "gone")),
    );
    await expect(repo.list(11, "gone")).resolves.toEqual([]);
    expect(fsStub.mkdir).toHaveBeenCalledWith(path.join(ROOT, "gone"), {
      recursive: true,
    });
  });

  it("读取失败（非缺失）→ 抛中文错误且不自愈", async () => {
    fsStub.readdir.mockRejectedValueOnce(errnoError("EACCES", ROOT));
    await expect(repo.list(11, "")).rejects.toThrow(/读取资产目录失败/);
    expect(fsStub.mkdir).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.createFolder", () => {
  it("清洗 + 建目录，返回最终名", async () => {
    await expect(repo.createFolder(11, "", "计划?书")).resolves.toBe("计划书");
    expect(fsStub.mkdir).toHaveBeenCalledWith(path.join(ROOT, "计划书"), {
      recursive: true,
    });
  });

  it("父目录嵌套：落到 parentPath 之下", async () => {
    await repo.createFolder(11, "docs", "新文件夹");
    expect(fsStub.mkdir).toHaveBeenCalledWith(
      path.join(ROOT, "docs", "新文件夹"),
      { recursive: true },
    );
  });

  it("重名 → 序号「 (2)」并返回", async () => {
    existsSyncStub.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(repo.createFolder(11, "", "资料")).resolves.toBe("资料 (2)");
    expect(fsStub.mkdir).toHaveBeenCalledWith(path.join(ROOT, "资料 (2)"), {
      recursive: true,
    });
  });

  it("名称清洗后为空 → 抛「名称无效」且不建目录", async () => {
    await expect(repo.createFolder(11, "", "??")).rejects.toThrow("名称无效");
    expect(fsStub.mkdir).not.toHaveBeenCalled();
  });

  it("建目录失败 → 抛中文错误", async () => {
    fsStub.mkdir.mockRejectedValueOnce(errnoError("EACCES", ROOT));
    await expect(repo.createFolder(11, "", "x")).rejects.toThrow(
      /创建文件夹失败/,
    );
  });
});

describe("AssetRepository.rename", () => {
  it("清洗 + 改名，返回最终名", async () => {
    await expect(repo.rename(11, "docs/a.txt", "B?.txt")).resolves.toBe(
      "B.txt",
    );
    expect(fsStub.rename).toHaveBeenCalledWith(
      path.join(ROOT, "docs", "a.txt"),
      path.join(ROOT, "docs", "B.txt"),
    );
  });

  it("目标重名 → 序号并落到序号名", async () => {
    existsSyncStub.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(repo.rename(11, "docs/a.txt", "b.txt")).resolves.toBe(
      "b (2).txt",
    );
    expect(fsStub.rename).toHaveBeenCalledWith(
      path.join(ROOT, "docs", "a.txt"),
      path.join(ROOT, "docs", "b (2).txt"),
    );
  });

  it("旧路径越界 → 拒绝且不落盘", async () => {
    await expect(repo.rename(11, "../a.txt", "b.txt")).rejects.toThrow(
      "非法路径",
    );
    expect(fsStub.rename).not.toHaveBeenCalled();
  });

  it("改名失败 → 抛中文错误", async () => {
    fsStub.rename.mockRejectedValueOnce(errnoError("EPERM", ROOT));
    await expect(repo.rename(11, "a.txt", "b.txt")).rejects.toThrow(
      /重命名失败/,
    );
  });
});

describe("AssetRepository.delete", () => {
  it("文件 → unlink", async () => {
    fsStub.stat.mockResolvedValueOnce(fileStat(10));
    await expect(repo.delete(11, "a.txt")).resolves.toBeUndefined();
    expect(fsStub.unlink).toHaveBeenCalledWith(path.join(ROOT, "a.txt"));
    expect(fsStub.rm).not.toHaveBeenCalled();
  });

  it("文件夹 → rm recursive + force", async () => {
    fsStub.stat.mockResolvedValueOnce(dirStat());
    await repo.delete(11, "docs");
    expect(fsStub.rm).toHaveBeenCalledWith(path.join(ROOT, "docs"), {
      recursive: true,
      force: true,
    });
    expect(fsStub.unlink).not.toHaveBeenCalled();
  });

  it("目标不存在 → 幂等 no-op", async () => {
    fsStub.stat.mockRejectedValueOnce(
      errnoError("ENOENT", path.join(ROOT, "x")),
    );
    await expect(repo.delete(11, "x")).resolves.toBeUndefined();
    expect(fsStub.unlink).not.toHaveBeenCalled();
    expect(fsStub.rm).not.toHaveBeenCalled();
  });

  it("根目录 → 拒绝整空间删除", async () => {
    await expect(repo.delete(11, "")).rejects.toThrow(/根目录/);
    expect(fsStub.rm).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.upload", () => {
  it("全部成功：basename 清洗后落目标文件夹，uploaded 齐、failed 空", async () => {
    await expect(
      repo.upload(11, "docs", ["/src/a.txt", "/src/b.pdf"]),
    ).resolves.toEqual({ uploaded: ["a.txt", "b.pdf"], failed: [] });
    expect(fsStub.mkdir).toHaveBeenCalledWith(path.join(ROOT, "docs"), {
      recursive: true,
    });
    expect(fsStub.copyFile).toHaveBeenCalledWith(
      "/src/a.txt",
      path.join(ROOT, "docs", "a.txt"),
    );
    expect(fsStub.copyFile).toHaveBeenCalledWith(
      "/src/b.pdf",
      path.join(ROOT, "docs", "b.pdf"),
    );
  });

  it("部分失败：源不可读收集进 failed，循环不中断", async () => {
    fsStub.copyFile.mockRejectedValueOnce(errnoError("ENOENT", "/src/x.txt"));
    await expect(
      repo.upload(11, "", ["/src/x.txt", "/src/y.txt"]),
    ).resolves.toEqual({ uploaded: ["y.txt"], failed: ["x.txt"] });
    expect(fsStub.copyFile).toHaveBeenCalledTimes(2);
  });

  it("清洗 + 重名序号逐文件应用：同批次同名 → a (2).txt", async () => {
    existsSyncStub
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    await expect(
      repo.upload(11, "", ["/src/a?.txt", "/src/a.txt"]),
    ).resolves.toEqual({ uploaded: ["a.txt", "a (2).txt"], failed: [] });
    expect(fsStub.copyFile).toHaveBeenCalledWith(
      "/src/a?.txt",
      path.join(ROOT, "a.txt"),
    );
    expect(fsStub.copyFile).toHaveBeenCalledWith(
      "/src/a.txt",
      path.join(ROOT, "a (2).txt"),
    );
  });

  it("folderPath 越界 → 抛「非法路径」且不复制", async () => {
    await expect(repo.upload(11, "../x", ["/src/a.txt"])).rejects.toThrow(
      "非法路径",
    );
    expect(fsStub.copyFile).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.storage", () => {
  it("递归累计全树文件字节（含嵌套子目录）", async () => {
    mockTree(
      {
        [ROOT]: [fileDirent("a.txt"), dirDirent("docs"), symlinkDirent("lnk")],
        [path.join(ROOT, "docs")]: [fileDirent("x.pdf"), dirDirent("sub")],
        [path.join(ROOT, "docs", "sub")]: [fileDirent("y.md")],
      },
      {
        [path.join(ROOT, "a.txt")]: fileStat(10),
        [path.join(ROOT, "docs", "x.pdf")]: fileStat(40),
        [path.join(ROOT, "docs", "sub", "y.md")]: fileStat(2),
      },
    );
    await expect(repo.storage(11)).resolves.toEqual({
      usedBytes: 52,
      quotaBytes: ASSET_QUOTA_BYTES,
    });
  });

  it("符号链接跳过：不 stat 不跟随（防死循环）", async () => {
    mockTree({ [ROOT]: [symlinkDirent("loop")] }, {});
    await expect(repo.storage(11)).resolves.toEqual({
      usedBytes: 0,
      quotaBytes: ASSET_QUOTA_BYTES,
    });
    expect(fsStub.stat).not.toHaveBeenCalledWith(path.join(ROOT, "loop"));
    expect(fsStub.readdir).toHaveBeenCalledTimes(1);
  });

  it("单文件 stat 失败（竞态删除）→ 按 0 计不连坐", async () => {
    mockTree(
      { [ROOT]: [fileDirent("a.txt"), fileDirent("gone.txt")] },
      { [path.join(ROOT, "a.txt")]: fileStat(10) },
    );
    await expect(repo.storage(11)).resolves.toEqual({
      usedBytes: 10,
      quotaBytes: ASSET_QUOTA_BYTES,
    });
  });

  it("根目录缺失 → usedBytes 归零（自愈或零口径）", async () => {
    fsStub.readdir.mockRejectedValue(errnoError("ENOENT", ROOT));
    await expect(repo.storage(11)).resolves.toEqual({
      usedBytes: 0,
      quotaBytes: ASSET_QUOTA_BYTES,
    });
  });
});

describe("AssetRepository.openFile", () => {
  it("文件 → shell.openPath 系统预览", async () => {
    fsStub.stat.mockResolvedValueOnce(fileStat(10));
    await expect(repo.openFile(11, "docs/a.pdf")).resolves.toBeUndefined();
    expect(shellStub.openPath).toHaveBeenCalledWith(
      path.join(ROOT, "docs", "a.pdf"),
    );
  });

  it("文件夹 → 拒绝「仅支持预览文件」", async () => {
    fsStub.stat.mockResolvedValueOnce(dirStat());
    await expect(repo.openFile(11, "docs")).rejects.toThrow("仅支持预览文件");
    expect(shellStub.openPath).not.toHaveBeenCalled();
  });

  it("openPath 返回错误串 → 转 reject 让渲染层 toast", async () => {
    fsStub.stat.mockResolvedValueOnce(fileStat(10));
    shellStub.openPath.mockResolvedValueOnce("无法打开文件");
    await expect(repo.openFile(11, "a.pdf")).rejects.toThrow("无法打开文件");
  });

  it("路径越界 → 拒绝", async () => {
    await expect(repo.openFile(11, "../a.pdf")).rejects.toThrow("非法路径");
    expect(shellStub.openPath).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.revealFile", () => {
  it("shell.showItemInFolder 定位", async () => {
    await expect(repo.revealFile(11, "docs/a.pdf")).resolves.toBeUndefined();
    expect(shellStub.showItemInFolder).toHaveBeenCalledWith(
      path.join(ROOT, "docs", "a.pdf"),
    );
  });

  it("路径越界 → 拒绝", async () => {
    await expect(repo.revealFile(11, "../a.pdf")).rejects.toThrow("非法路径");
    expect(shellStub.showItemInFolder).not.toHaveBeenCalled();
  });
});

describe("AssetRepository.pickFiles", () => {
  it("多选 → 返回绝对路径数组（openFile + multiSelections）", async () => {
    dialogStub.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/pick/a.txt", "/pick/b.pdf"],
    });
    await expect(repo.pickFiles()).resolves.toEqual([
      "/pick/a.txt",
      "/pick/b.pdf",
    ]);
    expect(dialogStub.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile", "multiSelections"],
    });
  });

  it("取消 → 返回 null（不抛）", async () => {
    dialogStub.showOpenDialog.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    await expect(repo.pickFiles()).resolves.toBeNull();
  });
});

describe("IPC 注册", () => {
  it("九个 projectAsset 通道自注册", () => {
    new AssetRepository(projectRepoStub as unknown as ProjectRepository);
    for (const channel of [
      "projectAsset:list",
      "projectAsset:createFolder",
      "projectAsset:rename",
      "projectAsset:delete",
      "projectAsset:upload",
      "projectAsset:storage",
      "projectAsset:openFile",
      "projectAsset:revealFile",
      "projectAsset:pickFiles",
    ]) {
      expect(ipcMain.handle).toHaveBeenCalledWith(
        channel,
        expect.any(Function),
      );
    }
  });
});
