// @vitest-environment jsdom
/**
 * McpManageDialog 测试：空态渲染与引导、配置按钮进编辑态、
 * 非法 JSON 保存不调 sync、合法 JSON 调 sync 并回列表态。
 * useQuery mock 为可控数据；McpServerApi 模块级 mock
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

afterEach(cleanup);

const state = {
  servers: [] as Array<Record<string, unknown>>,
  statuses: [] as Array<Record<string, unknown>>,
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: vi.fn(({ queryKey }) => ({
    data: queryKey[0] === "mcpServers" ? state.servers : state.statuses,
  })),
}));
vi.mock("@/domains/ai/chat/components/CodeBlock", () => ({
  getHighlighter: vi.fn(async () => null),
}));

// vi.mock 工厂被提升到文件顶部，普通 const 会 ReferenceError——经 vi.hoisted
// 预建 mock（同 tests/ai/skill-import-dialog.test.tsx 的 invokeMock 惯例）
const { syncMock, openHubMock } = vi.hoisted(() => ({
  syncMock: vi.fn(),
  openHubMock: vi.fn(),
}));
vi.mock("@/domains/ai/api/mcp.api", () => ({
  default: {
    list: vi.fn(),
    sync: syncMock,
    openHub: openHubMock,
    setEnabled: vi.fn(),
    reconnect: vi.fn(),
    delete: vi.fn(),
  },
}));

import McpManageDialog from "@/domains/ai/mcp/components/McpManageDialog";

beforeEach(() => {
  state.servers = [];
  state.statuses = [];
  vi.clearAllMocks();
});

function open() {
  render(<McpManageDialog open onOpenChange={vi.fn()} />);
}

describe("McpManageDialog", () => {
  it("空态：显示空文案与引导配置按钮，点击进入编辑态显示默认骨架", () => {
    open();
    expect(screen.getByText("ai:mcp.manage.empty")).toBeTruthy();
    // 空态下标题区与中央引导各有一个「配置」按钮，取第一个（标题区）
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    // 仓库未装 @testing-library/jest-dom，直读 textarea.value（同 json-config-editor.test.tsx）
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      '{\n  "mcpServers": {}\n}',
    );
  });

  it("列表态：已有服务器显示行（名称可见）", () => {
    state.servers = [
      {
        id: 1,
        name: "feishu",
        transport: "stdio",
        command: "npx",
        enabled: true,
      },
    ];
    open();
    expect(screen.getByText("feishu")).toBeTruthy();
  });

  it("非法 JSON：保存不调 sync 并 toast 错误", async () => {
    syncMock.mockResolvedValue({ created: 0, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    const ta = screen.getByRole("textbox");
    fireEvent.change(ta, { target: { value: "{ broken" } });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(syncMock).not.toHaveBeenCalled();
  });

  it("合法 JSON：调 sync、toast 成功并回列表态", async () => {
    syncMock.mockResolvedValue({ created: 1, updated: 0, deleted: 0 });
    open();
    const [configureBtn] = screen.getAllByRole("button", {
      name: "ai:mcp.manage.configure",
    });
    fireEvent.click(configureBtn);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: '{"mcpServers":{"a":{"command":"npx"}}}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "ai:mcp.manage.save" }));
    await waitFor(() =>
      expect(syncMock).toHaveBeenCalledWith({
        a: {
          transport: "stdio",
          command: "npx",
          args: undefined,
          env: undefined,
          url: undefined,
          headers: undefined,
        },
      }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    // 回列表态：编辑器消失、标题回到 manage.title
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  });
});
