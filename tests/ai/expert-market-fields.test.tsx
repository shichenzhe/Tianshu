// @vitest-environment jsdom
/**
 * 市场 UI 补全（专家 2.0 Task 7）：
 * - ExpertDetailDialog：quickPrompts 区块（标题 key + 💬 条目列表）与
 *   skillNames 技能胶囊（⚡ + 名称，样式对齐 tags 胶囊）；均缺省不渲染
 * - ExpertMarketView：分类 pill 只渲染有条目的分类（空分类不出 tab——
 *   当前 03-GameSpatial / 10-ProjectQuality 0 条目）；详情「添加到我的
 *   专家」create 载荷携带新字段（profession=subtitle、categoryId=category、
 *   quickPrompts、skillNames，对齐 ExpertRecommendCard 先例）
 * - MyExpertsView（ExpertCardMine）：副标题 description > profession >
 *   systemPrompt 60 字截断；头衔行仅 description 存在时渲染（无
 *   description 时副标题回退显示 profession，避免同文本重复）
 * setup 同 tests/ai/expert-recommend-card.test.tsx（i18n mock + 手动 cleanup）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ExpertDetailDialog from "../../src-react/domains/ai/experts/components/ExpertDetailDialog";
import ExpertMarketView from "../../src-react/domains/ai/experts/views/ExpertMarketView";
import MyExpertsView from "../../src-react/domains/ai/experts/views/MyExpertsView";
import type { AssistantRecord } from "../../src-react/domains/ai/api/assistant.api";
import {
  EXPERT_CATEGORIES,
  MARKET_EXPERTS,
  type ExpertMarketItem,
} from "../../src-react/domains/ai/experts/data/marketplace";
import { invoke } from "@/lib/ipc";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

const invokeMock = invoke as unknown as Mock;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((channel: string) => {
    if (channel === "assistant:list") {
      return Promise.resolve([]);
    }
    return Promise.resolve({ id: 9 });
  });
});

/** 渲染市场视图（router + react-query 双 Provider 包装） */
function renderMarket() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ExpertMarketView onOpenMine={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 渲染我的专家视图（assistant:list 返回给定清单） */
function renderMine(list: AssistantRecord[]) {
  invokeMock.mockImplementation((channel: string) => {
    if (channel === "assistant:list") {
      return Promise.resolve(list);
    }
    return Promise.resolve({ id: 9 });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <MyExpertsView onBack={() => {}} onBrowseMarket={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function makeAssistant(overrides: Partial<AssistantRecord>): AssistantRecord {
  return {
    id: 1,
    name: "我的专家",
    systemPrompt: "sys",
    builtin: false,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("ExpertDetailDialog（quickPrompts 与技能胶囊）", () => {
  const dialogItem: ExpertMarketItem = {
    slug: "t-detail",
    name: "详情专家",
    subtitle: "测试头衔",
    description: "一句描述",
    icon: "🧪",
    systemPrompt: "sys",
    category: "02-Engineering",
    tags: ["标签"],
    quickPrompts: ["试试这样问我", "再换个问法"],
    skillNames: ["天气查询", "日程提醒"],
    type: "expert",
    score: 90,
    downloads: 1,
    createdAt: "2026-01-01",
  };

  it("渲染推荐提示词区块（标题 + 💬 条目）与技能胶囊（⚡ + 名称）", () => {
    render(
      <ExpertDetailDialog
        item={dialogItem}
        added={false}
        adding={false}
        onAdd={() => {}}
        onAddAndChat={() => {}}
        onOpenChange={() => {}}
      />,
    );
    expect(
      screen.getByText("chat:experts.market.quickPromptsTitle"),
    ).toBeTruthy();
    expect(screen.getByText("💬 试试这样问我")).toBeTruthy();
    expect(screen.getByText("💬 再换个问法")).toBeTruthy();
    expect(screen.getByText("⚡ 天气查询")).toBeTruthy();
    expect(screen.getByText("⚡ 日程提醒")).toBeTruthy();
  });

  it("quickPrompts/skillNames 为空时不渲染对应区块", () => {
    render(
      <ExpertDetailDialog
        item={{ ...dialogItem, quickPrompts: [], skillNames: [] }}
        added={false}
        adding={false}
        onAdd={() => {}}
        onAddAndChat={() => {}}
        onOpenChange={() => {}}
      />,
    );
    expect(
      screen.queryByText("chat:experts.market.quickPromptsTitle"),
    ).toBeNull();
    expect(screen.queryByText("⚡ 天气查询")).toBeNull();
  });
});

describe("ExpertDetailDialog（专家团成员区）", () => {
  const teamItem = MARKET_EXPERTS.find(
    (e) => e.slug === "trading-agent-team",
  ) as ExpertMarketItem;
  const renderDialog = (item: ExpertMarketItem) =>
    render(
      <ExpertDetailDialog
        item={item}
        added={false}
        adding={false}
        onAdd={() => {}}
        onAddAndChat={() => {}}
        onOpenChange={() => {}}
      />,
    );

  it("team 条目渲染「团队成员」区（花名+头衔胶囊）与专家名旁「主理人」Badge", () => {
    renderDialog(teamItem);
    expect(screen.getByText("chat:experts.market.teamMembers")).toBeTruthy();
    for (const m of teamItem.members ?? []) {
      expect(screen.getByText(`${m.name} · ${m.profession}`)).toBeTruthy();
    }
    expect(screen.getByText("chat:experts.market.lead")).toBeTruthy();
  });

  it("expert 条目不渲染成员区与「主理人」Badge", () => {
    const expertItem = MARKET_EXPERTS.find(
      (e) => e.slug === "senior-developer",
    ) as ExpertMarketItem;
    renderDialog(expertItem);
    expect(screen.queryByText("chat:experts.market.teamMembers")).toBeNull();
    expect(screen.queryByText("chat:experts.market.lead")).toBeNull();
  });
});

describe("ExpertMarketView（分类 pill 与添加载荷）", () => {
  it("分类 pill 只渲染有条目的分类（空分类不出 tab，「全部」保留）", async () => {
    renderMarket();
    await waitFor(() =>
      expect(
        screen.getByText("chat:experts.market.allCategories"),
      ).toBeTruthy(),
    );
    const withItems = EXPERT_CATEGORIES.filter((c) =>
      MARKET_EXPERTS.some((e) => e.category === c.key),
    );
    const renderedPills = EXPERT_CATEGORIES.filter(
      (c) =>
        screen.queryByText(`chat:experts.categories.${c.labelKey}`) !== null,
    );
    // 等价断言：渲染的分类 pill 集合 = 有条目的分类集合
    expect(renderedPills).toEqual(withItems);
  });

  it("详情添加：create 载荷携带 profession/categoryId/quickPrompts/skillNames", async () => {
    renderMarket();
    // 点卡片主体开详情 → 「添加到我的专家」（名称同时出现在场景卡与网格
    // 卡，取最后一处=网格卡）
    const cardNames = screen.getAllByText("吴八哥");
    fireEvent.click(cardNames[cardNames.length - 1]);
    fireEvent.click(screen.getByText("chat:experts.market.addToMine"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(
          ([channel]) => channel === "assistant:create",
        ),
      ).toBeTruthy();
    });
    const createCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "assistant:create",
    );
    // 市场模板字段 + 新字段（profession=subtitle、categoryId=category、
    // quickPrompts/skillNames 直接透传；当前市场条目无 skillNames → undefined）
    expect(createCall?.[1]).toMatchObject({
      name: "吴八哥",
      sourceSlug: "senior-developer",
      profession: "高级开发工程师",
      categoryId: "02-Engineering",
      quickPrompts: [
        "帮我开发一个功能，我会描述需求，请你先给出实现计划再动手写代码。",
        "帮我搭建一个全栈项目（前端+后端+数据库），包含用户认证功能",
        "Review我的代码，找出潜在的性能问题和安全隐患",
      ],
      skillNames: undefined,
    });
  });

  it("详情添加 team：create 载荷含 expertType=team 与 members（三员 id）", async () => {
    renderMarket();
    // 切到专家团类型 → 点网格卡片主体开详情（名称同时出现在场景卡与网格
    // 卡，取最后一处=网格卡）→「添加到我的专家」
    fireEvent.click(screen.getByText("chat:experts.market.typeTeam"));
    const cardNames = screen.getAllByText("内容创作专家团");
    fireEvent.click(cardNames[cardNames.length - 1]);
    fireEvent.click(screen.getByText("chat:experts.market.addToMine"));
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.find(
          ([channel]) => channel === "assistant:create",
        ),
      ).toBeTruthy();
    });
    const createCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "assistant:create",
    );
    const params = createCall?.[1] as {
      expertType?: string;
      members?: { id: string }[];
    };
    expect(params.expertType).toBe("team");
    expect(params.members?.map((m) => m.id)).toEqual([
      "ai-content-creator-team-lead",
      "creative-strategist",
      "copywriter",
      "video-generator",
      "image-creator",
      "video-editor",
      "content-adapter",
    ]);
  });
});

describe("MyExpertsView ExpertCardMine（副标题优先级与头衔行）", () => {
  it("无 description 有 profession：副标题回退显示 profession，头衔行去重不重复且无 systemPrompt 截断", async () => {
    renderMine([makeAssistant({ id: 1, profession: "金牌销售教练" })]);
    await waitFor(() => expect(screen.getByText("我的专家")).toBeTruthy());
    // 头衔行已去重：profession 仅由副标题出现一次（不再名称下重复出头衔行）
    expect(screen.getAllByText("金牌销售教练")).toHaveLength(1);
    // 副标题回退语义：profession 命中时 systemPrompt 截断（"sys"）不出现
    expect(screen.queryByText("sys")).toBeNull();
  });

  it("description 优先于 profession，且 description 存在时头衔行保留", async () => {
    renderMine([
      makeAssistant({
        id: 2,
        description: "这是一个专业描述",
        profession: "头衔",
      }),
    ]);
    await waitFor(() => expect(screen.getByText("我的专家")).toBeTruthy());
    // 副标题显示 description（优先），头衔行显示 profession（两者可共存不重复）
    expect(screen.getByText("这是一个专业描述")).toBeTruthy();
    expect(screen.getAllByText("头衔")).toHaveLength(1);
  });

  it("无 description/profession：systemPrompt 60 字截断加省略号", async () => {
    renderMine([makeAssistant({ id: 3, systemPrompt: "长".repeat(80) })]);
    await waitFor(() =>
      expect(screen.getByText("长".repeat(60) + "…")).toBeTruthy(),
    );
  });

  it("团队记录卡片渲染「专家团」Badge，单专家卡片不渲染", async () => {
    renderMine([
      makeAssistant({ id: 4, name: "单专家卡", expertType: "agent" }),
      makeAssistant({
        id: 5,
        name: "团队专家卡",
        expertType: "team",
        members: [
          { id: "m1", name: "策划", profession: "选题", systemPrompt: "s" },
          { id: "m2", name: "写手", profession: "成稿", systemPrompt: "s" },
        ],
      }),
    ]);
    await waitFor(() => expect(screen.getByText("团队专家卡")).toBeTruthy());
    expect(screen.getByText("单专家卡")).toBeTruthy();
    // typeTeam 全局仅团队卡渲染一处；显式 expertType=agent 的单专家卡不渲染
    expect(screen.getAllByText("chat:experts.market.typeTeam")).toHaveLength(1);
  });
});
