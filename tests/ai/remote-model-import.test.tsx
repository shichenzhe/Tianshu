// @vitest-environment jsdom
// RemoteModelImportDialog：拉取结果勾选导入；已导入置灰排末尾；错误态重试
// 真实 i18n（jsdom 恒 zh-CN）：key 均有 zh-CN 译文（model.importSelected→导入所选、
// errors.AUTH_FAILED→认证失败…）；断言正则兼容去前缀 key 形式
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listRemote = vi.fn();
const create = vi.fn();
vi.mock("../../src-react/domains/ai/api/model.api", () => ({
  default: {
    listRemote: (...a: unknown[]) => listRemote(...a),
    create: (...a: unknown[]) => create(...a),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import RemoteModelImportDialog from "../../src-react/domains/ai/provider/components/RemoteModelImportDialog";
import type { ProviderRecord } from "../../src-react/domains/ai/api/provider.api";

const provider = {
  id: 7,
  name: "硅基流动",
  type: "openai-compatible",
  baseUrl: "https://x",
  enabled: true,
  createdAt: "",
  updatedAt: "",
} as ProviderRecord;

function renderDialog(existing: string[] = ["qwen-72b"]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <RemoteModelImportDialog
        open
        onOpenChange={() => {}}
        provider={provider}
        existingModelIds={existing}
      />
    </QueryClientProvider>,
  );
}

describe("RemoteModelImportDialog", () => {
  // vitest 未开 globals，RTL 自动清理不生效，显式清理
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({});
  });

  it("渲染远端列表：未导入在前可勾选，已导入置灰排末尾", async () => {
    listRemote.mockResolvedValue({
      success: true,
      models: [
        { modelId: "deepseek-v3" },
        { modelId: "qwen-72b" },
        { modelId: "glm-4.6" },
      ],
    });
    renderDialog();
    expect(await screen.findByText("deepseek-v3")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows[0].textContent).toContain("deepseek-v3");
    const lastRow = rows[rows.length - 1];
    expect(lastRow.textContent).toContain("qwen-72b");
    // 已导入标签译文「已导入」；正则兼容去前缀 key 形式
    expect(lastRow.textContent).toMatch(/model\.imported|已导入/);
    // 已导入行复选框禁用
    expect(lastRow.querySelector("button")?.hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("勾选两个 → 导入按钮计数 2 → 逐个 create({providerId, modelId})", async () => {
    listRemote.mockResolvedValue({
      success: true,
      models: [
        { modelId: "deepseek-v3" },
        { modelId: "glm-4.6" },
        { modelId: "qwen-72b" },
      ],
    });
    renderDialog();
    fireEvent.click(await screen.findByText("deepseek-v3"));
    fireEvent.click(screen.getByText("glm-4.6"));
    // 按钮为两节点文案（key 译文 + 计数），textContent 同时含两者
    const importBtn = screen.getByRole("button", {
      name: /导入所选|importSelected/,
    });
    expect(importBtn.textContent).toContain("2");
    fireEvent.click(importBtn);
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    expect(create).toHaveBeenCalledWith({
      providerId: 7,
      modelId: "deepseek-v3",
      type: "llm",
    });
    expect(create).toHaveBeenCalledWith({
      providerId: 7,
      modelId: "glm-4.6",
      type: "llm",
    });
  });

  it("拉取失败 → 错误态（错误码 + 原始 message）+ 重试按钮", async () => {
    listRemote.mockResolvedValue({
      success: false,
      errorCode: "AUTH_FAILED",
      message: "HTTP 401",
      models: [],
    });
    renderDialog();
    // errors.AUTH_FAILED 已有真实译文；正则兼容 T7 后文案调整
    expect(await screen.findByText(/认证失败|AUTH_FAILED/)).toBeTruthy();
    expect(screen.getByText("HTTP 401")).toBeTruthy();
    expect(screen.getByText(/model\.retry|重试/)).toBeTruthy();
  });

  it("按名称识别类型：非 llm 行显示徽章，导入 create 带识别 type", async () => {
    listRemote.mockResolvedValue({
      success: true,
      models: [
        { modelId: "text-embedding-3-large" },
        { modelId: "deepseek-v3" },
      ],
    });
    renderDialog([]);
    expect(await screen.findByText("text-embedding-3-large")).toBeTruthy();
    // 非 llm 行类型徽章（译文 key 兼容去前缀形式）
    expect(screen.getByText(/model\.type\.embedding|向量/)).toBeTruthy();
    // llm 行无徽章
    const llmRow = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent!.includes("deepseek-v3"))!;
    expect(llmRow.textContent).not.toMatch(/model\.type\./);
    fireEvent.click(screen.getByText("text-embedding-3-large"));
    fireEvent.click(screen.getByText("deepseek-v3"));
    fireEvent.click(
      screen.getByRole("button", { name: /导入所选|importSelected/ }),
    );
    await waitFor(() => {
      expect(create).toHaveBeenCalledTimes(2);
    });
    expect(create).toHaveBeenCalledWith({
      providerId: 7,
      modelId: "text-embedding-3-large",
      type: "embedding",
    });
    expect(create).toHaveBeenCalledWith({
      providerId: 7,
      modelId: "deepseek-v3",
      type: "llm",
    });
  });
});
