/**
 * truncateMessagesForEdit（编辑重发乐观更新）测试：
 * - 定位：按 messageId 截尾，保留该消息及其之前全部消息
 * - 改写：目标消息 blocks 重写为单一 text 块（生产序列化口径）
 * - messageId 不存在：入参原样返回（防御，不抛错）
 * - 不可变性：入参数组与元素不被修改（返回新数组，未动元素共享原引用）
 */
import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src-react/domains/ai/api/session.api";
import { parseBlocks } from "../../src-react/domains/ai/chat/model/blocks";
import { truncateMessagesForEdit } from "../../src-react/domains/ai/chat/lib/truncate-messages-for-edit";

/** 构造消息记录（blocks 用生产序列化器产出，与落库口径一致） */
function message(
  id: number,
  role: MessageRecord["role"],
  text: string,
): MessageRecord {
  return {
    id,
    sessionId: 1,
    role,
    blocks: JSON.stringify([{ type: "text", text }]),
    createdAt: `2026-09-08T10:0${id}:00.000Z`,
  };
}

/** 典型对话：两条问答，编辑目标是第二条 user 消息 */
function conversation(): MessageRecord[] {
  return [
    message(1, "user", "第一问"),
    message(2, "assistant", "第一答"),
    message(3, "user", "待编辑的第二问"),
    message(4, "assistant", "待删除的第二答"),
  ];
}

describe("truncateMessagesForEdit 定位与裁剪", () => {
  it("保留目标消息及其之前，其后全部移除", () => {
    const result = truncateMessagesForEdit(conversation(), 3, "改后");
    expect(result.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("目标为最后一条消息时无尾部可裁，仅重写文本", () => {
    const list = conversation().slice(0, 2);
    const result = truncateMessagesForEdit(list, 2, "改后");
    expect(result.map((m) => m.id)).toEqual([1, 2]);
  });

  it("目标为首条消息时仅保留其自身", () => {
    const result = truncateMessagesForEdit(conversation(), 1, "改后");
    expect(result.map((m) => m.id)).toEqual([1]);
  });
});

describe("truncateMessagesForEdit 改写", () => {
  it("目标消息 blocks 重写为单一 text 块，前序消息保持原 blocks", () => {
    const list = conversation();
    const result = truncateMessagesForEdit(list, 3, "  改后的文本  ");
    expect(result[2].id).toBe(3);
    expect(parseBlocks(result[2].blocks)).toEqual([
      { type: "text", text: "  改后的文本  " },
    ]);
    // 前序消息原样（含 role/blocks/createdAt 等全部字段）
    expect(result[0]).toBe(list[0]);
    expect(result[1]).toBe(list[1]);
  });

  it("原 blocks 中的 thinking/usage 等多块整体替换为单一 text 块", () => {
    const rich: MessageRecord = {
      ...message(3, "user", "旧文本"),
      blocks: JSON.stringify([
        { type: "text", text: "旧文本" },
        { type: "usage", input: 10, output: 20 },
      ]),
    };
    const result = truncateMessagesForEdit([rich], 3, "新文本");
    expect(parseBlocks(result[0].blocks)).toEqual([
      { type: "text", text: "新文本" },
    ]);
  });
});

describe("truncateMessagesForEdit 防御", () => {
  it("messageId 不存在：入参原样返回（同一引用，不抛错）", () => {
    const list = conversation();
    expect(truncateMessagesForEdit(list, 99, "改后")).toBe(list);
  });

  it("空数组原样返回", () => {
    expect(truncateMessagesForEdit([], 1, "改后")).toEqual([]);
  });
});

describe("truncateMessagesForEdit 不可变性", () => {
  it("入参数组与元素均不被修改", () => {
    const list = conversation();
    const snapshot = JSON.stringify(list);
    truncateMessagesForEdit(list, 3, "改后");
    expect(JSON.stringify(list)).toBe(snapshot);
    expect(list).toHaveLength(4);
    expect(list[2].blocks).toBe(
      JSON.stringify([{ type: "text", text: "待编辑的第二问" }]),
    );
  });
});
