// @vitest-environment jsdom
/**
 * 试运行弹窗 json 输入（2026-11-05）：
 * - json 字段渲染多行文本域（区别于 string 单行 Input）
 * - 合法 JSON 文本提交 → 载荷 parse 为容器原生值（非字符串）
 * - required json 字段填非法 JSON → 运行按钮禁用（required 判满联动）
 * - json 容器 default 预填为紧凑 JSON 文本形态
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("../../src-react/domains/ai/api/workspace.api", () => ({
  WorkspaceApi: { list: vi.fn(async () => [{ id: 3, name: "ws" }]) },
}));
vi.mock(
  "../../src-react/domains/ai/orchestration/api/orchestration.api",
  () => ({
    GraphApi: { runTest: vi.fn(async () => ({})) },
  }),
);

import { WorkspaceApi } from "../../src-react/domains/ai/api/workspace.api";
import { GraphApi } from "../../src-react/domains/ai/orchestration/api/orchestration.api";
import GraphTestRunDialog from "../../src-react/domains/ai/orchestration/components/GraphTestRunDialog";
import type { NormalizedInputField } from "../../src-react/domains/ai/orchestration/api/graph.schema";

/** 装配 QueryClientProvider 直渲染（先例 chat-input-paste renderInput） */
function mount(fields: NormalizedInputField[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <GraphTestRunDialog
        graphId={1}
        draftJson="{}"
        fields={fields}
        open={true}
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

function runButton(): HTMLButtonElement {
  return screen.getByText("chat:orchestration.testRun.button")
    .closest("button") as HTMLButtonElement;
}

const jsonFields: NormalizedInputField[] = [
  { key: "payload", type: "json", required: true },
];

async function waitForWorkspace() {
  // workspace 下拉数据就绪（React Query 异步；模块级 mock 跨用例累积
  // 计数，不查次数）
  await waitFor(() => expect(WorkspaceApi.list).toHaveBeenCalled());
  const box = screen.getByRole("textbox");
  await waitFor(() => expect(box).toBeTruthy());
}

describe("GraphTestRunDialog json 字段", () => {
  afterEach(() => {
    cleanup();
  });

  it("json 字段渲染多行文本域", async () => {
    mount(jsonFields);
    await waitForWorkspace();
    const box = screen.getByRole("textbox");
    expect(box.tagName).toBe("TEXTAREA");
  });

  it("合法 JSON 文本提交 → 载荷 parse 为容器原生值", async () => {
    mount(jsonFields);
    await waitForWorkspace();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: '{"a":1,"list":[1,2]}' } });
    fireEvent.click(runButton());
    await waitFor(() => expect(GraphApi.runTest).toHaveBeenCalled());
    const inputs = (GraphApi.runTest as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(inputs).toEqual({ payload: { a: 1, list: [1, 2] } });
  });

  it("required json 填非法 JSON → 运行按钮禁用", async () => {
    mount(jsonFields);
    await waitForWorkspace();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "{a:1}" } });
    expect(runButton().disabled).toBe(true);
  });

  it("json 容器 default 预填为紧凑 JSON 文本", async () => {
    mount([
      {
        key: "payload",
        type: "json",
        required: false,
        default: { fallback: true },
      },
    ]);
    await waitForWorkspace();
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.value).toBe('{"fallback":true}');
  });
});
