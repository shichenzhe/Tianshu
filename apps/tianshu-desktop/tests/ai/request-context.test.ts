// 请求级隐藏系统上下文合并：图 AI 指令/快照只进模型提示，不进用户消息
import { describe, expect, it } from "vitest";
import { mergeRequestSystem } from "../../electron/domains/ai/chat/request-context";

describe("mergeRequestSystem", () => {
  it("请求上下文追加在会话系统提示之后", () => {
    expect(mergeRequestSystem("会话规则", "图指令+快照")).toBe(
      "会话规则\n\n图指令+快照",
    );
  });

  it("无会话系统提示时仍可注入，缺省请求上下文保持原值", () => {
    expect(mergeRequestSystem(undefined, "图指令")).toBe("图指令");
    expect(mergeRequestSystem("会话规则", undefined)).toBe("会话规则");
    expect(mergeRequestSystem(undefined, undefined)).toBeUndefined();
    expect(mergeRequestSystem("会话规则", "")).toBe("会话规则");
  });
});
