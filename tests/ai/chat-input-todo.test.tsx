// @vitest-environment jsdom
/**
 * @ 项目待办引用测试（真实 ChatInput 直渲染 + todoItems fixture）：
 * - 输入 `#需` → 联想面板出现标题含『需』的待办项（大小写不敏感过滤）
 * - 选中 → content 含 `#<id> `，pill 镜像层保留 token 原文 + 已引用
 *   chips 行显示映射标题（镜像层 pointer-events-none 悬停不可达）
 * - submit：onSend 收到 PendingFile kind "todo" 且 content 含【待办】摘要
 *   （title/status/priority/dueDate；dueDate 空 → 无；查无 id 的 token 忽略）
 * - 未传 todoItems → # 无联想（AI 模块 ChatPane 回归锚点）
 * - 占位回退：未传 placeholder 时按 hasModel 渲染 chat 默认/modelRequired
 *   （项目底栏无生效模型时不传 placeholder，"未选模型"提示不被压制）
 * mock 骨架同 tests/project/plus-menu-filter.test.tsx：i18n 直返 key、
 * AssistantApi/SkillApi 空列表、PlusMenu/ModelPicker/ContextUsageButton/
 * PermissionCapsule 重依赖子组件 stub（联想/镜像/发送链路与它们无关）
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// localStorage stub：keybindings store 模块加载即读取，Node 环境原生全局
// 会打 ExperimentalWarning，先行替换为内存 stub 消除噪音
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

// i18n mock：t 直接返回 key（断言不依赖具体文案）
vi.mock("@/i18n", () => ({
  default: { t: (key: string) => key },
}));
vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

// 数据源 mock：ChatInput 顶部 useQuery 的 queryFn（联想与技能标签行）
vi.mock("../../src-react/domains/ai/api/assistant.api", () => ({
  default: { list: () => Promise.resolve([]) },
}));
vi.mock("../../src-react/domains/ai/skills/api/skill.api", () => ({
  default: {
    list: () => Promise.resolve([]),
    readSkill: () => Promise.resolve({ content: "" }),
    setEnabled: () => Promise.resolve(undefined),
  },
}));

// 重依赖子组件 stub：与 # 联想/镜像 pill/发送链路无关
vi.mock("../../src-react/domains/ai/chat/components/PlusMenu", () => ({
  default: () => null,
}));
vi.mock("../../src-react/domains/ai/chat/components/ModelPicker", () => ({
  default: () => null,
}));
vi.mock(
  "../../src-react/domains/ai/chat/components/context-usage-button",
  () => ({
    default: () => null,
  }),
);
vi.mock("../../src-react/domains/ai/chat/components/PermissionCapsule", () => ({
  default: () => null,
}));

import ChatInput from "../../src-react/domains/ai/chat/components/ChatInput";
import type { PendingFile } from "../../src-react/domains/ai/chat/lib/pending-file";
import { usePlanAdvanceStore } from "../../src-react/domains/project/store/plan-advance.store";

const TODO_ITEMS = [
  {
    id: 3,
    title: "梳理需求文档",
    status: "todo",
    priority: "high",
    dueDate: "2026-09-20",
    description: "# 目标\n完成 PRD 的需求梳理",
  },
  {
    id: 5,
    title: "写周报",
    status: "doing",
    priority: "low",
    dueDate: "",
  },
];

const onSend = vi.fn(() => Promise.resolve());

/** 渲染真实 ChatInput（todoItems 等可覆盖），返回 textarea 元素 */
function renderInput(
  props: Partial<ComponentProps<typeof ChatInput>> = {},
): HTMLTextAreaElement {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ChatInput
        hasModel
        sending={false}
        sessionId={1}
        accessMode="default"
        currentMode="agent"
        workspaceId={null}
        onOpenMcp={() => undefined}
        onRunCommand={() => undefined}
        onSend={onSend}
        onStop={() => undefined}
        {...props}
      />
    </QueryClientProvider>,
  );
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

/** 输入并显式落光标（handleChange 按 selectionStart 检测触发片段） */
function type(textarea: HTMLTextAreaElement, value: string): void {
  fireEvent.change(textarea, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
}

beforeEach(() => {
  onSend.mockClear();
  usePlanAdvanceStore.setState({ prompt: null });
});
afterEach(cleanup);

describe("@ 待办引用（# 联想）", () => {
  it("输入 #需 → 联想面板出现标题含『需』的待办项", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#需");

    expect(await screen.findByTestId("mention-panel")).toBeTruthy();
    expect(screen.getByText("梳理需求文档")).toBeTruthy();
    expect(screen.queryByText("写周报")).toBeNull();
  });

  it("标题过滤大小写不敏感；无匹配项时面板不出现且 Enter 正常发送", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#梳理");

    expect(await screen.findByText("梳理需求文档")).toBeTruthy();

    type(textarea, "#不存在的词");
    await waitFor(() =>
      expect(screen.queryByTestId("mention-panel")).toBeNull(),
    );
    // 无候选时面板不显示，Enter 不被残留面板劫持、按普通文本发送
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("#不存在的词", []);
  });

  it("选中 → content 含 `#<id> `，pill 镜像层 + 已引用 chips 行出现", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#需");
    const option = await screen.findByText("梳理需求文档");
    fireEvent.mouseDown(option.closest("button"));

    expect(textarea.value).toBe("#3 ");
    // 镜像 pill：正文保留 token 原文（与透明 textarea 逐字符对齐）
    expect(
      within(screen.getByTestId("chat-input-mirror")).getByText("#3"),
    ).toBeTruthy();
    // 已引用 chips 行：映射标题的可见通道（镜像层 pointer-events-none，
    // 标题不能走悬停提示）；chip 显示 todoItems 命中的标题
    const chips = screen.getByTestId("todo-ref-chips");
    expect(within(chips).getByText("梳理需求文档")).toBeTruthy();

    // token 从草稿移除 → chips 行消失
    type(textarea, "没有待办引用了");
    await waitFor(() =>
      expect(screen.queryByTestId("todo-ref-chips")).toBeNull(),
    );
  });

  it("submit：Enter 发送 → onSend 收到 kind todo 的 PendingFile 与【待办】摘要", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#需");
    fireEvent.mouseDown(
      (await screen.findByText("梳理需求文档")).closest("button"),
    );
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // 消息文本保留 token 原样（同 @ 文件/⚡技能口径）；注入块携带待办摘要
    // 与 [描述] 块（AI 推进的内容依据——描述缺省时不附块）
    expect(onSend).toHaveBeenCalledWith("#3", [
      {
        path: "待办#3",
        content:
          "【待办】梳理需求文档｜状态:todo｜优先级:high｜截止:2026-09-20\n[描述]\n# 目标\n完成 PRD 的需求梳理",
        kind: "todo",
      },
    ]);
  });

  it("手输 #5（未走面板）可发送；dueDate 空 → 截止:无；无描述 → 不附 [描述] 块", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#5 请关注");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("#5 请关注", [
      {
        path: "待办#5",
        content: "【待办】写周报｜状态:doing｜优先级:low｜截止:无",
        kind: "todo",
      },
    ]);
  });

  it("查无 id 的 token 忽略（不注入、不报错、不生成 chip、原样留在文本）", async () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    type(textarea, "#99 其他");
    expect(screen.queryByTestId("todo-ref-chips")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("#99 其他", []);
  });

  it("未传 todoItems → # 无联想，Enter 按普通文本发送（AI 模块回归）", async () => {
    const textarea = renderInput();
    type(textarea, "#需");

    expect(screen.queryByTestId("mention-panel")).toBeNull();
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("#需", []);
  });
});

describe("占位回退（未传 placeholder 时按 hasModel 渲染自身文案）", () => {
  it("hasModel=false → 占位渲染 chat:input.modelRequired（未选模型提示不被调用方压制）", () => {
    const textarea = renderInput({ hasModel: false });
    expect(textarea.placeholder).toBe("chat:input.modelRequired");
  });

  it("hasModel=true → 占位渲染 chat 默认文案", () => {
    const textarea = renderInput({ hasModel: true });
    expect(textarea.placeholder).toBe("chat:input.placeholder");
  });
});

describe("#待办引用携带 AI 进展（aiSummary）", () => {
  it("待办带 aiSummary → onSend 的 PendingFile content 含 [进展] 块（末 10 行，首 2 行截去）", async () => {
    // 12 行 aiSummary → 注入块只保留末 10 行（首 2 行排除）
    const lines = Array.from({ length: 12 }, (_, i) => `进展第${i + 1}行`);
    const textarea = renderInput({
      todoItems: [{ ...TODO_ITEMS[0], aiSummary: lines.join("\n") }],
    });
    type(textarea, "#3 请推进");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    const files = onSend.mock.calls[0][1] as PendingFile[];
    expect(files).toEqual([
      {
        path: "待办#3",
        content: `【待办】梳理需求文档｜状态:todo｜优先级:high｜截止:2026-09-20\n[描述]\n# 目标\n完成 PRD 的需求梳理\n[进展]\n${lines
          .slice(2)
          .join("\n")}`,
        kind: "todo",
      },
    ]);
    expect(files[0].content).not.toContain("进展第1行");
    expect(files[0].content).not.toContain("进展第2行");
    expect(files[0].content).toContain("进展第12行");
  });

  it("aiSummary 空串（''=无）→ 无 [进展]（[描述] 块仍在）", async () => {
    const textarea = renderInput({
      todoItems: [{ ...TODO_ITEMS[0], aiSummary: "" }],
    });
    type(textarea, "#3 请推进");
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("#3 请推进", [
      {
        path: "待办#3",
        content:
          "【待办】梳理需求文档｜状态:todo｜优先级:high｜截止:2026-09-20\n[描述]\n# 目标\n完成 PRD 的需求梳理",
        kind: "todo",
      },
    ]);
  });
});

describe("计划推进预填（plan-advance store 运行期消费）", () => {
  it("setPrompt 后 → textarea 值 = prompt 且获焦（读后即清，二次消费为 null）", () => {
    const textarea = renderInput({ todoItems: TODO_ITEMS });
    // 先移开焦点，验证消费动作本身带回焦点（非 autoFocus 残留）——
    // jsdom 的 fireEvent.blur 不迁移 activeElement，需原生 blur()
    textarea.blur();
    expect(document.activeElement).not.toBe(textarea);

    act(() => {
      usePlanAdvanceStore.getState().setPrompt("请推进 #3《梳理需求文档》");
    });

    expect(textarea.value).toBe("请推进 #3《梳理需求文档》");
    expect(document.activeElement).toBe(textarea);
    // 读后即清：store 已清空，二次消费得 null（底栏不重挂也不会重复预填）
    expect(usePlanAdvanceStore.getState().prompt).toBeNull();
    expect(usePlanAdvanceStore.getState().consume()).toBeNull();
  });
});
