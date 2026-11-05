/**
 * runChatStream 瞬态重试与 fallback 备用模型（chat-core §6 项 2 /
 * provider-model §6 项 3，Task 9 批 5）：
 * - 瞬态错误（RATE_LIMITED/NETWORK/TIMEOUT）且流未产出任何可见块 →
 *   退避后同模型重试 1 次；
 * - 配置类错误（AUTH_FAILED/MODEL_NOT_FOUND/IMAGE_UNSUPPORTED）不重试；
 * - 主模型重试后仍失败或配置类失败，且调用方给了 fallbackModel →
 *   切备选再试 1 次；全部失败报最后一次错误并标注 fallbackUsed；
 * - 流中途失败（已有可见块）不重试不 fallback——重试会重复推送内容。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: {
    getPath: vi.fn(() => `/tmp/tianshu-test-user-data-${process.pid}`),
    getAppPath: vi.fn(() => `/tmp/tianshu-test-app-${process.pid}`),
    isPackaged: false,
  },
}));

const prismaStub = {
  messages: [] as Array<unknown>,
};
vi.mock("../../electron/commons/prisma-client", () => ({
  default: {
    message: { findMany: async () => prismaStub.messages },
    user: { findUnique: async () => ({ id: 1 }) },
  },
}));

import { scriptedChatModel } from "./helpers/scripted-chat-model";
import { runChatStream } from "../../electron/domains/ai/chat/chat.service";

const userHistory = [
  {
    role: "user" as const,
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  },
];

/** 429 形态错误（provider SDK status 形状） */
const rateLimited = () =>
  Object.assign(new Error("Rate limit reached"), { status: 429 });
/** 401 形态错误 */
const authFailed = () =>
  Object.assign(new Error("Unauthorized"), { status: 401 });

describe("runChatStream 瞬态重试", () => {
  it("首次 429（零产出）退避后同模型重试成功：无错误码、模型调 2 次、retried 标记", async () => {
    const { model } = scriptedChatModel([
      { steps: [], error: rateLimited() },
      {
        steps: [{ kind: "text", delta: "恢复了" }],
        usage: { input: 3, output: 5 },
      },
    ]);
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.blocks).toEqual([
      { type: "text", text: "恢复了" },
      { type: "usage", input: 3, output: 5 },
    ]);
    expect(model.calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.fallbackUsed).toBeFalsy();
  });

  it("重试仍 429：报最后一次错误、retried 标记、无 fallback 不再尝试", async () => {
    const { model } = scriptedChatModel([
      { steps: [], error: rateLimited() },
      { steps: [], error: rateLimited() },
    ]);
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBe("RATE_LIMITED");
    expect(model.calls).toBe(2);
    expect(result.retried).toBe(true);
    expect(result.fallbackUsed).toBeFalsy();
  });

  it.each([
    authFailed(),
    Object.assign(new Error("model nope"), { status: 404 }),
  ])("配置类错误不重试直报（%s）", async (error) => {
    const { model } = scriptedChatModel([
      { steps: [], error },
      { steps: [{ kind: "text", delta: "不该被调用" }] },
    ]);
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBe(
      (error as { status: number }).status === 401
        ? "AUTH_FAILED"
        : "MODEL_NOT_FOUND",
    );
    expect(model.calls).toBe(1);
    expect(result.retried).toBeFalsy();
  });

  it("流中途失败（已产出文本块）不重试：429 也直报，防重复推送", async () => {
    const { model } = scriptedChatModel([
      {
        steps: [{ kind: "text", delta: "半截" }],
        error: rateLimited(),
      },
      { steps: [{ kind: "text", delta: "不应出现" }] },
    ]);
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBe("RATE_LIMITED");
    expect(result.blocks).toEqual([{ type: "text", text: "半截" }]);
    expect(model.calls).toBe(1);
    expect(result.retried).toBeFalsy();
  });

  it("退避确实发生（delayMs 注入，vi.useFakeTimers 口径外以真实短延时断言）", async () => {
    const { model } = scriptedChatModel([
      { steps: [], error: rateLimited() },
      { steps: [{ kind: "text", delta: "ok" }] },
    ]);
    const startedAt = Date.now();
    await runChatStream({
      model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 60,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(model.calls).toBe(2);
  });
});

describe("runChatStream fallback 备用模型", () => {
  it("主模型重试仍失败 → 切 fallback 一次成功：fallbackUsed 标记、无错误码", async () => {
    const primary = scriptedChatModel([
      { steps: [], error: rateLimited() },
      { steps: [], error: rateLimited() },
    ]);
    const fallback = scriptedChatModel([
      {
        steps: [{ kind: "text", delta: "备胎顶上" }],
        usage: { input: 2, output: 4 },
      },
    ]);
    const result = await runChatStream({
      model: primary.model,
      fallbackModel: fallback.model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.blocks).toEqual([
      { type: "text", text: "备胎顶上" },
      { type: "usage", input: 2, output: 4 },
    ]);
    expect(primary.model.calls).toBe(2);
    expect(fallback.model.calls).toBe(1);
    expect(result.retried).toBe(true);
    expect(result.fallbackUsed).toBe(true);
  });

  it("主模型配置类错误 → 跳过同模型重试直接切 fallback", async () => {
    const primary = scriptedChatModel([{ steps: [], error: authFailed() }]);
    const fallback = scriptedChatModel([
      { steps: [{ kind: "text", delta: "ok" }] },
    ]);
    const result = await runChatStream({
      model: primary.model,
      fallbackModel: fallback.model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBeUndefined();
    expect(primary.model.calls).toBe(1);
    expect(fallback.model.calls).toBe(1);
    expect(result.retried).toBeFalsy();
    expect(result.fallbackUsed).toBe(true);
  });

  it("fallback 也失败：报最后一次（fallback 的）错误 + fallbackUsed 标注", async () => {
    const primary = scriptedChatModel([
      { steps: [], error: rateLimited() },
      { steps: [], error: rateLimited() },
    ]);
    const fallback = scriptedChatModel([{ steps: [], error: authFailed() }]);
    const result = await runChatStream({
      model: primary.model,
      fallbackModel: fallback.model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBe("AUTH_FAILED");
    expect(result.errorMessage).toBe("Unauthorized");
    expect(result.fallbackUsed).toBe(true);
  });

  it("流中途失败不切 fallback（重复内容防线对 fallback 同样生效）", async () => {
    const primary = scriptedChatModel([
      { steps: [{ kind: "text", delta: "半截" }], error: rateLimited() },
    ]);
    const fallback = scriptedChatModel([
      { steps: [{ kind: "text", delta: "不应出现" }] },
    ]);
    const result = await runChatStream({
      model: primary.model,
      fallbackModel: fallback.model,
      history: userHistory,
      params: {},
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBe("RATE_LIMITED");
    expect(fallback.model.calls).toBe(0);
    expect(result.fallbackUsed).toBeFalsy();
  });

  it("无 fallback 配置时行为与既有完全一致（成功路径零变化）", async () => {
    const { model } = scriptedChatModel([
      {
        steps: [{ kind: "text", delta: "正常" }],
        usage: { input: 1, output: 2 },
      },
    ]);
    const result = await runChatStream({
      model,
      history: userHistory,
      params: {},
    });
    expect(result).toEqual({
      blocks: [
        { type: "text", text: "正常" },
        { type: "usage", input: 1, output: 2 },
      ],
    });
  });
});
