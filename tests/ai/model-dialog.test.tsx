// @vitest-environment jsdom
// ModelDialog 类型链路：默认 llm 显示采样参数；切非 llm 隐藏采样参数；
// 提交带 type；编辑态回显类型。真实 i18n（jsdom 恒 zh-CN），断言正则兼容
// 去前缀 key 形式
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const create = vi.fn();
const update = vi.fn();
vi.mock("../../src-react/domains/ai/api/model.api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src-react/domains/ai/api/model.api")
    >();
  return {
    ...actual,
    default: {
      create: (...a: unknown[]) => create(...a),
      update: (...a: unknown[]) => update(...a),
    },
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// Radix Select 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;

import ModelDialog from "../../src-react/domains/ai/provider/components/ModelDialog";
import type { ModelRecord } from "../../src-react/domains/ai/api/model.api";

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function selectOption(trigger: HTMLElement, optionName: RegExp) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: optionName }));
}

function renderDialog(editing?: ModelRecord) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ModelDialog
        open
        onOpenChange={() => {}}
        providerId={1}
        editing={editing}
      />
    </QueryClientProvider>,
  );
}

function fillModelId(value: string) {
  // modelId 输入框为唯一 font-mono 文本框（display name 无等宽类）；
  // Dialog 内容走 Radix portal，从 document 查询而非 render 容器
  fireEvent.change(document.querySelector("input.font-mono")!, {
    target: { value },
  });
}

const editingEmbedding = {
  id: 9,
  providerId: 1,
  modelId: "text-embedding-3",
  enabled: true,
  type: "embedding",
  createdAt: "",
  updatedAt: "",
} as ModelRecord;

describe("ModelDialog 模型类型", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({});
    update.mockResolvedValue({});
  });

  it("默认 llm：显示采样参数（温度）且 create 带 type llm", async () => {
    renderDialog();
    expect(screen.getByText(/model\.temperature|温度/)).toBeTruthy();
    fillModelId("deepseek-v3");
    fireEvent.click(screen.getByRole("button", { name: /确定|confirm/ }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "deepseek-v3", type: "llm" }),
    );
  });

  it("切 embedding：隐藏采样参数且 create 带 type embedding", async () => {
    renderDialog();
    const trigger = screen.getByRole("combobox", {
      name: /model\.type|类型/,
    }) as HTMLElement;
    await selectOption(trigger, /model\.type\.embedding|向量/);
    // 非 llm 采样参数无意义：温度/输出上限不再渲染
    expect(screen.queryByText(/model\.temperature|温度/)).toBeNull();
    expect(screen.queryByText(/model\.outputLimit|输出上限/)).toBeNull();
    fillModelId("text-embedding-3");
    fireEvent.click(screen.getByRole("button", { name: /确定|confirm/ }));
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(1);
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "text-embedding-3",
        type: "embedding",
      }),
    );
  });

  it("编辑态回显类型：embedding 打开即隐藏采样参数", () => {
    renderDialog(editingEmbedding);
    expect(screen.queryByText(/model\.temperature|温度/)).toBeNull();
    expect(screen.getByRole("combobox").textContent).toMatch(
      /model\.type\.embedding|向量/,
    );
  });
});
