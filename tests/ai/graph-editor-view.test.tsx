// tests/ai/graph-editor-view.test.tsx
// @vitest-environment jsdom
/**
 * 图编辑器静态冒烟（画布主模式，Task 3）：new 态默认画布模式（画布工具
 * 钮 + 右侧图级属性面板 + 校验清单收起为摘要行、保存钮不再因校验禁用）、添加 AI 节点出 node-2 且
 * 自动选中（属性面板出现节点字段）、点画布节点切换面板选中、canvas⇄json
 * 切换双向同步；另守护 create 保存时序——缓存失效（重拉）完成后才
 * navigate，防路由切换瞬间列表缓存无新行闪现「图不存在」错误态。重依赖
 * mock 掉（先例 tests/ai/new-task-toolbars.test.tsx；jsdom 缺
 * ResizeObserver/DOMMatrixReadOnly，同 tests/ai/graph-canvas.test.tsx 补桩）。
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const { invokeMock, navigateMock, invalidateMock, locationState } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    navigateMock: vi.fn(),
    invalidateMock: vi.fn(async () => {}),
    locationState: { current: null as unknown },
  }),
);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/ipc", () => ({
  invoke: invokeMock,
  // T14：GraphRunHistoryDialog 双通道事件订阅（graphs/tasks-changed）
  on: () => () => {},
}));
vi.mock("@/components/layout/page-header.store", () => ({
  usePageHeader: () => {},
}));
vi.mock("@/domains/ai/orchestration/views/GraphListView", () => ({
  useGraphs: () => ({ data: [], isLoading: false }),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useLocation: () => ({
    state: locationState.current,
    pathname: "/module/ai/graphs/new",
  }),
  useParams: () => ({ id: "new" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "providers") {
      return { data: [{ id: 1, name: "P1" }] };
    }
    if (queryKey[0] === "models") {
      return {
        data: [
          { id: 11, name: "M1", modelId: "m-1", providerId: 1, enabled: true },
        ],
      };
    }
    return { data: [] };
  },
  useQueryClient: () => ({ invalidateQueries: invalidateMock }),
}));

import GraphEditorView from "@/domains/ai/orchestration/views/GraphEditorView";
import { toast } from "sonner";

/** 合法双节点模板（modelId 为真实可用值，模板预填后即可直接保存） */
const validTemplateGraph = {
  version: 1,
  inputSchema: { topic: "string" },
  nodes: [
    {
      id: "collect",
      name: "收集",
      kind: "llm",
      modelId: 1,
      prompt: "收集 {{input.topic}}",
      tools: false,
      outputMode: "text",
    },
    {
      id: "report",
      name: "成文",
      kind: "llm",
      modelId: 1,
      prompt: "成文",
      tools: false,
      outputMode: "text",
    },
  ],
  edges: [
    { from: "collect", to: "report" },
    { from: "report", to: "END" },
  ],
};

const savedRecord = {
  id: 42,
  name: "tpl.title",
  graphJson: JSON.stringify(validTemplateGraph),
  version: 1,
  enabled: true,
  createdAt: "",
  updatedAt: "",
  nodeCount: 2,
};

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "chat:orchestration.editor.save",
  }) as HTMLButtonElement;
}

beforeAll(() => {
  // React Flow 节点量测依赖（先例 tests/ai/graph-canvas.test.tsx）
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("DOMMatrixReadOnly", class {});
});

afterEach(() => {
  locationState.current = null;
  // 模板预填快照跨测试清空（readTemplatePrefill 命中即删，防串场）
  sessionStorage.removeItem("tianshu:graph-template-prefill");
  invokeMock.mockReset();
  navigateMock.mockReset();
  invalidateMock.mockReset();
  invalidateMock.mockImplementation(async () => {});
});

describe("GraphEditorView 静态冒烟（画布主模式）", () => {
  it("new 态默认画布模式：画布工具钮 + 图级属性面板 + 校验清单收起为摘要行", () => {
    render(<GraphEditorView />);
    expect(
      screen.getByText("chat:orchestration.editor.modeCanvas"),
    ).toBeTruthy();
    // 添加节点入口为 Coze 式「+」主按钮（旧快捷钮已移除）
    expect(screen.getByText("chat:orchestration.editor.addNode")).toBeTruthy();
    expect(
      screen.queryByText("chat:orchestration.editor.addLlmNode"),
    ).toBeNull();
    // 未选中 → 右侧面板图级分支（图属性/名称；输入变量编辑已迁 start 节点）
    expect(
      screen.getByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.editor.nameLabel"),
    ).toBeTruthy();
    expect(
      screen.queryByText("chat:orchestration.editor.variablesLabel"),
    ).toBeNull();
    // 校验清单默认收起：仅摘要行常驻（key mock 直显，含 count 插值）；
    // 摘要行存在即证明空图的 schema 问题被检出（具体文案随清单收起）
    expect(
      screen.getByText("chat:orchestration.editor.issuesSummary"),
    ).toBeTruthy();
    expect(
      screen.queryByText("chat:orchestration.editor.issuesTitle"),
    ).toBeNull();
    // 校验问题不再禁用保存钮（点击时 toast 拦截，见下方专项用例）；
    // 空图草稿相对空基线已视为有变更 → 可点
    expect(saveButton().disabled).toBe(false);
  });

  it("画布添加 AI 节点出 node-2 并自动选中：面板出现节点字段；点 node-1 切换选中", () => {
    render(<GraphEditorView />);
    // 打开 Coze 式添加面板 → 点「AI」节点项（kind 名文案定位）
    fireEvent.click(screen.getByText("chat:orchestration.editor.addNode"));
    fireEvent.click(screen.getByText("chat:orchestration.editor.kindLlm"));
    // 自动选中新节点 → 面板节点分支（id Badge + 名称/提示词等字段标签）
    expect(screen.getByText("node-2")).toBeTruthy();
    expect(screen.getByText("chat:orchestration.editor.nodeName")).toBeTruthy();
    expect(screen.getByText("chat:orchestration.editor.prompt")).toBeTruthy();

    // 点画布上的 node-1 卡片（RF 节点壳 data-id）→ 面板切到该节点
    const nodeCard = document.querySelector('[data-id="node-1"]');
    expect(nodeCard).toBeTruthy();
    fireEvent.click(nodeCard as HTMLElement);
    expect(screen.getByText("node-1")).toBeTruthy();
    expect(screen.getByText("chat:orchestration.editor.nodeName")).toBeTruthy();
  });

  it("canvas⇄json 切换双向同步：新增节点序列化进源码；合法图往返切回画布", () => {
    // 其一：画布新增节点经切换序列化进 JSON 源码
    const { unmount } = render(<GraphEditorView />);
    fireEvent.click(screen.getByText("chat:orchestration.editor.addNode"));
    fireEvent.click(screen.getByText("chat:orchestration.editor.kindLlm"));
    fireEvent.click(screen.getByText("chat:orchestration.editor.modeJson"));
    const jsonBox = screen
      .getAllByRole("textbox")
      .find((el) => (el as HTMLTextAreaElement).value.includes('"node-1"'));
    expect(jsonBox).toBeTruthy();
    expect((jsonBox as HTMLTextAreaElement).value).toContain('"node-2"');
    unmount();

    // 其二：合法图（模板预填）json → canvas 往返。空名节点按 parseOrKeep
    // 门禁禁切回（JSON 须过图 schema——既有语义，见 modeJson 切换钮禁用）
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: validTemplateGraph,
      },
    };
    render(<GraphEditorView />);
    fireEvent.click(screen.getByText("chat:orchestration.editor.modeJson"));
    const templateBox = screen
      .getAllByRole("textbox")
      .find((el) => (el as HTMLTextAreaElement).value.includes('"collect"'));
    expect(templateBox).toBeTruthy();
    fireEvent.click(screen.getByText("chat:orchestration.editor.modeCanvas"));
    // 切回画布：添加节点主按钮回归，未选中态图级面板可见
    expect(screen.getByText("chat:orchestration.editor.addNode")).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeTruthy();
  });
});

describe("GraphEditorView 属性面板三态", () => {
  it("默认浮动态；收缩 → 把手常驻、面板隐藏；点把手回浮动", () => {
    render(<GraphEditorView />);
    // 默认 float：白底浮动卡片承载图级面板
    expect(document.querySelector('[data-panel-state="float"]')).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeTruthy();

    // 收缩：面板整体隐藏，右缘把手（展开钮）常驻
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:orchestration.editor.panelCollapse",
      }),
    );
    expect(document.querySelector("[data-panel-state]")).toBeNull();
    expect(
      screen.queryByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeNull();
    const expandHandle = screen.getByRole("button", {
      name: "chat:orchestration.editor.panelExpand",
    });
    expect(expandHandle).toBeTruthy();

    // 把手点开 → 回浮动
    fireEvent.click(expandHandle);
    expect(document.querySelector('[data-panel-state="float"]')).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeTruthy();
  });

  it("平铺 ↔ 还原浮动：data-panel-state 随钮切换", () => {
    render(<GraphEditorView />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:orchestration.editor.panelTile",
      }),
    );
    expect(document.querySelector('[data-panel-state="full"]')).toBeTruthy();
    // 平铺态仍有面板内容与收缩入口
    expect(
      screen.getByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "chat:orchestration.editor.panelFloat",
      }),
    );
    expect(document.querySelector('[data-panel-state="float"]')).toBeTruthy();
  });
});

describe("GraphEditorView 校验拦截保存", () => {
  it("清单默认收起；有问题时保存可点，点击 → toast 提示并展开清单", () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: validTemplateGraph,
      },
    };
    render(<GraphEditorView />);
    // 合法模板无校验问题：摘要行不出现
    expect(
      screen.queryByText("chat:orchestration.editor.issuesSummary"),
    ).toBeNull();

    // 清空名称制造 nameRequired（既有变更 → 保存钮可点）
    const nameInput = screen.getByPlaceholderText(
      "chat:orchestration.editor.namePlaceholder",
    );
    fireEvent.change(nameInput, { target: { value: "" } });
    expect(
      screen.getByText("chat:orchestration.editor.issuesSummary"),
    ).toBeTruthy();
    expect(saveButton().disabled).toBe(false);

    // 点保存被拦截：toast + 清单自动展开（issuesTitle 随展开出现）
    fireEvent.click(saveButton());
    expect(toast.error).toHaveBeenCalledWith(
      "chat:orchestration.editor.saveBlocked",
    );
    expect(
      screen.getByText("chat:orchestration.editor.issuesTitle"),
    ).toBeTruthy();
    expect(
      screen.getByText("chat:orchestration.editor.nameRequired"),
    ).toBeTruthy();
  });
  it("StrictMode 双挂载预填不丢：replace 清路由 state 后重挂载靠快照兜底", () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: validTemplateGraph,
      },
    };
    // 首次挂载：预填成功（name=模板标题，画布出现模板节点）
    const { unmount } = render(<GraphEditorView />);
    const nameInput = () =>
      screen.getByPlaceholderText(
        "chat:orchestration.editor.namePlaceholder",
      ) as HTMLInputElement;
    expect(nameInput().value).toBe("tpl.title");
    expect(document.querySelector('[data-id="collect"]')).toBeTruthy();
    unmount();

    // 模拟预填消费 effect 的 navigate replace：路由 state 已清空，
    // StrictMode 重挂载的 useState 初始化器读不到 state——修复前预填
    // 丢失变空图，修复后 sessionStorage 快照兜底
    locationState.current = null;
    const second = render(<GraphEditorView />);
    expect(nameInput().value).toBe("tpl.title");
    expect(document.querySelector('[data-id="collect"]')).toBeTruthy();
    // 快照命中即删：第三次挂载（无 state 无快照）不再预填
    second.unmount();
    render(<GraphEditorView />);
    expect(nameInput().value).toBe("");
  });
});

describe("GraphEditorView 保存时序", () => {
  it("create 保存：缓存失效完成后才 navigate（防错误态闪烁）", async () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: validTemplateGraph,
      },
    };
    invokeMock.mockResolvedValue(savedRecord);
    let finishInvalidate: (() => void) | undefined;
    invalidateMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInvalidate = resolve;
        }),
    );

    render(<GraphEditorView />);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(invalidateMock).toHaveBeenCalled());
    // 失效（重拉）未完成前不得导航——否则新路由 record 未就绪闪「不存在」
    expect(navigateMock).not.toHaveBeenCalledWith(
      "/module/ai/graphs/42",
      expect.anything(),
    );

    act(() => finishInvalidate?.());
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/module/ai/graphs/42", {
        replace: true,
      }),
    );
  });
});

/** 合法带 start 骨架的图：start 入口 + 单 llm（变量编辑即可直接保存） */
const startTemplateGraph = {
  version: 1,
  inputSchema: {},
  nodes: [
    { id: "start", name: "开始", kind: "start", variables: [] },
    {
      id: "collect",
      name: "收集",
      kind: "llm",
      modelId: 1,
      prompt: "收集",
      tools: false,
      outputMode: "text",
    },
  ],
  edges: [
    { from: "start", to: "collect" },
    { from: "collect", to: "END" },
  ],
};

describe("GraphEditorView start 节点编辑", () => {
  it("添加节点菜单 start 项：图内已有 start 时禁用（唯一入口）", () => {
    render(<GraphEditorView />); // 空图骨架自带 start 节点
    fireEvent.click(screen.getByText("chat:orchestration.editor.addNode"));
    const startItem = screen
      .getByText("chat:orchestration.editor.kindStart")
      .closest("button");
    expect(startItem).toBeTruthy();
    expect((startItem as HTMLButtonElement).disabled).toBe(true);
  });

  it("start 节点编辑变量 → 保存落库 graphJson 的 inputSchema 同步（试运行变量来源）", async () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: startTemplateGraph,
      },
    };
    invokeMock.mockResolvedValue(savedRecord);

    render(<GraphEditorView />);
    // 点画布 start 卡片 → 面板切换到开始节点字段区
    const startCard = document.querySelector('[data-id="start"]');
    expect(startCard).toBeTruthy();
    fireEvent.click(startCard as HTMLElement);
    expect(
      screen.getByText("chat:orchestration.editor.variablesLabel"),
    ).toBeTruthy();

    // StringListInput 输入 "topic,lang" 回车提交（逗号拆分提交）
    const varInput = screen.getByPlaceholderText(
      "chat:orchestration.editor.variablePlaceholder",
    );
    fireEvent.change(varInput, { target: { value: "topic,lang" } });
    fireEvent.keyDown(varInput, { key: "Enter" });

    // 保存 → 解析落库参数：inputSchema 与 start.variables 同一提交同步
    fireEvent.click(saveButton());
    await waitFor(() => expect(invalidateMock).toHaveBeenCalled());
    const createCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "orchestration:create",
    );
    expect(createCall).toBeTruthy();
    const saved = JSON.parse(createCall![1].graphJson as string);
    expect(Object.keys(saved.inputSchema)).toEqual(["topic", "lang"]);
    expect(
      saved.nodes.find((node: { id: string }) => node.id === "start").variables,
    ).toEqual(["topic", "lang"]);
  });
});
