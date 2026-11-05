// 重试纯函数（批3A §6-4）：指数退避序列 + classifyError 错误分类的
// 可重试面判定——双端调度器同构消费（桌面/server 经 @tianshu/core 单源）。
import { describe, expect, it } from "vitest";
import {
  isRetryableErrorCode,
  isRetryableRunError,
  nextRetryDelay,
  parseRunErrorCode,
  RETRY_BASE_MS,
  RETRY_MAX_DELAY_MS,
} from "./automation-retry";

describe("nextRetryDelay 指数退避序列", () => {
  it("60/180/540s 三级（attempt = 已失败的那次尝试，冷却后发 attempt+1）", () => {
    expect(nextRetryDelay(1)).toBe(60_000);
    expect(nextRetryDelay(2)).toBe(180_000);
    expect(nextRetryDelay(3)).toBe(540_000);
  });
  it("常量基准：60s × 3^(attempt-1)，封顶 540s", () => {
    expect(RETRY_BASE_MS).toBe(60_000);
    expect(RETRY_MAX_DELAY_MS).toBe(540_000);
    expect(nextRetryDelay(4)).toBe(540_000);
  });
  it("attempt ≤ 1 与非法输入按第 1 级冷却（防御：DB 脏数据不放大延迟）", () => {
    expect(nextRetryDelay(0)).toBe(60_000);
    expect(nextRetryDelay(-3)).toBe(60_000);
    expect(Number.isFinite(nextRetryDelay(Number.NaN))).toBe(true);
  });
});

describe("isRetryableErrorCode 可重试面（classifyError 分类）", () => {
  it("网络/限流/超时/未知 → 重试（瞬时态）", () => {
    expect(isRetryableErrorCode("NETWORK")).toBe(true);
    expect(isRetryableErrorCode("TIMEOUT")).toBe(true);
    expect(isRetryableErrorCode("RATE_LIMITED")).toBe(true);
    expect(isRetryableErrorCode("UNKNOWN")).toBe(true);
  });
  it("配置类（鉴权/模型/多模态不支持）→ 不重试", () => {
    expect(isRetryableErrorCode("AUTH_FAILED")).toBe(false);
    expect(isRetryableErrorCode("MODEL_NOT_FOUND")).toBe(false);
    expect(isRetryableErrorCode("IMAGE_UNSUPPORTED")).toBe(false);
  });
  it("大小写不敏感；未收录码（interrupted/graph_disabled/附件解析等遗留码）默认可重试——保留既有重试行为", () => {
    expect(isRetryableErrorCode("auth_failed")).toBe(false);
    expect(isRetryableErrorCode("network")).toBe(true);
    expect(isRetryableErrorCode("interrupted")).toBe(true);
    expect(isRetryableErrorCode("graph_disabled")).toBe(true);
    expect(isRetryableErrorCode("file_missing")).toBe(true);
    // 空码（无法判定）不拦重试
    expect(isRetryableErrorCode("")).toBe(true);
  });
});

describe("parseRunErrorCode 从 run.error 提取错误码", () => {
  it("prompt 型格式 CODE: message", () => {
    expect(parseRunErrorCode("NETWORK: fetch failed")).toBe("NETWORK");
  });
  it("图运行聚合格式 node:<id> CODE: message（前缀剥离后取码）", () => {
    expect(parseRunErrorCode("node:abc12 AUTH_FAILED: bad key")).toBe(
      "AUTH_FAILED",
    );
  });
  it("裸码（无冒号）整串即码；空/null → 空串", () => {
    expect(parseRunErrorCode("interrupted")).toBe("interrupted");
    expect(parseRunErrorCode(null)).toBe("");
    expect(parseRunErrorCode(undefined)).toBe("");
    expect(parseRunErrorCode("  ")).toBe("");
  });
});

describe("isRetryableRunError run 行错误可重试判定", () => {
  it("网络类 run.error → 重试；配置类 → 不重试", () => {
    expect(isRetryableRunError("RATE_LIMITED: 429 too many requests")).toBe(
      true,
    );
    expect(isRetryableRunError("TIMEOUT: timed out")).toBe(true);
    expect(isRetryableRunError("node:n1 AUTH_FAILED: invalid api key")).toBe(
      false,
    );
    expect(
      isRetryableRunError("node:n2 MODEL_NOT_FOUND: no such model"),
    ).toBe(false);
  });
  it("error 缺席（旧调用面/图禁用等）→ 默认可重试（不放大破坏面）", () => {
    expect(isRetryableRunError(null)).toBe(true);
    expect(isRetryableRunError(undefined)).toBe(true);
  });
});
