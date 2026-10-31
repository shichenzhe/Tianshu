// @vitest-environment jsdom
// 选择器按模型类型过滤：chat ModelPicker / 自动化 TaskModelPicker 只列
// llm；图向量节点（vectorize/vectorSearch/hybridSearch）只列 embedding；
// 重排节点（rerank）只列 reranker（来源下拉另验：仅列图中其它
// hybridSearch 节点）。
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
  HybridSearchNodeFields,
  RerankNodeFields,
  VectorizeNodeFields,
  VectorSearchNodeFields,
} from "../../src-react/domains/ai/orchestration/components/GraphNodeEditor";
import type {
  GraphNode,
  HybridSearchNode,
  RerankNode,
  VectorizeNode,
} from "../../src-react/domains/ai/orchestration/api/graph.schema";

// Radix Select 触发器 pointerDown 分支依赖 hasPointerCapture/scrollIntoView
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.hasPointerCapture = () => false;

const LLM_ID = "deepseek-v3";
const EMBED_ID = "text-embedding-3";
const RERANK_ID = "bge-reranker-v2-m3";

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
    {
      id: 3,
      providerId: 1,
      modelId: RERANK_ID,
      enabled: true,
      type: "reranker",
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

/** Radix Select 选项切换：mouse pointerDown 展开 + click 选中（多
 *  combobox 场景可指定触发器，缺省取唯一者） */
async function openSelectOptions(trigger = screen.getByRole("combobox")) {
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

  it("hybridSearch 节点模型下拉只列 embedding", async () => {
    const node = {
      id: "n1",
      kind: "hybridSearch",
      name: "混合检索",
      searchQuery: "q",
      collection: "",
      mode: "hybrid",
      topK: 3,
      modelId: 2,
    } as HybridSearchNode;
    withClient(<HybridSearchNodeFields node={node} onPatch={() => {}} />);
    // hybrid 模式下模式单选也是 combobox（keyword 模式不渲染模型下拉），
    // 模型下拉为第二个
    const options = await openSelectOptions(
      screen.getAllByRole("combobox")[1],
    );
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain(EMBED_ID);
    expect(labels).not.toContain(LLM_ID);
  });

  it("rerank 节点模型下拉只列 reranker", async () => {
    const node = {
      id: "rr",
      kind: "rerank",
      query: "q",
      sourceNodeId: "hs",
      modelId: 3,
      topN: 5,
    } as RerankNode;
    withClient(<RerankNodeFields node={node} onPatch={() => {}} />);
    // combobox[0]=来源下拉，[1]=模型下拉
    const options = await openSelectOptions(screen.getAllByRole("combobox")[1]);
    const labels = options.map((o) => o.textContent);
    expect(labels).toContain(RERANK_ID);
    expect(labels).not.toContain(LLM_ID);
    expect(labels).not.toContain(EMBED_ID);
  });

  it("rerank 来源下拉只列图中其它 hybridSearch 节点（排除自身/非检索）", async () => {
    const node = {
      id: "rr",
      kind: "rerank",
      query: "q",
      sourceNodeId: "",
      modelId: 3,
      topN: 5,
    } as RerankNode;
    const graphNodes = [
      node,
      {
        id: "hs",
        name: "混合检索",
        kind: "hybridSearch",
        searchQuery: "q",
        collection: "",
        mode: "hybrid",
        topK: 5,
      },
      { id: "writer", name: "写作", kind: "llm", modelId: 1, prompt: "p" },
    ] as unknown as GraphNode[];
    withClient(
      <RerankNodeFields node={node} onPatch={() => {}} graphNodes={graphNodes} />,
    );
    const options = await openSelectOptions(screen.getAllByRole("combobox")[0]);
    const labels = options.map((o) => o.textContent);
    expect(labels).toEqual(["hs（混合检索）"]);
  });
});
