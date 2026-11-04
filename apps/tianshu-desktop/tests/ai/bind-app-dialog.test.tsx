// @vitest-environment jsdom
/**
 * BindAppDialog（会话绑定应用弹窗，切片 C P1）冒烟：应用单选 + 解绑项，
 * 保存走 SessionApi.setApp（选中 id / null）并失效 ["sessions"]。
 * setup 同 table-view-card.test.tsx（i18n mock + 手动 cleanup）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

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

const invalidateMock = vi.fn(async () => {});

vi.mock("@/domains/ai/api/app.api", () => ({
  default: {
    list: vi.fn(async () => [
      {
        id: 11,
        name: "记账应用",
        description: undefined,
        graphIds: [1, 2],
        createdAt: "",
        updatedAt: "",
      },
      {
        id: 12,
        name: "日记应用",
        description: undefined,
        graphIds: [],
        createdAt: "",
        updatedAt: "",
      },
    ]),
  },
}));

vi.mock("@/domains/ai/api/session.api", () => ({
  default: { setApp: vi.fn(async () => undefined) },
}));

import BindAppDialog from "../../src-react/domains/ai/apps/components/BindAppDialog";
import SessionApi from "@/domains/ai/api/session.api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(cleanup);

const setAppMock = SessionApi.setApp as unknown as Mock;

/** 独立 Provider 包裹（fallback client 先例 ExpertRecommendCard；缓存
 *  失效断言经 client.invalidateQueries spy 而非 mock 整库） */
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
vi.spyOn(client, "invalidateQueries").mockImplementation(
  invalidateMock as never,
);
const renderDialog = (props: { sessionId: number; currentAppId?: number }) =>
  render(
    <QueryClientProvider client={client}>
      <BindAppDialog open onOpenChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );

describe("BindAppDialog", () => {
  it("渲染应用清单（含工作流计数）与解绑项", async () => {
    renderDialog({ sessionId: 42 });
    expect(await screen.findByText("记账应用")).toBeTruthy();
    expect(screen.getByText("日记应用")).toBeTruthy();
    expect(screen.getByText("ai:app.unbind")).toBeTruthy();
  });

  it("选中应用保存 → setApp(sessionId, id) 并失效会话缓存", async () => {
    renderDialog({ sessionId: 42 });
    fireEvent.click(await screen.findByText("日记应用"));
    fireEvent.click(screen.getByText("common:confirm"));
    await vi.waitFor(() => expect(setAppMock).toHaveBeenCalledWith(42, 12));
    expect(invalidateMock).toHaveBeenCalledWith({
      queryKey: ["sessions"],
    });
  });

  it("解绑项保存 → setApp(sessionId, null)", async () => {
    renderDialog({ sessionId: 42, currentAppId: 11 });
    fireEvent.click(await screen.findByText("ai:app.unbind"));
    fireEvent.click(screen.getByText("common:confirm"));
    await vi.waitFor(() => expect(setAppMock).toHaveBeenCalledWith(42, null));
  });
});
