/**
 * 聊天输出导出批 IPC handler 单测（chat.service 尾部两通道，照
 * chat.service.test.ts 的 SP6 handler 注册断言先例：electron 全 mock、
 * prisma-client 桩，ipcMain.handle 取该通道最新注册的 handler 直调）：
 * - file:saveDataUrl：取消 → null；确认 → saveImageDataUrl 写盘并回路径；
 *   非字符串入参 → IMAGE_DATAURL_INVALID；默认名经 sanitizeSaveName 清洗
 *   （目录剥离 + mime 扩展强制改写）后进保存对话框 defaultPath
 * - widget:capture：合法 rect → event.sender.capturePage（取整）→
 *   toDataURL 回传；非法 rect → WIDGET_CAPTURE_RECT_INVALID
 */
import { beforeAll, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showSaveDialog: vi.fn() },
  clipboard: { read: vi.fn() },
  shell: {},
  // Log/prisma-client 顶层读取 app.getPath（data-root 冷迁移链路）
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

vi.mock("../../../electron/commons/prisma-client", () => ({ default: {} }));

// 写盘纯函数 mock（真实写盘已在 media-export.test.ts 覆盖；此处断言接线
// 传参即可，parse/sanitize 保留真身——defaultPath 清洗断言依赖真实现）
const saveImageDataUrlMock = vi.hoisted(() => vi.fn());
vi.mock(
  "../../../electron/domains/ai/chat/media-export",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../electron/domains/ai/chat/media-export")
      >();
    return { ...actual, saveImageDataUrl: saveImageDataUrlMock };
  },
);

import { dialog, ipcMain } from "electron";
import { generateUserToken } from "../../../electron/commons/ipc-user";
import ChatService from "../../../electron/domains/ai/chat/chat.service";

const TOKEN = generateUserToken({ id: 1, username: "tester" });
const DATA_URL = `data:image/png;base64,${Buffer.from("fakepng").toString("base64")}`;
const showSaveDialog = dialog.showSaveDialog as unknown as Mock;

/** 该通道最近一次注册的 handler（对应本测试刚构造的 service） */
const handlerOf = (channel: string) => {
  const calls = (ipcMain.handle as unknown as Mock).mock.calls.filter(
    ([name]) => name === channel,
  );
  const latest = calls[calls.length - 1];
  if (!latest) {
    throw new Error(`IPC 未注册: ${channel}`);
  }
  return latest[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
};

beforeAll(() => {
  // registerHandlers 只在 handler 体内触 sessions，构造期无 IO
  new ChatService({} as never);
});

describe("file:saveDataUrl handler", () => {
  it("用户取消 → null（不写盘）", async () => {
    showSaveDialog.mockResolvedValueOnce({
      canceled: true,
      filePath: undefined,
    });
    const result = await handlerOf("file:saveDataUrl")(
      null,
      DATA_URL,
      "chart.png",
      TOKEN,
    );
    expect(result).toBeNull();
    expect(saveImageDataUrlMock).not.toHaveBeenCalled();
  });

  it("确认 → saveImageDataUrl 写盘并回传最终路径", async () => {
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "/tmp/out/chosen.png",
    });
    saveImageDataUrlMock.mockResolvedValueOnce("/tmp/out/chosen.png");
    const result = await handlerOf("file:saveDataUrl")(
      null,
      DATA_URL,
      "chart.png",
      TOKEN,
    );
    expect(result).toBe("/tmp/out/chosen.png");
    expect(saveImageDataUrlMock).toHaveBeenCalledWith(
      DATA_URL,
      "/tmp/out/chosen.png",
    );
  });

  it("默认名经 sanitizeSaveName 清洗进 defaultPath（目录剥离 + mime 扩展强制）", async () => {
    showSaveDialog.mockClear();
    showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await handlerOf("file:saveDataUrl")(
      null,
      DATA_URL,
      "../../chart.jpeg",
      TOKEN,
    );
    expect(showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "chart.png" }),
    );
  });

  it("非字符串入参 → IMAGE_DATAURL_INVALID（弹窗都不出）", async () => {
    showSaveDialog.mockClear();
    const handler = handlerOf("file:saveDataUrl");
    await expect(handler(null, 123, "chart.png", TOKEN)).rejects.toThrow(
      "IMAGE_DATAURL_INVALID",
    );
    await expect(handler(null, DATA_URL, null, TOKEN)).rejects.toThrow(
      "IMAGE_DATAURL_INVALID",
    );
    expect(showSaveDialog).not.toHaveBeenCalled();
  });
});

describe("widget:capture handler", () => {
  it("合法 rect → event.sender.capturePage 取整截屏并回 dataUrl", async () => {
    const capturePage = vi.fn(async () => ({
      toDataURL: () => "data:image/png;base64,QUJD",
    }));
    const result = await handlerOf("widget:capture")(
      { sender: { capturePage } },
      { x: 10.4, y: 20.7, width: 300.5, height: 99.9 },
      TOKEN,
    );
    expect(result).toBe("data:image/png;base64,QUJD");
    expect(capturePage).toHaveBeenCalledWith({
      x: 10.4,
      y: 20.7,
      width: 301,
      height: 100,
    });
  });

  it("非法 rect（缺字段 / 非有限数 / 非正宽高）→ WIDGET_CAPTURE_RECT_INVALID", async () => {
    const handler = handlerOf("widget:capture");
    for (const rect of [
      null,
      {},
      { x: 0, y: 0, width: 100 },
      { x: Number.NaN, y: 0, width: 100, height: 100 },
      { x: 0, y: 0, width: 0, height: 100 },
      { x: 0, y: 0, width: 100, height: -5 },
    ]) {
      await expect(
        handler({ sender: { capturePage: vi.fn() } }, rect, TOKEN),
      ).rejects.toThrow("WIDGET_CAPTURE_RECT_INVALID");
    }
  });
});
