// @vitest-environment jsdom
// ModelList 纯展示：开关回调、参数摘要渲染、测试/编辑/删除回调、添加行
// 真实 i18n（jsdom 恒 zh-CN）：已建 key 渲染真实译文（model.test→测试、
// model.summary.context→上下文 {{value}} 等）；断言正则兼容去前缀 key 形式
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react";
import ModelList from "../../src-react/domains/ai/provider/components/ModelList";
import type { ModelRecord } from "../../src-react/domains/ai/api/model.api";

function makeModel(over: Partial<ModelRecord>): ModelRecord {
  return {
    id: 1,
    providerId: 1,
    modelId: "m-a",
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ModelRecord;
}

function findSwitch(row: HTMLElement): HTMLElement {
  return row.querySelector("[role='switch']") as HTMLElement;
}

function rowOf(container: HTMLElement, modelId: string): HTMLElement {
  return [...container.querySelectorAll("[data-model-row]")].find(
    (el) => el.getAttribute("data-model-row") === modelId,
  ) as HTMLElement;
}

describe("ModelList", () => {
  // vitest 未开 globals，RTL 自动清理不生效，显式清理
  afterEach(cleanup);

  const models = [
    makeModel({
      id: 1,
      modelId: "deepseek-v3",
      contextWindow: 32768,
      maxTokens: 8192,
    }),
    makeModel({ id: 2, modelId: "qwen-72b", enabled: false }),
  ];

  it("渲染 modelId + 参数摘要段（key 文案）+ 空数组时默认参数", () => {
    render(
      <ModelList
        models={models}
        testingModelId={null}
        onToggle={() => {}}
        onTest={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText("deepseek-v3")).toBeTruthy();
    // 摘要段 label 译文 + 插值格式化值（32768→32K、8192→8K，值格式化由
    // model-summary.test.ts 锚定）；正则兼容去前缀 key 形式
    expect(
      screen.getByText(/model\.summary\.context|上下文 32K · 输出 8K/),
    ).toBeTruthy();
    // 全默认 → 「默认参数」译文；正则兼容去前缀 key 形式
    expect(screen.getByText(/model\.defaultParams|默认参数/)).toBeTruthy();
  });

  it("开关点击回调 (model, enabled)；测试/编辑/删除/添加回调", () => {
    const onToggle = vi.fn();
    const onTest = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onAdd = vi.fn();
    const { container } = render(
      <ModelList
        models={models}
        testingModelId={null}
        onToggle={onToggle}
        onTest={onTest}
        onEdit={onEdit}
        onDelete={onDelete}
        onAdd={onAdd}
      />,
    );
    const row = rowOf(container, "deepseek-v3");
    fireEvent.click(findSwitch(row));
    expect(onToggle).toHaveBeenCalledWith(models[0], false);
    // model.test 已有真实译文「测试」；两行各有该按钮，行内定位
    fireEvent.click(within(row).getByText("测试").closest("button")!);
    expect(onTest).toHaveBeenCalledWith(models[0]);
    // 编辑/删除仅图标 + aria-label（译文「编辑」/「删除」），按可达名行内定位
    fireEvent.click(
      within(row).getByRole("button", { name: /model\.editAction|编辑/ }),
    );
    expect(onEdit).toHaveBeenCalledWith(models[0]);
    fireEvent.click(
      within(row).getByRole("button", { name: /model\.deleteAction|删除/ }),
    );
    expect(onDelete).toHaveBeenCalledWith(models[0]);
    fireEvent.click(
      screen.getByText(/model\.addManually|手动添加模型/).closest("button")!,
    );
    expect(onAdd).toHaveBeenCalled();
  });

  it("testingModelId 命中行禁用测试并显示测试中文案", () => {
    const { container } = render(
      <ModelList
        models={models}
        testingModelId={1}
        onToggle={() => {}}
        onTest={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onAdd={() => {}}
      />,
    );
    // model.testing 已有真实译文「测试中…」
    const btn = within(rowOf(container, "deepseek-v3"))
      .getByText("测试中…")
      .closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("非 llm 模型行显示类型徽章，llm 行不显示", () => {
    const { container } = render(
      <ModelList
        models={[
          makeModel({ id: 1, modelId: "text-embedding-3", type: "embedding" }),
          makeModel({ id: 2, modelId: "deepseek-v3", type: "llm" }),
        ]}
        testingModelId={null}
        onToggle={() => {}}
        onTest={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onAdd={() => {}}
      />,
    );
    // 徽章译文 key 兼容去前缀形式
    const badge = within(rowOf(container, "text-embedding-3")).getByText(
      /model\.type\.embedding|向量/,
    );
    expect(badge).toBeTruthy();
    // llm 行不渲染类型徽章（不占视觉噪音）
    expect(
      within(rowOf(container, "deepseek-v3")).queryByText(/model\.type\./),
    ).toBeNull();
  });
});
