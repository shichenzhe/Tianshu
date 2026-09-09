/**
 * 会话动作纯函数测试（Task 15）：
 * - deriveCurrentWorkspaceId：选中任务所属空间 → 第一个空间 → null 三级回退
 * - neighborSessionId：按任务排序（置顶在前/有消息的活跃在前/无消息沉底）
 *   定位后 ±1 移动、边界钳制（不循环）、无选中取首/末、空列表 null
 */
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";
import {
  deriveCurrentWorkspaceId,
  neighborSessionId,
} from "../../src-react/domains/ai/chat/lib/session-actions";

/** 构造最小会话记录（时间字段的字典序即时间序） */
function sessionOf(
  id: number,
  workspaceId: number,
  fields: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    workspaceId,
    title: `task-${id}`,
    mode: "agent",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...fields,
  };
}

/** 工作空间最小记录 */
const workspaceOf = (id: number) => ({ id, name: `ws-${id}` }) as never;

describe("deriveCurrentWorkspaceId", () => {
  const sessions = [sessionOf(1, 10), sessionOf(2, 20), sessionOf(3, 30)];

  it("选中任务所属空间优先", () => {
    expect(deriveCurrentWorkspaceId(sessions, [], 2)).toBe(20);
  });

  it("无选中取第一个空间", () => {
    expect(deriveCurrentWorkspaceId(sessions, [workspaceOf(50)], null)).toBe(
      50,
    );
  });

  it("选中任务不存在（如已删除）回退第一个空间", () => {
    expect(deriveCurrentWorkspaceId(sessions, [workspaceOf(50)], 99)).toBe(50);
  });

  it("无会话且无空间返回 null（不可新建）", () => {
    expect(deriveCurrentWorkspaceId([], [], null)).toBeNull();
  });
});

describe("neighborSessionId", () => {
  it("按展示排序移动：置顶在前、活跃（有消息）按时间倒序、无消息沉底", () => {
    const sessions = [
      sessionOf(1, 10, { lastMessageAt: "2026-01-03T00:00:00Z" }),
      sessionOf(2, 10, { pinnedAt: "2026-01-01T00:00:00Z" }),
      sessionOf(3, 10, { lastMessageAt: "2026-01-05T00:00:00Z" }),
      sessionOf(4, 10), // 从未有消息：沉底
    ];
    // 展示序：2(置顶) → 3(01-05) → 1(01-03) → 4(无消息)
    expect(neighborSessionId(sessions, 2, 1)).toBe(3);
    expect(neighborSessionId(sessions, 3, 1)).toBe(1);
    expect(neighborSessionId(sessions, 1, 1)).toBe(4);
    expect(neighborSessionId(sessions, 3, -1)).toBe(2);
    expect(neighborSessionId(sessions, 1, -1)).toBe(3);
  });

  it("边界钳制不循环：首任务再向上、末任务再向下均返回 null", () => {
    const sessions = [
      sessionOf(1, 10, { lastMessageAt: "2026-01-02T00:00:00Z" }),
      sessionOf(2, 10, { lastMessageAt: "2026-01-03T00:00:00Z" }),
    ];
    // 展示序：2 → 1
    expect(neighborSessionId(sessions, 2, -1)).toBeNull();
    expect(neighborSessionId(sessions, 1, 1)).toBeNull();
  });

  it("当前无选中：向下取首个、向上取末个", () => {
    const sessions = [
      sessionOf(1, 10, { lastMessageAt: "2026-01-02T00:00:00Z" }),
      sessionOf(2, 10, { lastMessageAt: "2026-01-03T00:00:00Z" }),
    ];
    // 展示序：2 → 1
    expect(neighborSessionId(sessions, null, 1)).toBe(2);
    expect(neighborSessionId(sessions, null, -1)).toBe(1);
  });

  it("空列表返回 null", () => {
    expect(neighborSessionId([], null, 1)).toBeNull();
  });
});
