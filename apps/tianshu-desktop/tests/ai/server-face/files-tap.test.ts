// face files 桥（FA-T2，spec §3.1）：桌面被控面文件三端点——实现直测
// （prisma 桩 + mkdtemp 工作目录 + TIANSHU_DATA_ROOT 隔离落盘）+
// handleRoute 分发冒烟（deps 注入真实现）。
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));
vi.mock("../../../electron/commons/Log", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const workspaceFindFirst = vi.fn();
vi.mock("../../../electron/commons/prisma-client", () => ({
  default: {
    workspace: { findFirst: (...a: unknown[]) => workspaceFindFirst(...a) },
  },
}));

import {
  createFilesFace,
  FaceFilesError,
} from "../../../electron/domains/server-face/files-tap";
import { handleRoute } from "../../../electron/domains/server-face/routes";
import { setServerFaceDeps } from "../../../electron/domains/server-face/deps";

const UID = 7;
let dataRoot = "";

beforeEach(() => {
  dataRoot = mkdtempSync(path.join(os.tmpdir(), "face-files-"));
  process.env.TIANSHU_DATA_ROOT = dataRoot;
});

afterEach(() => {
  delete process.env.TIANSHU_DATA_ROOT;
});

function bindWorkspace(directoryPath: string | null, userId = UID) {
  workspaceFindFirst.mockResolvedValue(
    directoryPath ? { id: 1, directoryPath, userId } : null,
  );
}

describe("files-tap 实现（桌面被控面）", () => {
  it("list：归属 workspace 相对路径清单；非本人/未绑目录 FILES_NO_WORKSPACE", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "face-list-"));
    writeFileSync(path.join(root, "a.ts"), "x");
    bindWorkspace(root);
    const face = createFilesFace();
    expect(await face.list(UID, 1)).toEqual(["a.ts"]);

    bindWorkspace(root, UID + 1);
    await expect(face.list(UID, 1)).rejects.toThrow(FaceFilesError);
    bindWorkspace(null);
    await expect(face.list(UID, 1)).rejects.toThrow("未绑定工作空间目录");
  });

  it("read：文本 ok；越界 FILES_PATH_ESCAPE；守卫 reason 透传", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "face-read-"));
    writeFileSync(path.join(root, "t.txt"), "hi");
    bindWorkspace(root);
    const face = createFilesFace();
    expect(await face.read(UID, 1, "t.txt")).toEqual({ content: "hi" });

    await expect(face.read(UID, 1, "../x")).rejects.toThrow("路径越界");
    writeFileSync(path.join(root, "b.bin"), Buffer.from([0, 1]));
    await expect(face.read(UID, 1, "b.bin")).rejects.toThrow("二进制文件");
    await expect(face.read(UID, 1, "none")).rejects.toThrow("读取失败");
  });

  it("uploadImage：落 TIANSHU_DATA_ROOT 下 attachments/<唯一目录>/<原名>，返回 appDataHome 相对路径", async () => {
    bindWorkspace("/tmp");
    const face = createFilesFace();
    const bytes = Buffer.from([1, 2, 3]);
    const result = await face.uploadImage({
      name: "../../evil.png",
      base64: bytes.toString("base64"),
    });
    // 相对 appDataHome（= <root>/dev，isPackaged=false 分组）——与本地
    // ImageBlock.imagePath/loadImage 回喂基一致（attachments/ 起直平铺）
    expect(result.imagePath).toMatch(/^attachments\/[^/]+\/evil\.png$/);
    expect(result.imagePath).not.toContain("..");
    const abs = path.join(dataRoot, "dev", result.imagePath);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs)).toEqual(bytes);
  });

  it("uploadImage：超 3MB 拒 FILES_IMAGE_TOO_LARGE", async () => {
    bindWorkspace("/tmp");
    const face = createFilesFace();
    const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64");
    await expect(
      face.uploadImage({ name: "p.png", base64: big }),
    ).rejects.toThrow("图片超过 3MB 上限");
  });
});

describe("handleRoute 分发（files 三端点）", () => {
  it("files/list|read|uploadImage 路由注册且信封形状正确", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "face-route-"));
    writeFileSync(path.join(root, "t.txt"), "hi");
    bindWorkspace(root);
    // 最小装配（旧 deps 未设时 faceDeps() 抛——不展开，直接给全集桩）
    setServerFaceDeps({
      resolveUserId: async () => UID,
      files: createFilesFace(),
    } as never);

    const list = await handleRoute("POST", "/files/list", { workspaceId: 1 });
    expect(list.body).toMatchObject({
      code: "2000",
      success: true,
      data: ["t.txt"],
    });

    const read = await handleRoute("POST", "files/read", {
      workspaceId: 1,
      path: "t.txt",
    });
    expect(read.body).toMatchObject({ success: true, data: { content: "hi" } });

    const up = await handleRoute("POST", "/files/uploadImage", {
      name: "p.png",
      base64: Buffer.from("png").toString("base64"),
    });
    expect(up.body).toMatchObject({ success: true });
    expect((up.body as { data: { imagePath: string } }).data.imagePath).toMatch(
      /^attachments\//,
    );

    // 越界 → FILES_PATH_ESCAPE 稳定码（非 5000 兜底）
    const escape = await handleRoute("POST", "/files/read", {
      workspaceId: 1,
      path: "../x",
    });
    expect(escape.body).toMatchObject({
      code: "FILES_PATH_ESCAPE",
      success: false,
    });
  });
});
