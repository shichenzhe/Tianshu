// @vitest-environment jsdom
// 双栏壳：默认选中首个、切换选中、模型开关乐观更新与回滚
// 真实 i18n（jsdom 恒 zh-CN，经 error-message → @/i18n 链路初始化）；
// 断言锚 baseUrl/名称/aria-checked，不依赖 t 文案（T7 补 key 前后均稳定）
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const providerList = vi.fn(async () => [
  {
    id: 1,
    name: "P1",
    type: "openai-compatible",
    baseUrl: "https://x/1",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 2,
    name: "P2",
    type: "ollama",
    baseUrl: "https://x/2",
    enabled: true,
    createdAt: "",
    updatedAt: "",
  },
]);
const modelListAll = vi.fn(async () => [
  {
    id: 11,
    providerId: 1,
    modelId: "m-a",
    enabled: true,
    type: "llm",
    createdAt: "",
    updatedAt: "",
  },
  {
    id: 12,
    providerId: 1,
    modelId: "m-b",
    enabled: false,
    type: "llm",
    createdAt: "",
    updatedAt: "",
  },
]);
const modelUpdate = vi.fn();
// PROVIDER_TYPES/MODEL_TYPES 必须给出：弹窗关闭态也会构建 DialogContent 的 JSX
//（两者 .map 在组件渲染期求值，缺失导出直接抛错）
vi.mock("../../src-react/domains/ai/api/provider.api", () => ({
  default: { list: (...a: unknown[]) => providerList(...a) },
  PROVIDER_TYPES: ["openai-compatible", "anthropic", "gemini", "ollama"],
}));
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  default: {
    listAll: (...a: unknown[]) => modelListAll(...a),
    update: (...a: unknown[]) => modelUpdate(...a),
  },
  MODEL_TYPES: ["llm", "embedding", "tts", "reranker", "asr"],
}));

import ProviderSettingsView from "../../src-react/domains/ai/provider/views/ProviderSettingsView";

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProviderSettingsView />
    </QueryClientProvider>,
  );
}

describe("ProviderSettingsView 双栏", () => {
  // vitest 未开 globals，RTL 自动清理不生效，显式清理
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    modelUpdate.mockResolvedValue({});
  });

  it("默认选中首个服务商：右栏显示其 baseUrl 与模型行", async () => {
    renderView();
    expect(await screen.findByText("https://x/1")).toBeTruthy();
    expect(screen.getByText("m-a")).toBeTruthy();
    expect(screen.getByText("m-b")).toBeTruthy();
  });

  it("点击左列切换：右栏切换为 P2（无模型 → 空态文案）", async () => {
    renderView();
    await screen.findByText("https://x/1");
    fireEvent.click(screen.getByText("P2"));
    expect(screen.getByText("https://x/2")).toBeTruthy();
    expect(screen.queryByText("m-a")).toBeNull();
  });

  it("模型开关：乐观翻转 + model:update 调用", async () => {
    const { container } = renderView();
    await screen.findByText("m-a");
    const row = [
      ...container.querySelectorAll("[data-model-row='m-a']"),
    ][0] as HTMLElement;
    const sw = row.querySelector("[role='switch']") as HTMLElement;
    fireEvent.click(sw);
    await waitFor(() => {
      expect(modelUpdate).toHaveBeenCalledWith({ id: 11, enabled: false });
    });
  });

  it("模型开关失败：回滚 + 不抛错", async () => {
    modelUpdate.mockRejectedValue(new Error("MODEL_MISSING"));
    const { container } = renderView();
    await screen.findByText("m-a");
    const row = [
      ...container.querySelectorAll("[data-model-row='m-a']"),
    ][0] as HTMLElement;
    fireEvent.click(row.querySelector("[role='switch']") as HTMLElement);
    await waitFor(() => {
      expect(modelUpdate).toHaveBeenCalled();
    });
    // 回滚后开关仍为开（aria-checked 不变）
    expect(
      row.querySelector("[role='switch']")?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});
