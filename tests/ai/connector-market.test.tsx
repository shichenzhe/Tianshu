// @vitest-environment jsdom
/**
 * ConnectorMarketView 测试：渲染 24 卡片、搜索过滤、
 * 已添加卡片按钮为 Check 禁用、未添加点击 + 打开管理弹窗（编辑态带模板）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

afterEach(cleanup);

const state = { servers: [] as Array<Record<string, unknown>> };

vi.mock("react-i18next", () => ({
  // 视图搜索过滤走 i18n.t（描述文本），mock 需同形提供 i18n 实例
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { t: (key: string) => key },
  }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn(() => ({ data: state.servers })),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  default: { list: vi.fn(), sync: vi.fn(), openHub: vi.fn() },
}));

import ConnectorMarketView from "@/domains/ai/mcp/views/ConnectorMarketView";
import { MARKET_CONNECTORS } from "@/domains/ai/mcp/lib/market-connectors";

beforeEach(() => {
  state.servers = [];
});

describe("ConnectorMarketView", () => {
  it("渲染全部 24 张卡片", () => {
    render(<ConnectorMarketView />);
    for (const c of MARKET_CONNECTORS) {
      expect(screen.getByText(c.name)).toBeTruthy();
    }
  });

  it("搜索过滤：仅匹配项可见", () => {
    render(<ConnectorMarketView />);
    fireEvent.change(
      screen.getByPlaceholderText("ai:mcp.market.searchPlaceholder"),
      {
        target: { value: "飞书" },
      },
    );
    expect(screen.getByText("飞书")).toBeTruthy();
    expect(screen.queryByText("钉钉")).toBeNull();
  });

  it("已添加（DB name === id）按钮禁用且带 added 文案", () => {
    state.servers = [
      { id: 1, name: "feishu", transport: "stdio", enabled: true },
    ];
    render(<ConnectorMarketView />);
    const feishuBtn = screen.getByRole("button", {
      name: "ai:mcp.market.added 飞书",
    });
    expect(feishuBtn).toHaveProperty("disabled", true);
  });

  it("未添加点击 + 打开管理弹窗并进入编辑态（预填模板可见）", () => {
    render(<ConnectorMarketView />);
    fireEvent.click(
      screen.getByRole("button", { name: "ai:mcp.market.add 飞书" }),
    );
    const dialog = screen.getByRole("dialog");
    // 仓库未装 @testing-library/jest-dom，直读 textarea.value（同 mcp-manage-dialog.test.tsx）
    const editor = within(dialog).getByRole("textbox") as HTMLTextAreaElement;
    expect(editor).toBeTruthy();
    expect(editor.value).toContain("feishu");
  });
});
