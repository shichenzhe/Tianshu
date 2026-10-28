// 渲染层 files 适配（FA-T3，spec §4）：caps.files 动态推导 + remote-files
// 适配器（filesList/filesRead/filesUpload 端点映射）。
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/ipc", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  on: () => () => {},
}));

const serverApi = vi.hoisted(() => ({
  filesList: vi.fn(),
  filesRead: vi.fn(),
  filesUploadImage: vi.fn(),
  sessionSend: vi.fn(),
}));
vi.mock("../../../src-react/domains/ai/server/api/server.api", () => ({
  default: serverApi,
  requestRemote: vi.fn(),
  LOCAL_CONNECTION_ID: "local",
  newConnectionId: vi.fn(() => "conn-x"),
}));

import { capsOfCapabilities } from "../../../src-react/domains/ai/data-source/host.store";
import * as remoteFiles from "../../../src-react/domains/ai/data-source/remote-files";
import {
  useHostStore,
  LOCAL_HOST_CAPS,
} from "../../../src-react/domains/ai/data-source/host.store";

beforeEach(() => {
  vi.clearAllMocks();
  useHostStore.setState({
    activeHost: { kind: "local" },
    caps: LOCAL_HOST_CAPS,
  });
});

describe("capsOfCapabilities files 动态化", () => {
  it("无 files 能力 → false（旧被控端门控照旧）；有 → true", () => {
    expect(capsOfCapabilities(["chat", "provider"]).files).toBe(false);
    expect(capsOfCapabilities(["chat", "provider", "files"]).files).toBe(true);
  });
});

describe("remote-files 适配器", () => {
  it("list：filesList 直传（workspaceId）", async () => {
    serverApi.filesList.mockResolvedValue(["a.ts", "sub/b.md"]);
    await expect(remoteFiles.list(3, "c1")).resolves.toEqual([
      "a.ts",
      "sub/b.md",
    ]);
    expect(serverApi.filesList).toHaveBeenCalledWith(3, "c1");
  });

  it("read：filesRead 成功映射本地 readExternalFile 形状；错误码映射稳定文案", async () => {
    serverApi.filesRead.mockResolvedValue({ content: "hi" });
    await expect(remoteFiles.read("t.txt", 3, "c1")).resolves.toEqual({
      filePath: "t.txt",
      content: "hi",
    });
    expect(serverApi.filesRead).toHaveBeenCalledWith(3, "t.txt", "c1");

    // FILES_* 码 → 本地同款文案（ChatPane 注入链判据不变）
    const err = Object.assign(new Error("路径越界"), {
      code: "FILES_PATH_ESCAPE",
    });
    serverApi.filesRead.mockRejectedValue(err);
    await expect(remoteFiles.read("../x", 3, "c1")).resolves.toEqual({
      filePath: "../x",
      error: "PATH_OUTSIDE_WORKSPACE",
    });

    const tooLarge = Object.assign(new Error("超过 512KB 上限"), {
      code: "FILES_TOO_LARGE",
    });
    serverApi.filesRead.mockRejectedValue(tooLarge);
    await expect(remoteFiles.read("big.txt", 3, "c1")).resolves.toEqual({
      filePath: "big.txt",
      error: "超过 512KB 上限",
    });
  });

  it("uploadImage：输入直传返回 imagePath", async () => {
    serverApi.filesUploadImage.mockResolvedValue({
      imagePath: "attachments/d1/p.png",
    });
    await expect(
      remoteFiles.uploadImage({ name: "p.png", base64: "aGk=" }, "c1"),
    ).resolves.toEqual({ imagePath: "attachments/d1/p.png" });
    expect(serverApi.filesUploadImage).toHaveBeenCalledWith(
      { name: "p.png", base64: "aGk=" },
      "c1",
    );
  });
});

describe("ChatApi.send 远程 images 链（FA-T3 图片批）", () => {
  it("base64 图逐张 uploadImage → sessionSend.images（远端相对路径）；无 base64 图阻断（裁定 2026-10-21：图片正常才发文本）", async () => {
    const { default: ChatApi } =
      await import("../../../src-react/domains/ai/api/chat.api");
    useHostStore.getState().switchHost({ kind: "remote", connId: "img-c1" });
    serverApi.filesUploadImage.mockImplementation(
      async (input: { name: string }) => ({
        imagePath: `attachments/d1/${input.name}`,
      }),
    );
    serverApi.sessionSend.mockResolvedValue(undefined);

    await ChatApi.send({
      sessionId: 9,
      content: "看图",
      images: [
        { absPath: "/local/a.png", base64: "aGk=" },
        { absPath: "/local/b.jpg", base64: "eW8=" },
      ],
    });

    expect(serverApi.filesUploadImage).toHaveBeenCalledTimes(2);
    expect(serverApi.filesUploadImage).toHaveBeenCalledWith(
      { name: "a.png", base64: "aGk=" },
      "img-c1",
    );
    expect(serverApi.sessionSend).toHaveBeenCalledWith(
      9,
      "看图",
      "img-c1",
      undefined,
      undefined,
      ["attachments/d1/a.png", "attachments/d1/b.jpg"],
    );

    // 无 base64 的图（如资料库图片 pill）：阻断——REMOTE_IMAGE_UNAVAILABLE，
    // 不上传其余图、sessionSend 不发
    serverApi.filesUploadImage.mockClear();
    serverApi.sessionSend.mockClear();
    await expect(
      ChatApi.send({
        sessionId: 9,
        content: "再看",
        images: [
          { absPath: "/local/a.png", base64: "aGk=" },
          { absPath: "/local/no-bytes.png" },
        ],
      }),
    ).rejects.toThrow("REMOTE_IMAGE_UNAVAILABLE");
    expect(serverApi.filesUploadImage).not.toHaveBeenCalled();
    expect(serverApi.sessionSend).not.toHaveBeenCalled();
  });

  it("本地主机：images 载荷原样进 chat:send（零行为变化）", async () => {
    const { default: ChatApi } =
      await import("../../../src-react/domains/ai/api/chat.api");
    const images = [{ absPath: "/local/a.png", base64: "aGk=" }];
    await ChatApi.send({ sessionId: 1, content: "x", images });
    expect(invoke).toHaveBeenCalledWith("chat:send", {
      sessionId: 1,
      content: "x",
      images,
    });
    expect(serverApi.filesUploadImage).not.toHaveBeenCalled();
  });
});
