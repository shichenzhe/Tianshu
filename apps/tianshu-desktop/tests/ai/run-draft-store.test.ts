/**
 * 按次运行追问草稿（spec 2026-11-23 §2 设计者裁定）：未发送草稿按
 * runId 各自保存——set/get 往返、空串删除条目、FIFO 上限 50（第 51 条
 * 写入淘汰最旧）。模块级 Map 进程内驻留：同文件各用例使用独立 id 段
 * 互不干扰（无 beforeEach 重置入口——消费侧按 runId 天然隔离）。
 */
import { describe, expect, it } from "vitest";

import {
  getRunDraft,
  setRunDraft,
} from "../../src-react/domains/ai/automation/lib/run-draft-store";

describe("run-draft-store", () => {
  it("set/get 往返；未写入的 runId 返回空串", () => {
    expect(getRunDraft(9101)).toBe("");
    setRunDraft(9101, "draft for run 9101");
    expect(getRunDraft(9101)).toBe("draft for run 9101");
    setRunDraft(9101, "updated draft");
    expect(getRunDraft(9101)).toBe("updated draft");
  });

  it('setRunDraft(id, "") 删除条目', () => {
    setRunDraft(9102, "temporary");
    expect(getRunDraft(9102)).toBe("temporary");
    setRunDraft(9102, "");
    expect(getRunDraft(9102)).toBe("");
  });

  it("FIFO 上限 50：第 51 条写入淘汰最旧", () => {
    for (let id = 9200; id < 9200 + 50; id += 1) {
      setRunDraft(id, `draft-${id}`);
    }
    setRunDraft(9299, "the 51st entry");
    expect(getRunDraft(9200)).toBe("");
    expect(getRunDraft(9201)).toBe("draft-9201");
    expect(getRunDraft(9249)).toBe("draft-9249");
    expect(getRunDraft(9299)).toBe("the 51st entry");
  });
});
