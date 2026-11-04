// tests/ai/graph-canvas.test.tsx
// @vitest-environment jsdom
/**
 * 画布冒烟（Task 2）：GraphCanvas 渲染节点卡片名/END 虚拟节点/branch
 * handle 标签。jsdom 缺 ResizeObserver/DOMMatrixReadOnly（RF 节点量测用），
 * 测试内补桩；模型名 query 经 mock（先例 tests/ai/graph-editor-view.test.tsx）。
 * t 返回 key 本身 → END 文案/工具栏断言即 i18n key；分支标签 "go" 因边
 * label 与 handle 标签同文出现两次，用 getAllByText（语义不变：标签存在）。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
// Button/Badge 经 @/lib/utils 引入 @/i18n 单例，须一并 mock（同
// tests/ai/graph-editor-view.test.tsx 先例）
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
}));

import GraphCanvas from "@/domains/ai/orchestration/components/GraphCanvas";
import { END_NODE_ID } from "@/domains/ai/orchestration/lib/graph-canvas-model";
import type { GraphJson } from "@/domains/ai/orchestration/api/graph.schema";

/** timeoutMs 为 zod default 输出必填，测试夹具经 as 塑形（先例
 * tests/ai/graph-canvas-model.test.ts） */
const graph = {
  version: 1,
  inputSchema: {},
  nodes: [
    {
      id: "a",
      name: "甲",
      kind: "llm",
      modelId: 1,
      prompt: "p",
      tools: false,
      outputMode: "branch",
      branchOptions: ["go", "stop"],
    },
    { id: "b", name: "乙", kind: "code", language: "bash", script: "echo" },
  ],
  edges: [
    { from: "a", to: "b", condition: { type: "branch", value: "go" } },
    { from: "b", to: "END" },
  ],
} as GraphJson;

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
});

describe("GraphCanvas 冒烟", () => {
  it("渲染节点名/END 虚拟节点/分支 handle 标签", () => {
    render(
      <GraphCanvas
        graph={graph}
        layouts={{}}
        selectedId={null}
        onSelect={() => {}}
        onMove={() => {}}
        onConnect={() => {}}
        onAddNode={() => {}}
        onRemoveNode={() => {}}
        onRemoveEdge={() => {}}
      />,
    );
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("乙")).toBeTruthy();
    // END 文案经 i18n（key mock 直显）；END 虚拟节点确实入画
    expect(screen.getByText("chat:orchestration.editor.endNode")).toBeTruthy();
    expect(document.querySelector(`[data-id="${END_NODE_ID}"]`)).toBeTruthy();
    // 分支 handle 标签（边 label 同文重复，getAllByText 语义不变）
    expect(screen.getAllByText("go").length).toBeGreaterThan(0);
  });
});
