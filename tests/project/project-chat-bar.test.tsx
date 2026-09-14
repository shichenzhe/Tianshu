// @vitest-environment jsdom
/**
 * ProjectChatBar 底栏测试（jsdom + testing-library；mock 骨架同
 * tests/ai/chat-view-edit-optimistic.test.tsx + tests/project/project-workspace.test.tsx，
 * t 直接返回 key）：
 * - ChatInput stub 捕获 props：sessionId=detail.session.id、
 *   workspaceId=detail.assetWorkspaceId、boundAssistantIds/boundSkillNames
 *   过滤（同 ActivityPane 原逻辑——仅 valid 项、技能按 itemName）
 * - placeholder 传 project:chatBar.placeholder（t mock 返回 key）
 * - onSend('hi', []) → ChatApi.send 被调（经 useChatSend 真实例链路）；
 *   文件/技能引用按 ChatPane 同语义注入前缀块
 * - sending（chat.store isStreaming）→ AgentProgress stub 出现/消失
 * ChatApi 模块级 mock（含 onChatStream 空订阅），chat.store 用真实实现
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// localStorage stub：模块加载链上的 store 在 Node 环境访问原生全局会打
// ExperimentalWarning，先行替换为内存 stub 消除噪音
vi.hoisted(() => {
  const memory = new Map<string, string>();
  const stub = {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
    clear: () => memory.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: stub,
    configurable: true,
    writable: true,
  });
});

// i18n mock：t 直接返回 key（工厂内单例——引用稳定，否则 useChatSend 的
// 订阅 effect 因 t 依赖每渲染重建，cleanup 的 finishStream 会立即吞掉
// sending 态）；@/i18n 以最小 stub 替代（mapIpcError 依赖它）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  const t = (key: string) => key;
  return { ...actual, useTranslation: () => ({ t }) };
});

const toastMock = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

// ChatApi mock：send/status/getPermission 等全量替身；onChatStream 返回空
// 卸载函数（useChatSend 真实例挂载时订阅流，隔离真实 IPC）
const chatApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  send: vi.fn(),
  regenerate: vi.fn(),
  editAndResend: vi.fn(),
  stop: vi.fn(),
  compact: vi.fn(),
  getPermission: vi.fn(),
  setPermission: vi.fn(),
}));
vi.mock("@/domains/ai/api/chat.api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domains/ai/api/chat.api")>();
  return {
    ...actual,
    default: chatApiMock,
    onChatStream: () => () => {},
  };
});

// ChatInput stub：捕获 ProjectChatBar 透传的全部 props，附按钮触发 onSend
interface CapturedInputProps {
  hasModel?: boolean;
  sending?: boolean;
  sessionId?: number;
  workspaceId?: number | null;
  boundAssistantIds?: number[];
  boundSkillNames?: string[];
  placeholder?: string;
  onSend: (
    content: string,
    files: Array<{ path: string; content: string; kind?: string }>,
  ) => Promise<void>;
}
const inputProps = vi.hoisted(() => ({
  current: null as CapturedInputProps | null,
}));
vi.mock("@/domains/ai/chat/components/ChatInput", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: CapturedInputProps) => {
      inputProps.current = props;
      return createElement(
        "div",
        { "data-testid": "chat-input-stub" },
        createElement("button", {
          "data-testid": "stub-send",
          onClick: () => void props.onSend("hi", []),
        }),
      );
    },
  };
});

// AgentProgress stub：占位可定位节点（是否渲染由 sending 门控）
const progressProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock("@/domains/ai/chat/components/AgentProgress", async () => {
  const { createElement } = await import("react");
  return {
    default: (props: Record<string, unknown>) => {
      progressProps.current = props;
      return createElement("div", { "data-testid": "agent-progress-stub" });
    },
  };
});

import ProjectChatBar from "../../src-react/domains/project/components/ProjectChatBar";
import { useChatStore } from "../../src-react/domains/ai/chat/store/chat.store";
import type { ProjectDetail } from "../../../electron/domains/project/project.entity";

const SESSION_ID = 11;
const ASSET_WORKSPACE_ID = 30;

const DETAIL: ProjectDetail = {
  project: {
    id: 1,
    name: "alpha",
    systemPrompt: null,
    templateKey: null,
    ownerId: 1,
    sessionId: SESSION_ID,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
  assetWorkspaceId: ASSET_WORKSPACE_ID,
  bindings: [
    {
      id: 101,
      itemType: "assistant",
      itemId: 1,
      itemName: "专家A",
      valid: true,
    },
    {
      id: 102,
      itemType: "assistant",
      itemId: 2,
      itemName: "已删专家",
      valid: false,
    },
    {
      id: 103,
      itemType: "skill",
      itemId: 3,
      itemName: "联网搜索",
      valid: true,
    },
    {
      id: 104,
      itemType: "skill",
      itemId: 4,
      itemName: "已删技能",
      valid: false,
    },
  ],
  session: {
    id: SESSION_ID,
    workspaceId: ASSET_WORKSPACE_ID,
    title: "alpha",
    mode: "agent",
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
  },
};

function renderBar() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProjectChatBar detail={DETAIL} onOpenSettings={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  chatApiMock.getPermission.mockReset().mockResolvedValue("default");
  chatApiMock.setPermission.mockReset().mockResolvedValue(undefined);
  chatApiMock.send.mockReset().mockResolvedValue(undefined);
  chatApiMock.status.mockReset().mockResolvedValue({
    streaming: false,
    accessMode: "default",
    text: "",
    thinking: "",
    tools: { order: [], map: {} },
  });
  inputProps.current = null;
  progressProps.current = null;
});

// vitest 未开 globals，RTL 自动清理不生效，显式清理；流式标记防跨用例泄漏
afterEach(() => {
  cleanup();
  useChatStore.getState().finishStream(SESSION_ID);
});

describe("ProjectChatBar 底栏", () => {
  it("渲染 ChatInput 并传入 sessionId/workspaceId 与 valid 过滤后的能力集", async () => {
    renderBar();
    expect(await screen.findByTestId("chat-input-stub")).toBeTruthy();

    // 会话/资产空间接线：sessionId=session.id，workspaceId=assetWorkspaceId
    expect(inputProps.current).toMatchObject({
      sessionId: SESSION_ID,
      workspaceId: ASSET_WORKSPACE_ID,
      hasModel: false,
      sending: false,
    });
    // 失效挂载不下发（同 ActivityPane 原逻辑）；技能以 itemName 匹配
    expect(inputProps.current?.boundAssistantIds).toEqual([1]);
    expect(inputProps.current?.boundSkillNames).toEqual(["联网搜索"]);
    // 权限态初始化（自 ChatPane 复制的 getPermission effect）
    expect(chatApiMock.getPermission).toHaveBeenCalledWith(SESSION_ID);
  });

  it("placeholder 传 project:chatBar.placeholder 文案 key", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    expect(inputProps.current?.placeholder).toBe("project:chatBar.placeholder");
  });

  it("onSend('hi', []) → ChatApi.send；文件/技能引用按 ChatPane 语义注入前缀块", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    fireEvent.click(screen.getByTestId("stub-send"));
    await waitFor(() =>
      expect(chatApiMock.send).toHaveBeenCalledWith({
        sessionId: SESSION_ID,
        content: "hi",
        modelId: undefined,
        overrides: undefined,
      }),
    );

    // 文件引用前缀注入语义（自 ChatPane 复制）：逐文件前缀块 + 原输入
    await act(async () => {
      await inputProps.current?.onSend("正文", [
        { path: "docs/a.md", content: "AAA" },
        { path: "联网搜索", content: "BBB", kind: "skill" },
      ]);
    });
    expect(chatApiMock.send).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      content: "[引用文件 docs/a.md]\nAAA\n\n[引用技能 联网搜索]\nBBB\n\n正文",
      modelId: undefined,
      overrides: undefined,
    });
  });

  it("sending 时 AgentProgress 出现，流结束消失", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");
    expect(screen.queryByTestId("agent-progress-stub")).toBeNull();

    act(() => {
      useChatStore.getState().startStream(SESSION_ID);
    });
    expect(screen.getByTestId("agent-progress-stub")).toBeTruthy();

    act(() => {
      useChatStore.getState().finishStream(SESSION_ID);
    });
    expect(screen.queryByTestId("agent-progress-stub")).toBeNull();
  });
});
