// @vitest-environment jsdom
// ProviderList 纯展示：选中态回调、停用降透明、模型数 pill、汇总行
// 真实 i18n（jsdom 恒 zh-CN）：key 渲染 zh-CN 译文；断言正则兼容去前缀 key 形式
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import ProviderList from "../../src-react/domains/ai/provider/components/ProviderList";
import type { ProviderRecord } from "../../src-react/domains/ai/api/provider.api";

function makeProvider(over: Partial<ProviderRecord>): ProviderRecord {
  return {
    id: 1,
    name: "P1",
    type: "openai-compatible",
    baseUrl: "https://x",
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ProviderRecord;
}

describe("ProviderList", () => {
  // vitest 未开 globals，RTL 自动清理不生效，显式清理
  afterEach(cleanup);

  const providers = [
    makeProvider({ id: 1, name: "硅基流动" }),
    makeProvider({ id: 2, name: "OpenAI" }),
    makeProvider({ id: 3, name: "Ollama 本地", enabled: false }),
  ];
  const counts = new Map([
    [1, 12],
    [2, 3],
    [3, 5],
  ]);

  it("渲染全部服务商 + 模型数 + 汇总", () => {
    render(
      <ProviderList
        providers={providers}
        modelCounts={counts}
        selectedId={1}
        totalModels={20}
        onSelect={() => {}}
        onAdd={() => {}}
      />,
    );
    expect(screen.getByText("硅基流动")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText(/provider\.summary|共 3 个服务商/)).toBeTruthy();
  });

  it("点击列表项回调 id；选中项带选中类", () => {
    const onSelect = vi.fn();
    const { container } = render(
      <ProviderList
        providers={providers}
        modelCounts={counts}
        selectedId={2}
        totalModels={20}
        onSelect={onSelect}
        onAdd={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("硅基流动"));
    expect(onSelect).toHaveBeenCalledWith(1);
    const selected = container.querySelector("[data-selected='true']");
    expect(selected?.textContent).toContain("OpenAI");
  });

  it("停用服务商带停用标记；添加按钮回调", () => {
    const onAdd = vi.fn();
    render(
      <ProviderList
        providers={providers}
        modelCounts={counts}
        selectedId={1}
        totalModels={20}
        onSelect={() => {}}
        onAdd={onAdd}
      />,
    );
    expect(screen.getByText(/provider\.disabledTag|已停用/)).toBeTruthy();
    // provider.add 已有真实译文（经 button.tsx → lib/utils → @/i18n 初始化），
    // 按钮文案为「添加服务商」；兼容 key 形式按 role 定位，断言锚「点击触发回调」
    fireEvent.click(
      screen.getByRole("button", { name: /provider\.add|添加服务商/ }),
    );
    expect(onAdd).toHaveBeenCalled();
  });
});
