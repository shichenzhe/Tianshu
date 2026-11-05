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

// ---------- 修复环 Round 1：fallback 按备选自身窗口/参数截断 ----------

/** 长历史夹具：N 对 user/assistant（每条 ~3000 token）+ 末条 user——
 *  131072 窗口全量保留；8192 窗口（预算扣除 maxTokens 预留后）必裁早期消息 */
function longHistory(pairs: number) {
  const big = "字".repeat(6000); // estimateTokens = ceil(len/2) ≈ 3000
  const rows: Array<{ role: "user" | "assistant"; blocks: string }> = [];
  for (let i = 0; i < pairs; i += 1) {
    rows.push({
      role: "user",
      blocks: JSON.stringify([{ type: "text", text: `${i} ${big}` }]),
    });
    rows.push({
      role: "assistant",
      blocks: JSON.stringify([{ type: "text", text: `${i} 答 ${big}` }]),
    });
  }
  rows.push({
    role: "user",
    blocks: JSON.stringify([{ type: "text", text: "hi" }]),
  });
  return rows;
}

describe("fallback 备选自身的窗口与参数（修复环 Round 1）", () => {
  it("plan 形态：备选 attempt 按 contextWindow=8192 截断（主 131072 全量零变化）", async () => {
    const history = longHistory(6); // 13 条消息 ≈ 3.6 万 token
    const primary = scriptedChatModel([
      { steps: [], error: rateLimited() },
      { steps: [], error: rateLimited() },
    ]);
    const fallback = scriptedChatModel([
      { steps: [{ kind: "text", delta: "备选回答" }] },
    ]);
    const result = await runChatStream({
      model: primary.model,
      fallbackModel: {
        chatModel: fallback.model,
        contextWindow: 8192,
        params: { maxTokens: 1024 },
      },
      history,
      contextWindow: 131072,
      params: { maxTokens: 4096 },
      transientRetryDelayMs: 0,
    });
    expect(result.errorCode).toBeUndefined();
    expect(result.fallbackUsed).toBe(true);
    // 主 attempt：131072 窗口全量回喂（零回归证据）
    expect(primary.model.seenInputs[0].length).toBe(history.length);
    // 备选 attempt：8192 窗口预算（-1024 maxTokens 预留 -headroom）必裁早期消息
    const fed = fallback.model.seenInputs[0];
    expect(fed.length).toBeLessThan(history.length);
    expect(fed.length).toBeGreaterThanOrEqual(1); // keep-at-least-one
  });

  it("plan 形态：备选 params 参与截断预算（maxTokens 大→预算小→裁得更多）", async () => {
    const history = longHistory(3);
    const runWithFallbackMaxTokens = async (fbMaxTokens: number) => {
      const primary = scriptedChatModel([
        { steps: [], error: authFailed() }, // 配置类：直接切备选
      ]);
      const fallback = scriptedChatModel([
        { steps: [{ kind: "text", delta: "ok" }] },
      ]);
      await runChatStream({
        model: primary.model,
        fallbackModel: {
          chatModel: fallback.model,
          contextWindow: 16384,
          params: { maxTokens: fbMaxTokens },
        },
        history,
        contextWindow: 131072,
        params: {},
        transientRetryDelayMs: 0,
      });
      return fallback.model.seenInputs[0].length;
    };
    const tight = await runWithFallbackMaxTokens(12288); // 预留大 → 历史预算小
    const loose = await runWithFallbackMaxTokens(1024); // 预留小 → 历史预算大
    expect(tight).toBeLessThan(loose);
  });

  it("简式（裸模型）沿用主 attempt 窗口——兼容形态语义钉死", async () => {
    const history = longHistory(6);
    const primary = scriptedChatModel([{ steps: [], error: authFailed() }]);
    const fallback = scriptedChatModel([
      { steps: [{ kind: "text", delta: "ok" }] },
    ]);
    await runChatStream({
      model: primary.model,
      fallbackModel: fallback.model,
      history,
      contextWindow: 131072,
      params: {},
      transientRetryDelayMs: 0,
    });
    // 主窗口 131072：备选也全量（简式共享主预算——非 plan 不换算）
    expect(fallback.model.seenInputs[0].length).toBe(history.length);
  });
});
