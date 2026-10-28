// @vitest-environment jsdom
// 选择器按模型类型过滤：chat ModelPicker / 自动化 TaskModelPicker 只列
// llm；图向量节点（vectorize/vectorSearch）只列 embedding。
// 真实 i18n（jsdom 恒 zh-CN）；mock providers/models 数据源
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const listProviders = vi.fn();
const listAll = vi.fn();
vi.mock("../../src-react/domains/ai/api/provider.api", () => ({
  ProviderApi: { list: () => listProviders() },
}));
vi.mock("../../src-react/domains/ai/api/model.api", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src-react/domains/ai/api/model.api")
    >();
  return { ...actual, default: { listAll: () => listAll() } };
});
const setModelMock = vi.hoisted(() => vi.fn());
vi.mock("../../src-react/domains/ai/api/session.api", () => ({
  default: { setModel: setModelMock },
}));
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}));
const navigate = vi.fn();
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return { ...actual, useNavigate: () => navigate };
});

import ModelPicker from "../../src-react/domains/ai/chat/components/ModelPicker";
import { toast } from "sonner";
import TaskModelPicker from "../../src-react/domains/ai/automation/components/TaskModelPicker";
import {
  VectorizeNodeFields,
  VectorSearchNodeFields,
} from "../../src-react/domains/ai/orchestration/components/GraphNodeEditor";
import type { VectorizeNode } from "../../src-react/domains/ai/orchestration/api/graph.schema";

// Radix Select 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;

const LLM_ID = "deepseek-v3";
const EMBED_ID = "text-embedding-3";

function mockCatalog() {
  listProviders.mockResolvedValue([
    { id: 1, name: "硅基流动", type: "openai-compatible", enabled: true },
  ]);
  listAll.mockResolvedValue([
    {
      id: 1,
      providerId: 1,
      modelId: LLM_ID,
      enabled: true,
      type: "llm",
      createdAt: "",
      updatedAt: "",
    },
    {
      id: 2,
      providerId: 1,
      modelId: EMBED_ID,
      enabled: true,
      type: "embedding",
      createdAt: "",
      updatedAt: "",
    },
  ]);
}

function withClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中 */
async function openSelectOptions() {
  const trigger = screen.getByRole("combobox");
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  return screen.findAllByRole("option");
}

/** Radix DropdownMenu 展开触发（仅 pointerDown：随后 click 会 toggle 关闭） */
function openDropdownMenu() {
  fireEvent.pointerDown(screen.getByRole("button"), { button: 0 });
}

describe("选择器按模型类型过滤", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    mockCatalog();
  });

  it("chat ModelPicker 只列 llm", async () => {
    withClient(<ModelPicker currentModelId={1} />);
    openDropdownMenu();
    // 数据就绪标志：分组 label「硅基流动」出现（「配置模型」入口不依赖
    // 查询数据，过早断言会撞上 useQuery pending 的竞态）
    expect(await screen.findByText("硅基流动")).toBeTruthy();
    expect(screen.getAllByText(LLM_ID).length).toBeGreaterThan(0);
    expect(screen.queryByText(EMBED_ID)).toBeNull();
  });

  it("哨兵会话（id<0，文件窗占位）：选模型轻提示不落库（修复轮 1 Minor ③）", async () => {
    setModelMock.mockClear();
    vi.mocked(toast.info).mockClear();
    withClient(<ModelPicker sessionId={-1} />);
    openDropdownMenu();
    expect(await screen.findByText("硅基流动")).toBeTruthy();
    fireEvent.click(screen.getAllByText(LLM_ID)[0]);
    // 本文件 i18n 真身（zh-CN 缺省文案）
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith("发送第一条消息后可用"),
    );
    expect(setModelMock).not.toHaveBeenCalled();
  });

  it("自动化 TaskModelPicker 只列 llm", async () => {
    withClient(<TaskModelPicker modelId={1} onChange={() => {}} />);
    openDropdownMenu();
    expect(await screen.findByText("硅基流动")).toBeTruthy();
    expect(screen.getAllByText(LLM_ID).length).toBeGreaterThan(0);
    expect(screen.queryByText(EMBED_ID)).toBeNull();
  });

  it("vectorize 节点模型下拉只列 embedding", async () => {
    const node = {
      id: "n1",
      kind: "vectorize",
      collection: "c",
      sourceName: "s",
      text: "t",
      modelId: 2,
      chunkSize: 500,
      chunkOverlap: 100,
    } as VectorizeNode;
    withClient(<VectorizeNodeFields node={node} onPatch={() => {}} />);
    const options = await openSelectOptions();
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain(EMBED_ID);
    expect(labels).not.toContain(LLM_ID);
  });

  it("vectorSearch 节点模型下拉只列 embedding", async () => {
    const node = {
      id: "n1",
      kind: "vectorSearch",
      collection: "",
      searchQuery: "q",
      modelId: 2,
      topK: 5,
    } as unknown as VectorizeNode;
    withClient(<VectorSearchNodeFields node={node} onPatch={() => {}} />);
    const options = await openSelectOptions();
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain(EMBED_ID);
    expect(labels).not.toContain(LLM_ID);
  });
});
