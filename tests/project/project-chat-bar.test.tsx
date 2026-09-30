// @vitest-environment jsdom
/**
 * ProjectChatBar 快速发起条测试（批 3 一期会话统一 D3；jsdom +
 * testing-library；mock 骨架同 tests/ai/chat-view-edit-optimistic.test.tsx +
 * tests/project/project-workspace.test.tsx，t 直接返回 key）：
 * - ChatInput stub 捕获 props：sessionId=detail.session.id、
 *   workspaceId=detail.assetWorkspaceId（能力不做挂载过滤——预设≠围墙）
 * - placeholder 有生效模型传 project:chatBar.placeholder、无模型不传
 * - 发送受理即跳转 /module/ai?session=<id>（不等流结束——chat:send 至流末
 *   才 resolve；sendVersions 机制已随 ActivityPane 删除移除，批 6 清理）
 * - 计划缓存失效改一次性流结束监听（finish/error chunk 失效并自解绑）——
 *   替代原 prevSendingRef effect（跳转卸载后组件 effect 不可观测）
 * - 发送失败 → toast 兜底恰一次 + rethrow（ChatInput void catch 链）
 * - AgentProgress 与审批横幅不再渲染（mock/store 预置探测，防回归）
 * ChatApi 模块级 mock（onChatStream 捕获监听可发 chunk），chat.store 真实实现
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
import { MemoryRouter, useLocation } from "react-router-dom";

/** 位置探针：读取当前 pathname+search（跳转断言用） */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">{`${location.pathname}${location.search}`}</div>
  );
}

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

// onChatStream 监听捕获：按 sessionId 多监听共存（组件 useChatSend 实例与
// 发送时挂的计划缓存失效监听各一份），emit 模拟主进程推 chunk
const streamMock = vi.hoisted(() => {
  const listeners = new Map<number, Set<(chunk: unknown) => void>>();
  return {
    listeners,
    emit: (sessionId: number, chunk: unknown) => {
      for (const listener of listeners.get(sessionId) ?? []) {
        listener(chunk);
      }
    },
  };
});

// ChatApi mock：send/status/getPermission 等全量替身
const chatApiMock = vi.hoisted(() => ({
  status: vi.fn(),
  send: vi.fn(),
  regenerate: vi.fn(),
  editAndResend: vi.fn(),
  stop: vi.fn(),
  compact: vi.fn(),
  getPermission: vi.fn(),
  setPermission: vi.fn(),
  approveToolCall: vi.fn(),
  rememberTool: vi.fn(),
}));
vi.mock("@/domains/ai/api/chat.api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/domains/ai/api/chat.api")>();
  return {
    ...actual,
    default: chatApiMock,
    onChatStream: (sessionId: number, listener: (chunk: unknown) => void) => {
      const set = streamMock.listeners.get(sessionId) ?? new Set();
      set.add(listener);
      streamMock.listeners.set(sessionId, set);
      return () => {
        set.delete(listener);
      };
    },
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
  localTask?: {
    enabled: boolean;
    label: string;
    onToggle: (next: boolean) => void;
  };
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

// AgentProgress stub：组件已不引用（快速发起删进度块）——保留 mock 作
// 回归探测：若未来重新引入渲染，stub 节点会出现在断言中
vi.mock("@/domains/ai/chat/components/AgentProgress", async () => {
  const { createElement } = await import("react");
  return {
    default: () =>
      createElement("div", { "data-testid": "agent-progress-stub" }),
  };
});

import ProjectChatBar from "../../src-react/domains/project/components/ProjectChatBar";
import { useChatStore } from "../../src-react/domains/ai/chat/store/chat.store";
import { useUserStore } from "../../src-react/domains/user/store/user.store";
import {
  PLAN_ITEMS_KEY,
  PLAN_ITEMS_MINE_KEY,
} from "@/domains/project/api/plan-item.api";
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

function renderBar(detail: ProjectDetail = DETAIL) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={["/module/project/1?tab=plan"]}>
        <LocationProbe />
        <ProjectChatBar detail={detail} onOpenSettings={() => {}} />
      </MemoryRouter>
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
  streamMock.listeners.clear();
});

// vitest 未开 globals，RTL 自动清理不生效，显式清理；流式标记防跨用例泄漏
afterEach(() => {
  cleanup();
  useChatStore.getState().finishStream(SESSION_ID);
});

describe("ProjectChatBar 快速发起条", () => {
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
    // 能力不做挂载过滤（§3.7 修正：挂载集是预设而非过滤边界）
    expect(inputProps.current?.boundAssistantIds).toBeUndefined();
    expect(inputProps.current?.boundSkillNames).toBeUndefined();
    // 权限态初始化（自 ChatPane 复制的 getPermission effect）
    expect(chatApiMock.getPermission).toHaveBeenCalledWith(SESSION_ID);
  });

  it("placeholder：有生效模型传 project:chatBar.placeholder，无模型不传（ChatInput 回退 modelRequired 提示）", async () => {
    // 有生效模型：项目占位文案生效
    renderBar({
      ...DETAIL,
      session: { ...DETAIL.session, currentModelId: 7 },
    });
    await screen.findByTestId("chat-input-stub");
    expect(inputProps.current?.placeholder).toBe("project:chatBar.placeholder");
    cleanup();

    // 无生效模型：不传项目文案（undefined）——ChatInput 自身按
    // placeholder ?? t(hasModel ? chat:input.placeholder
    //   : chat:input.modelRequired) 回退"未选模型"提示，项目文案不得
    // 压制该引导（modelRequired 渲染断言见 chat-input-todo.test.tsx）
    renderBar();
    await screen.findByTestId("chat-input-stub");
    expect(inputProps.current?.hasModel).toBe(false);
    expect(inputProps.current?.placeholder).toBeUndefined();
  });

  it("发送受理即跳转 /module/ai?session=<id>（不等流结束，chat:send 至流末才 resolve）", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    // send 以未决 promise 模拟流未结束（chat:send 至流末才 resolve），
    // navigate 应在受理时即发生——不受流时长影响
    let resolveSend: () => void = () => {};
    chatApiMock.send.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveSend = resolve;
      }),
    );
    fireEvent.click(screen.getByTestId("stub-send"));

    // 跳转先于流结束发生（此时 send 尚未 resolve）
    expect(screen.getByTestId("location").textContent).toBe(
      `/module/ai?session=${SESSION_ID}`,
    );

    // 流结束（send resolve）不产生其他副作用（sendVersions 机制已随
    // ActivityPane 删除移除，批 6 清理）
    await act(async () => {
      resolveSend();
    });
  });

  it("流结束监听失效计划缓存（finish chunk → 双失效并自解绑，跨卸载存活）", async () => {
    useUserStore.setState({
      user: { ...useUserStore.getState().user, id: 1 },
    });
    renderBar();
    await screen.findByTestId("chat-input-stub");
    const invalidateSpy = vi.spyOn(QueryClient.prototype, "invalidateQueries");

    fireEvent.click(screen.getByTestId("stub-send"));
    await waitFor(() => expect(chatApiMock.send).toHaveBeenCalled());
    invalidateSpy.mockClear();

    // finish chunk（模拟主进程流结束推送，此时组件可能已随跳转卸载）
    act(() => {
      streamMock.emit(SESSION_ID, { type: "finish" });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: PLAN_ITEMS_KEY(DETAIL.project.id),
      });
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: PLAN_ITEMS_MINE_KEY(1),
      });
    });
    // 自解绑：再次 finish 不重复失效
    invalidateSpy.mockClear();
    act(() => {
      streamMock.emit(SESSION_ID, { type: "finish" });
    });
    await act(async () => {});
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: PLAN_ITEMS_KEY(DETAIL.project.id),
    });
  });

  it("发送失败 → toast 兜底恰一次且 rethrow（ChatInput catch 链，批 6 后无版本断言）", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    chatApiMock.send.mockRejectedValueOnce(new Error("no model"));
    let rejected = false;
    await act(async () => {
      await inputProps.current?.onSend("再试", []).catch(() => {
        rejected = true;
      });
    });
    expect(rejected).toBe(true);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
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

  it("AgentProgress 不再渲染（流式中也不出现——进度由 ChatView ChatPane 承载）", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");
    expect(screen.queryByTestId("agent-progress-stub")).toBeNull();

    act(() => {
      useChatStore.getState().startStream(SESSION_ID);
    });
    expect(screen.queryByTestId("agent-progress-stub")).toBeNull();
  });

  it("审批横幅不再渲染（挂起审批工具在输入区上方无横幅——审批由 ChatView ChatPane 承载）", async () => {
    // store 预置挂起审批的工具流（原 approval-request chunk 的终态形状）
    useChatStore.setState({
      streams: {
        [SESSION_ID]: {
          text: "",
          thinking: "",
          tools: {
            order: ["tc1"],
            map: {
              tc1: {
                toolName: "plan_update_status",
                state: "awaiting-approval",
                argSummary: "更新任务 #3 状态为进行中",
              },
            },
          },
        },
      },
    });
    renderBar();
    await screen.findByTestId("chat-input-stub");

    expect(screen.queryByText("更新任务 #3 状态为进行中")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "project:chatBar.viewContext" }),
    ).toBeNull();
  });

  it("本地任务开关默认关闭并透传 ChatInput（label 为 project:chatBar.localTask）；关闭发送 content 无 [用户要求]", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    // 开关接线：默认 enabled=false，label 用 project 域文案 key
    expect(inputProps.current?.localTask).toMatchObject({
      enabled: false,
      label: "project:chatBar.localTask",
    });

    fireEvent.click(screen.getByTestId("stub-send"));
    await waitFor(() => expect(chatApiMock.send).toHaveBeenCalled());
    const content = chatApiMock.send.mock.calls[0]?.[0]?.content;
    expect(content).toBe("hi");
    expect(content).not.toContain("[用户要求]");
  });

  it("开关开启（onToggle(true)）→ 发送 content 末尾追加本地任务指令", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    act(() => {
      inputProps.current?.localTask?.onToggle(true);
    });
    fireEvent.click(screen.getByTestId("stub-send"));
    await waitFor(() => expect(chatApiMock.send).toHaveBeenCalled());

    const content = chatApiMock.send.mock.calls[0]?.[0]?.content;
    expect(content).toBe(
      "hi\n\n[用户要求] 本次创建或更新的待办事项请存储为本地任务（projectId 置空，不出现在项目计划中）。",
    );
  });

  it("todo 引用文件用专属前缀 [引用待办 待办#N]（T7 收尾：不复用 [引用文件]）", async () => {
    renderBar();
    await screen.findByTestId("chat-input-stub");

    await act(async () => {
      await inputProps.current?.onSend("正文", [
        { path: "待办#5", content: "【待办】调研｜状态:待开始", kind: "todo" },
      ]);
    });
    expect(chatApiMock.send).toHaveBeenLastCalledWith({
      sessionId: SESSION_ID,
      content: "[引用待办 待办#5]\n【待办】调研｜状态:待开始\n\n正文",
      modelId: undefined,
      overrides: undefined,
    });
  });
});
