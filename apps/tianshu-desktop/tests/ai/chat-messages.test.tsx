// @vitest-environment jsdom
/**
 * ChatMessages（消息区组件，自 ChatPane 拆出）单测（jsdom + testing-library）：
 * - 消息区独立性：MessageList 出现且无输入区（无 textarea/发送按钮）——
 *   发送状态与输入留在组合壳 ChatPane（组合壳行为回归由
 *   chat-view-edit-optimistic.test.tsx 全栈用例保障）
 * - props 透传：session/workspace/editing 与编辑回调原样下发 MessageList
 * - DOM 结构与拆分前一致：外壳/内列类名、children 插槽紧随消息列表
 *   （组合壳注入 AgentProgress + ChatInput 的位置；产物面板已上移至
 *   ChatView 调用方层旁挂，不在本组件）
 * MessageList 以捕获 props 的 stub 替代（避免挂全量 markdown/react-query
 * 渲染管道，骨架参照 chat-view-edit-optimistic.test.tsx）
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { SessionRecord } from "../../src-react/domains/ai/api/session.api";

// MessageList stub：捕获 ChatMessages 透传的 props，占位可定位节点
interface CapturedListProps {
  sessionId: number | null;
  workspaceId?: number | null;
  compactedUpToId?: number | null;
  editing?: { messageId: number; text: string } | null;
  onRegenerate?: (messageId: number) => void;
  onEdit?: (messageId: number) => void;
  onEditSubmit?: (text: string) => void;
  onEditCancel?: () => void;
}
const listProps = vi.hoisted(() => ({
  current: null as CapturedListProps | null,
}));
vi.mock("../../src-react/domains/ai/chat/components/MessageList", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedListProps) => {
      listProps.current = props;
      return createElement("div", { "data-testid": "message-list" });
    },
  };
});

import ChatMessages from "../../src-react/domains/ai/chat/components/ChatMessages";

const SESSION: SessionRecord = {
  id: 7,
  workspaceId: 10,
  title: "拆分会话",
  mode: "agent",
  createdAt: "2026-09-14T09:00:00.000Z",
  updatedAt: "2026-09-14T09:00:00.000Z",
  compactedUpToId: 3,
};

const noop = () => {};

/** 最小可用 props（回调以 noop 兜底，用例按需覆盖；显式 null 不被默认值吞掉） */
function baseProps(
  overrides: {
    workspace?: { id: number } | null;
    editing?: { messageId: number; text: string } | null;
  } = {},
) {
  return {
    session: SESSION,
    workspace:
      overrides.workspace === undefined ? { id: 10 } : overrides.workspace,
    editing: overrides.editing ?? null,
    onRegenerate: noop,
    onEdit: noop,
    onEditSubmit: noop,
    onEditCancel: noop,
  };
}

// vitest 未开 globals，RTL 自动清理不生效，显式清理
afterEach(() => {
  cleanup();
  listProps.current = null;
});

describe("ChatMessages 消息区组件", () => {
  it("渲染消息区（MessageList 出现）且无输入区（无 textarea/发送按钮）", () => {
    render(<ChatMessages {...baseProps()} />);
    expect(screen.getByTestId("message-list")).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("session/workspace/editing 与编辑回调原样透传 MessageList", () => {
    const onRegenerate = vi.fn();
    const onEdit = vi.fn();
    const onEditSubmit = vi.fn();
    const onEditCancel = vi.fn();
    render(
      <ChatMessages
        {...baseProps({ editing: { messageId: 3, text: "待编辑的第二问" } })}
        onRegenerate={onRegenerate}
        onEdit={onEdit}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
      />,
    );
    expect(listProps.current).toMatchObject({
      sessionId: 7,
      workspaceId: 10,
      compactedUpToId: 3,
      editing: { messageId: 3, text: "待编辑的第二问" },
    });
    // 回调引用透传（组合壳接线不被包装重建）
    expect(listProps.current?.onRegenerate).toBe(onRegenerate);
    expect(listProps.current?.onEdit).toBe(onEdit);
    expect(listProps.current?.onEditSubmit).toBe(onEditSubmit);
    expect(listProps.current?.onEditCancel).toBe(onEditCancel);
  });

  it("workspace 为 null 时 MessageList 收 workspaceId=null", () => {
    render(<ChatMessages {...baseProps({ workspace: null })} />);
    expect(listProps.current?.workspaceId).toBeNull();
  });

  it("DOM 结构与拆分前一致：外壳/内列类名、插槽紧随消息列表", () => {
    const { container } = render(
      <ChatMessages {...baseProps()}>
        <div data-testid="bottom-slot" />
      </ChatMessages>,
    );
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toBe("relative flex min-h-0 min-w-0 flex-1");
    const column = outer.firstElementChild as HTMLElement;
    expect(column.className).toBe("flex min-w-0 flex-1 flex-col");
    const list = screen.getByTestId("message-list");
    expect(list.parentElement).toBe(column);
    // children 插槽紧随消息列表（组合壳注入 AgentProgress + ChatInput 的位置）
    expect(list.nextElementSibling).toBe(screen.getByTestId("bottom-slot"));
  });
});
