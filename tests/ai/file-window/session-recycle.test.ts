/**
 * 空会话回收谓词（T26，spec §15 项 2）：无消息删 / 有消息不删 /
 * 流式中不删（不发查询）/ 查询或删除失败静默。ipc mock 覆盖
 * message:listBySession 与 session:delete；chat.store 真身（isStreaming
 * 门）。纯逻辑无 DOM，node 环境即可（同 file-window-store.test.ts）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../../../src-react/lib/ipc", () => ({ invoke: invokeMock }));

import { recycleIfEmpty } from "../../../src-react/domains/ai/file-window/lib/session-recycle";
import { useChatStore } from "../../../src-react/domains/ai/chat/store/chat.store";

beforeEach(() => {
  invokeMock.mockReset();
  useChatStore.setState({ streams: {}, isStreaming: {} });
});

describe("recycleIfEmpty 空会话回收", () => {
  it("无消息：message:listBySession 空 → session:delete，返回 true", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "message:listBySession"
        ? { items: [], hasMore: false, nextBeforeId: null }
        : Promise.resolve(null),
    );
    await expect(recycleIfEmpty(42)).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("message:listBySession", 42);
    expect(invokeMock).toHaveBeenCalledWith("session:delete", 42);
  });

  it("有消息：不删，返回 false", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "message:listBySession"
        ? {
            items: [
              { id: 1, sessionId: 42, role: "user", blocks: "", createdAt: "" },
            ],
            hasMore: false,
            nextBeforeId: null,
          }
        : Promise.resolve(null),
    );
    await expect(recycleIfEmpty(42)).resolves.toBe(false);
    expect(invokeMock.mock.calls.some((c) => c[0] === "session:delete")).toBe(
      false,
    );
  });

  it("流式中：跳过（不发查询不删），返回 false", async () => {
    useChatStore.setState({ isStreaming: { 42: true } });
    await expect(recycleIfEmpty(42)).resolves.toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("查询失败（会话已被主窗删除等）：静默跳过，返回 false", async () => {
    invokeMock.mockImplementation((ch: string) =>
      ch === "message:listBySession"
        ? Promise.reject(new Error("SESSION_NOT_FOUND"))
        : Promise.resolve(null),
    );
    await expect(recycleIfEmpty(42)).resolves.toBe(false);
    expect(invokeMock.mock.calls.some((c) => c[0] === "session:delete")).toBe(
      false,
    );
  });
});
