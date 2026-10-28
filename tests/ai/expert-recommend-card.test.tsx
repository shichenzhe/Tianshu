// @vitest-environment jsdom
/**
 * ExpertRecommendCard（recommend_experts 工具块渲染的会话内专家推荐卡）：
 * 候选从 MARKET_EXPERTS 反查渲染名称与推荐理由，未知 slug 渲染原文
 * 占位（宁退不崩）；已添加判定经 ["assistants"] 缓存（ipc invoke mock）。
 * 「添加并启用」交互流：assistant:create 载荷（市场模板字段）→
 * session:setAssistant 绑定会话 → 收敛已添加；create 失败 toast 映射
 * 文案且按钮复位。setup 同 tests/ai/widget-renderer.test.tsx（i18n
 * mock + 手动 cleanup）。
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

import ExpertRecommendCard from "../../src-react/domains/ai/chat/components/ExpertRecommendCard";
import { invoke } from "@/lib/ipc";
import { toast } from "sonner";

vi.mock("@/lib/ipc", () => ({ invoke: vi.fn() }));

afterEach(cleanup);

// 兜底 QueryClient 为模块级共享（跨用例缓存 ["assistants"]）：用例间
// 显式重设 invoke 行为，数据时效交由 staleTime=0 的挂载重取修正
const invokeMock = invoke as unknown as Mock;
const toastError = toast.error as unknown as Mock;

beforeEach(() => {
  invokeMock.mockReset();
  toastError.mockClear();
});

describe("ExpertRecommendCard", () => {
  it("渲染候选卡与推荐理由", () => {
    render(
      <ExpertRecommendCard
        item={{
          toolCallId: "t1",
          reason: "翻译任务",
          slugs: ["sales-coach", "code-review-expert"],
          state: "done",
        }}
      />,
    );
    expect(screen.getByText("翻译任务")).toBeTruthy();
    expect(screen.getByText("单必成")).toBeTruthy();
    expect(screen.getByText("火眼眼")).toBeTruthy();
  });

  it("未知 slug 渲染占位条目（宁退不崩）", () => {
    render(
      <ExpertRecommendCard
        item={{ toolCallId: "t1", reason: "r", slugs: ["nope"], state: "done" }}
      />,
    );
    expect(screen.getByText("nope")).toBeTruthy();
  });

  it("添加并启用：市场模板建专家（sourceSlug/profession）并绑定当前会话，收敛已添加", async () => {
    const created = {
      id: 11,
      name: "单必成",
      systemPrompt: "s",
      builtin: false,
      sourceSlug: "sales-coach",
      createdAt: "",
      updatedAt: "",
    };
    // 状态路由：create 前我的专家为空，create 后落一条——挂载期与失效
    // 重取两次 assistant:list 各取当下值，按钮随之收敛
    let mine: unknown[] = [];
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === "assistant:list") {
          return [...mine];
        }
        if (channel === "assistant:create") {
          void args;
          mine = [created];
          return created;
        }
        return undefined;
      },
    );
    render(
      <ExpertRecommendCard
        item={{
          toolCallId: "t1",
          reason: "r",
          slugs: ["sales-coach"],
          state: "done",
        }}
        sessionId={42}
      />,
    );
    // 兜底 client 跨用例共享缓存：挂载首帧可能仍是上一用例的已添加态，
    // 先等 assistant:list 重取落地（mine=[] → 未添加）再点击
    await waitFor(() =>
      expect(
        screen.getByText("chat:experts.recommend.addAndEnable"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("chat:experts.recommend.addAndEnable"));
    await waitFor(() =>
      expect(screen.getByText("chat:experts.recommend.added")).toBeTruthy(),
    );
    // create 载荷：市场模板字段（name/systemPrompt/sourceSlug +
    // profession=subtitle、categoryId=category——与市场添加路径同口径）
    const createCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "assistant:create",
    );
    expect(createCall?.[1]).toMatchObject({
      name: "单必成",
      sourceSlug: "sales-coach",
      profession: "销售教练",
      categoryId: "07-SalesCommerce",
    });
    // 绑定当前会话：(sessionId, created.id) 透传给 session:setAssistant
    const setCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "session:setAssistant",
    );
    expect(setCall?.slice(1)).toEqual([42, 11]);
  });

  it("添加专家团条目：create 载荷带 expertType=team 与三员 members（与市场同 toCreateParams 口径）", async () => {
    const created = {
      id: 12,
      name: "交易分析团队",
      systemPrompt: "s",
      builtin: false,
      sourceSlug: "trading-agent-team",
      createdAt: "",
      updatedAt: "",
    };
    let mine: unknown[] = [];
    invokeMock.mockImplementation(
      async (channel: string, ...args: unknown[]) => {
        if (channel === "assistant:list") {
          return [...mine];
        }
        if (channel === "assistant:create") {
          void args;
          mine = [created];
          return created;
        }
        return undefined;
      },
    );
    render(
      <ExpertRecommendCard
        item={{
          toolCallId: "t2",
          reason: "r",
          slugs: ["trading-agent-team"],
          state: "done",
        }}
        sessionId={42}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("chat:experts.recommend.addAndEnable"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("chat:experts.recommend.addAndEnable"));
    await waitFor(() =>
      expect(screen.getByText("chat:experts.recommend.added")).toBeTruthy(),
    );
    const createCall = invokeMock.mock.calls.find(
      ([channel]) => channel === "assistant:create",
    );
    // team 载荷：expertType=team + 十三员 members（成员完整透传，调度目标齐备）
    const params = createCall?.[1] as {
      expertType?: string;
      members?: { id: string }[];
    };
    expect(params.expertType).toBe("team");
    expect(params.members).toHaveLength(13);
    expect(params.members?.[0]?.id).toBe("trading-team-lead");
  });

  it("create 失败：toast 以映射文案报错，按钮复位可再点（无未处理 rejection）", async () => {
    invokeMock.mockImplementation(async (channel: string) => {
      if (channel === "assistant:list") {
        return [];
      }
      if (channel === "assistant:create") {
        throw new Error("X");
      }
      return undefined;
    });
    render(
      <ExpertRecommendCard
        item={{
          toolCallId: "t1",
          reason: "r",
          slugs: ["sales-coach"],
          state: "done",
        }}
        sessionId={42}
      />,
    );
    // 同上：等重取落地（[] → 未添加）再点击
    await waitFor(() =>
      expect(
        screen.getByText("chat:experts.recommend.addAndEnable"),
      ).toBeTruthy(),
    );
    fireEvent.click(screen.getByText("chat:experts.recommend.addAndEnable"));
    // "X" 不在错误码表内 → mapIpcError 原样透传
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("X"));
    await waitFor(() => {
      const button = screen.getByText(
        "chat:experts.recommend.addAndEnable",
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });
});
