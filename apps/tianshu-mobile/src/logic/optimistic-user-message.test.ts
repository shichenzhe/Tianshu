import { describe, expect, it } from "vitest";
import { buildOptimisticUserMessage } from "./optimistic-user-message";

/** mirror 无该纯函数独立测试（仅组件级乐观插入测试），按源行为补最小用例 */
describe("buildOptimisticUserMessage", () => {
  it("负数临时 id + user 轮 + 文本块序列化", () => {
    const message = buildOptimisticUserMessage(9, "你好");
    expect(message.id).toBeLessThan(0);
    expect(message.sessionId).toBe(9);
    expect(message.role).toBe("user");
    expect(message.blocks).toBe(JSON.stringify([{ type: "text", text: "你好" }]));
    expect(new Date(message.createdAt).toString()).not.toBe("Invalid Date");
  });

  it("空内容落空块数组（无占位块）", () => {
    expect(buildOptimisticUserMessage(1, "").blocks).toBe("[]");
  });
});
