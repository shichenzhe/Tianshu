import { describe, expect, it } from "vitest";
import { mergeParams } from "../../electron/domains/ai/chat/param-merge";

describe("三级参数合并", () => {
  it("全部为空返回空对象", () => {
    expect(mergeParams([undefined, undefined, undefined])).toEqual({});
  });

  it("model 层生效", () => {
    expect(mergeParams([{ temperature: 0.3 }])).toEqual({ temperature: 0.3 });
  });

  it("assistant 覆盖 model", () => {
    expect(mergeParams([{ temperature: 0.3 }, { temperature: 0.9 }])).toEqual({
      temperature: 0.9,
    });
  });

  it("request 覆盖 assistant，未覆盖字段保留", () => {
    expect(
      mergeParams([
        { temperature: 0.3, topP: 0.9 },
        { temperature: 0.7 },
        { maxTokens: 2048 },
      ]),
    ).toEqual({ temperature: 0.7, topP: 0.9, maxTokens: 2048 });
  });
});
