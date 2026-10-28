// @vitest-environment jsdom
/**
 * GraphEditorView.patchEdgeCondition 专项（终审修复波）：选中跟随新稳定串
 * （to 为 END 用虚拟节点形态，与 toCanvas 一致）+ dup 守卫静默跳过。RF 边
 * 在 jsdom 无节点量测不渲染（getEdgePosition→null），真实 GraphCanvas 无法
 * 提供边点击入口——以 stub 替代（边 id 经真实 toCanvas 计算，断言 selectedId
 * 与其形态一致即验证选中跟随；画布组件自身另有冒烟）。mock 骨架同
 * tests/ai/graph-editor-view.test.tsx；Radix Select jsdom 桩同
 * tests/project/create-project-dialog.test.tsx。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

afterEach(cleanup);

const { navigateMock, locationState } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  locationState: { current: null as unknown },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ipc", () => ({
  invoke: vi.fn(),
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
  useQuery: () => ({ data: [] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => {}) }),
}));

// 画布 stub：每条边一个按钮（id 用真实 toCanvas 稳定串），点击即 onSelect
vi.mock("@/domains/ai/orchestration/components/GraphCanvas", async () => {
  const { toCanvas } =
    await import("@/domains/ai/orchestration/lib/graph-canvas-model");
  return {
    default: ({
      graph,
      layouts,
      selectedId,
      onSelect,
    }: {
      graph: Parameters<typeof toCanvas>[0];
      layouts: Parameters<typeof toCanvas>[1];
      selectedId: string | null;
      onSelect: (id: string | null) => void;
    }) => (
      <div>
        {toCanvas(graph, layouts).edges.map((edge) => (
          <button
            key={edge.id}
            type="button"
            data-testid={`edge:${edge.id}`}
            onClick={() => onSelect(edge.id)}
          >
            {edge.id}
            {selectedId === edge.id ? " *" : ""}
          </button>
        ))}
      </div>
    ),
  };
});

import GraphEditorView from "@/domains/ai/orchestration/views/GraphEditorView";

/** 双 branch 节点合法图：gate→work 双条件边（go/stop）+ work→END 条件边 */
const branchTemplateGraph = {
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: "gate",
      name: "分流",
      kind: "llm",
      modelId: 1,
      prompt: "分流",
      tools: false,
      outputMode: "branch",
      branchOptions: ["go", "stop"],
    },
    {
      id: "work",
      name: "加工",
      kind: "llm",
      modelId: 1,
      prompt: "加工",
      tools: false,
      outputMode: "branch",
      branchOptions: ["ok", "fail"],
    },
  ],
  edges: [
    { from: "gate", to: "work", condition: { type: "branch", value: "go" } },
    { from: "gate", to: "work", condition: { type: "branch", value: "stop" } },
    { from: "work", to: "END", condition: { type: "branch", value: "ok" } },
  ],
};

/** EdgeBranch 条件下拉：Radix Select（mouse pointerDown 开 + click 选） */
async function pickCondition(name: string) {
  fireEvent.pointerDown(screen.getByRole("combobox"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name }));
}

/** JSON 模式源码框（含指定片段的 textbox） */
function jsonBox(snippet: string): HTMLTextAreaElement {
  const box = screen
    .getAllByRole("textbox")
    .find((el) => (el as HTMLTextAreaElement).value.includes(snippet));
  expect(box).toBeTruthy();
  return box as HTMLTextAreaElement;
}

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("DOMMatrixReadOnly", class {});
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  locationState.current = null;
  navigateMock.mockReset();
});

describe("GraphEditorView 边条件编辑（patchEdgeCondition）", () => {
  it("选中跟随新稳定串：END 目标映射虚拟节点形态，面板不落回图级", async () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: branchTemplateGraph,
      },
    };
    render(<GraphEditorView />);

    // 选 work→END:ok 边 → 面板边分支
    fireEvent.click(screen.getByTestId("edge:work->__end__:ok"));
    expect(
      screen.getByText("chat:orchestration.editor.panelEdge"),
    ).toBeTruthy();

    // 条件 ok → fail：图改写 + selectedId 跟随（END 目标稳定串用 __end__ 形态）
    await pickCondition("fail");
    expect(screen.getByTestId("edge:work->__end__:fail")).toBeTruthy();
    expect(screen.queryByTestId("edge:work->__end__:ok")).toBeFalsy();
    // 面板仍是边分支（修复前 selectedId 编码旧 label → 落回图级）
    expect(
      screen.getByText("chat:orchestration.editor.panelEdge"),
    ).toBeTruthy();
    expect(
      screen.queryByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeFalsy();
  });

  it("dup 守卫：改成已存在的 from+to+条件值静默跳过（图不变、选中不动）", async () => {
    locationState.current = {
      graphTemplate: {
        slug: "tpl",
        icon: "workflow",
        titleI18nKey: "tpl.title",
        descI18nKey: "tpl.desc",
        graphJson: branchTemplateGraph,
      },
    };
    render(<GraphEditorView />);

    // 选 gate→work:stop，改 "go"（gate→work:go 已存在）→ 跳过不写
    fireEvent.click(screen.getByTestId("edge:gate->work:stop"));
    expect(
      screen.getByText("chat:orchestration.editor.panelEdge"),
    ).toBeTruthy();
    await pickCondition("go");

    // 选中与图均不变：stop 边仍在、未新增无条件边、面板保持边分支
    expect(screen.getByTestId("edge:gate->work:stop")).toBeTruthy();
    expect(screen.queryByTestId("edge:gate->work:")).toBeFalsy();
    expect(
      screen.getByText("chat:orchestration.editor.panelEdge"),
    ).toBeTruthy();
    expect(
      screen.queryByText("chat:orchestration.editor.panelGraphTitle"),
    ).toBeFalsy();

    // JSON 模式确认：仍 3 条边（无重复 gate→work:go 两全等边）、stop 未被改写
    fireEvent.click(screen.getByText("chat:orchestration.editor.modeJson"));
    const box = jsonBox('"gate"');
    expect(box.value.match(/"from":/g)?.length).toBe(3);
    expect(box.value).toContain('"value": "stop"');
  });
});
